'use strict';

/**
 * identity-adapters.js —— 身份核验层专用官方源/身份建议适配器工厂
 *
 * 核验层契约（model-identity-verification）与研究层契约（catalog-adapters 的
 * discoverOfficialSources/acquireOfficialSources）形状不同，禁止互转复用：
 *   - discoverOfficialSources: { name, entity_type, official_urls } → sources 数组；
 *   - acquireOfficialSources: sources → [{ url, body_text }]；
 *   - suggestIdentity: { candidate, pages, instructions } → { ok, value }。
 * 官方源发现/正文获取失败一律【抛错】，由核验层 catch 归类为"官方源发现失败"，
 * 绝不把限流/网络错误伪装成"无官方源命中"（fail-closed 红线）。
 * 身份建议走 requestStructuredJson（AI 只建议，最终归属由核验层程序重算）。
 */

const { searchWeb } = require('../../shared/web-search');
const { extractTavily } = require('../../shared/tavily-client');
const { canonicalizeUrl } = require('../../shared/web-source-contract');
const { requestStructuredJson } = require('../../shared/llm-gateway');
const { resolveProvider, apiKeyForProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { createCostLedger, loadCatalogSnapshot } = require('../core');
const { revisionOf } = require('../core/catalog-revision');
const { loadSeriesPolicy } = require('../series');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { validateIdentitySuggestionValue } = require('./model-identity-verification');
const { readIdentityReceipts } = require('./identity-receipts');

/** resolution/bundle 转发只透传白名单键，防止上层无关 options 误入真实凭据面。 */
function identityAdapterOptionsOf(options = {}) {
  return {
    searchApiKey: options.searchApiKey,
    webSearchApiKey: options.webSearchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    maxSearchResults: options.maxSearchResults,
    searchDepth: options.searchDepth,
    searchProvider: options.searchProvider,
    searchEngine: options.searchEngine,
    extractProvider: options.extractProvider,
    extractDepth: options.extractDepth,
    chunksPerSource: options.chunksPerSource,
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
  };
}

/** official_urls → 去重主机名提示列表（空列表时由调用方不传 include_domains）。 */
function officialDomainsOf(urls) {
  const hosts = [];
  for (const url of urls || []) {
    try { hosts.push(new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* 非法 URL 忽略 */ }
  }
  return [...new Set(hosts.filter(Boolean))];
}

/** 官方源发现（核验层契约）：失败抛错，成功返回 sources 数组。 */
async function discoverOfficialSources(input, options = {}) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('IDENTITY_DISCOVER_NAME_REQUIRED: 候选名为空');
  const declaredUrls = (Array.isArray(input.official_urls) ? input.official_urls : [])
    .map(url => canonicalizeUrl(url)).filter(Boolean);
  // 卡片/登记表已声明官方 URL 时直接采信为发现结果：域内泛搜会让 AI 证据漂移到
  // 无目标内容的文档地图页（如 docs/model-map），导致成员发现与核验间歇性失败；
  // 声明页本身已经过登记表人工核验，是更强的信任根。
  if (declaredUrls.length) {
    return declaredUrls.map(url => ({ url, title: `${name} Official`, source_kind: 'official' }));
  }
  const includeDomains = officialDomainsOf(input.official_urls);
  const result = await searchWeb({
    provider: options.searchProvider || 'tavily',
    apiKey: options.searchProvider === 'zhipu_web_search' ? options.webSearchApiKey : options.searchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: `${name} official`,
    ...(includeDomains.length ? { includeDomains } : {}),
    searchDepth: options.searchDepth || 'advanced',
    maxResults: options.maxSearchResults ?? 5,
    providerOptions: { engine: options.searchEngine || 'search_std' },
  });
  if (!result.ok) throw new Error(`${result.code || 'TAVILY_SEARCH_FAILED'}: ${result.error || '官方源发现失败'}`);
  return result.sources;
}

/** 官方正文获取（核验层契约）：sources → [{url, body_text}]；失败抛错，空正文过滤。 */
async function acquireOfficialSources(sources, options = {}) {
  const normalized = (Array.isArray(sources) ? sources : [])
    .map(source => ({ ...source, url: canonicalizeUrl(source?.url) }))
    .filter(source => source.url);
  if (!normalized.length) return [];
  // extract 相关性 query 用来源标题拼接（discover 检索词为 "<name> official"，标题携带候选名上下文）。
  const query = normalized.map(source => source?.title).filter(Boolean).join(' ');
  const result = await extractTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    urls: normalized.map(source => source.url),
    query,
    extractDepth: options.extractDepth || 'advanced',
    chunksPerSource: options.chunksPerSource,
  });
  if (!result.ok) {
    // 当 Tavily extract 失败（如配额用尽）时，对官方源直连 fetch 抓取纯文本作为高可用降级
    const contents = [];
    const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (fetchFn) {
      for (const source of normalized) {
        try {
          const res = await fetchFn(source.url, { signal: AbortSignal.timeout(options.timeoutMs || 15000) });
          if (res.ok) {
            const html = await res.text();
            const text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                             .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
            if (text) contents.push({ url: source.url, body_text: text.slice(0, 20000) });
          }
        } catch {}
      }
    }
    if (contents.length) return contents;
    throw new Error(`${result.code || 'TAVILY_EXTRACT_FAILED'}: ${result.error || '官方正文获取失败'}`);
  }
  return result.contents
    .map(item => ({ url: item.url, body_text: String(item.content || '').trim() }))
    .filter(page => page.body_text);
}

/** 官方源适配器工厂：{ discoverOfficialSources, acquireOfficialSources }（核验层契约形状）。 */
function createIdentityVerificationAdapters(options = {}) {
  return {
    discoverOfficialSources: input => discoverOfficialSources(input, options),
    acquireOfficialSources: sources => acquireOfficialSources(sources, options),
  };
}

/**
 * 身份建议适配器工厂：({candidate, pages, instructions}) → {ok, value}。
 * fail-closed：缺 provider/key、调用失败、输出非法 → {ok:false}（核验层归类 IDENTITY_AI_UNAVAILABLE）。
 */
function createIdentitySuggestAdapter(options = {}) {
  return async function suggestIdentity({ candidate, pages, instructions } = {}) {
    const resolved = resolveProvider(options.provider || DEFAULT_PROVIDER_NAME);
    if (!resolved.ok) return { ok: false, code: resolved.code || 'AI_PROVIDER_UNSUPPORTED', error: resolved.error };
    const apiKey = apiKeyForProvider(resolved.provider, options.apiKey);
    if (!apiKey) {
      return { ok: false, code: `${resolved.provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${resolved.provider.apiKeyEnv}` };
    }
    const result = await requestStructuredJson({
      kind: 'identity_suggest',
      instructions,
      input: JSON.stringify({
        candidate: { name: candidate?.name || '', entity_type: candidate?.entity_type || '' },
        pages: (Array.isArray(pages) ? pages : []).map(page => ({ url: page?.url, body_text: String(page?.body_text || '').slice(0, 4000) })),
      }),
      maxOutputTokens: 2000,
      // 双层记账：context.ledger 管每卡核验预算上限；此 ledger 只管 gateway 单次调用的 fail-closed 预占。
      ledger: createCostLedger({ responses_calls: 1 }),
      validate: validateIdentitySuggestionValue,
    }, {
      model: options.model || resolved.provider.defaultModel,
      apiKey,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value };
  };
}

/** 系列成员建议 instructions：只从官方正文提取成员名，AI 不做收录裁决（核验层程序重算）。 */
function buildSeriesMembersInstructions() {
  return '你只负责从官方系列页正文中提取该模型系列下官方列出的可调用型号成员名。硬性规则：' +
    '1.只提取正文明确列出的具体可调用型号名（如 GPT-5.6 Sol、GPT-5.6 Terra），禁止编造、禁止把系列名自身、档位形容词或非型号词当成员。' +
    '2.输出完整名（含系列前缀），多词名不拆散。' +
    '3.正文没有列出任何具体成员时输出空数组 members: []。' +
    '输出 JSON：{"members":[{"name":string}]}，禁止额外字段。';
}

/** 校验系列成员建议结构：{ members: [{name}] }。 */
function validateSeriesMembersValue(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.members)
    && value.members.every(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim());
}

/**
 * 系列成员建议适配器工厂：({verdict, pages}) → {ok, value:{members:[{name}]}}。
 * 与 createIdentitySuggestAdapter 同一 fail-closed 语义：缺 provider/key、调用失败、输出非法 → {ok:false}。
 */
function createSeriesMembersSuggestAdapter(options = {}) {
  return async function suggestSeriesMembers({ verdict, pages } = {}) {
    const resolved = resolveProvider(options.provider || DEFAULT_PROVIDER_NAME);
    if (!resolved.ok) return { ok: false, code: resolved.code || 'AI_PROVIDER_UNSUPPORTED', error: resolved.error };
    const apiKey = apiKeyForProvider(resolved.provider, options.apiKey);
    if (!apiKey) {
      return { ok: false, code: `${resolved.provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${resolved.provider.apiKeyEnv}` };
    }
    const result = await requestStructuredJson({
      kind: 'series_members_suggest',
      instructions: buildSeriesMembersInstructions(),
      input: JSON.stringify({
        series: { model_key: verdict?.model_key || '', series_title: verdict?.series_title || '', family: verdict?.family || '' },
        pages: (Array.isArray(pages) ? pages : []).map(page => ({ url: page?.url, body_text: String(page?.body_text || '').slice(0, 4000) })),
      }),
      maxOutputTokens: 800,
      // 双层记账：context.ledger 管每批核验预算上限；此 ledger 只管 gateway 单次调用的 fail-closed 预占。
      ledger: createCostLedger({ responses_calls: 1 }),
      validate: validateSeriesMembersValue,
    }, {
      model: options.model || resolved.provider.defaultModel,
      apiKey,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value };
  };
}

/** 工具链路核验上下文（全部可注入；缺省读真实快照/政策/桥接/pending）。 */
function identityContextOf(options) {
  const snapshot = options.identitySnapshotOf ? options.identitySnapshotOf() : loadCatalogSnapshot().snapshot;
  const policy = options.identityPolicy || loadSeriesPolicy();
  const bridge = readModelIdentityBridge();
  // 预算按"每张模型卡至多 2 次搜索/取页（身份核验 + 系列成员发现各 1）与 2 次 AI"配置，
  // 三类同步放大；旧实现 search_queries 落默认值 3，整批共享导致批量核验必然 IDENTITY_BUDGET_EXHAUSTED。
  const budgetSize = Math.max(1, options.identityBudgetSize || 8);
  return {
    snapshot,
    policy,
    policyRevision: options.policyRevision || revisionOf(policy),
    bridgeRevision: options.bridgeRevision ?? bridge.revision,
    // 缺省读 receipts 文件启用 24h 五条件复用（零网络零 AI）；测试/调用方注入优先
    receipts: options.identityReceipts ?? readIdentityReceipts(),
    ledger: options.identityLedger || createCostLedger({
      search_queries: budgetSize * 2,
      pages: budgetSize * 2,
      responses_calls: budgetSize * 2,
    }),
    suggestIdentity: options.suggestIdentity || createIdentitySuggestAdapter(identityAdapterOptionsOf(options)),
    suggestSeriesMembers: options.suggestSeriesMembers || createSeriesMembersSuggestAdapter(identityAdapterOptionsOf(options)),
    normalizeVendorKey: options.normalizeVendorKey,
  };
}

module.exports = {
  identityAdapterOptionsOf,
  identityContextOf,
  createIdentityVerificationAdapters,
  createIdentitySuggestAdapter,
  buildSeriesMembersInstructions,
  validateSeriesMembersValue,
  createSeriesMembersSuggestAdapter,
};
