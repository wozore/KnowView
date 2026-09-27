'use strict';

/**
 * identity-adapters.js —— 身份核验层专用官方源/身份建议适配器工厂
 *
 * 核验层契约（model-identity-verification）与研究层契约（catalog-adapters 的
 * discoverOfficialSources/acquireOfficialSources）形状不同，禁止互转复用：
 *   - discoverOfficialSources: { name, entity_type, official_urls } → sources 数组；
 *   - acquireOfficialSources: sources → [{ url, body_text }]；
 *   - suggestIdentity: { candidate, pages, instructions } → { ok, value }。
 * 已登记官方 URL 与搜索结果都保留为来源；无可用来源时搜索失败抛错，正文获取失败也由核验层归类并 fail-closed。
 * 身份建议走 requestStructuredJson（AI 只建议，最终归属由核验层程序重算）。
 */

const { searchWebWithFallback, plannedWebSearchRequests } = require('../../shared/web-search');
const { extractTavily } = require('../../shared/tavily-client');
const { canonicalizeUrl } = require('../../shared/web-source-contract');
const { fetchOfficialSources } = require('./official-source-fetch');
const { requestStructuredJson } = require('../../shared/llm-gateway');
const { resolveProvider, apiKeyForProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { createCostLedger, loadCatalogSnapshot } = require('../core');
const { revisionOf } = require('../core/catalog-revision');
const { loadSeriesPolicy } = require('../series');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { validateIdentitySuggestionValue } = require('./model-identity-verification');
const { identityAppearsInBody, candidateIdentityKeysOf } = require('./identity-evidence-contract');
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
    searchFallbackProvider: options.searchFallbackProvider,
    searchEngine: options.searchEngine,
    extractProvider: options.extractProvider,
    extractFallbackProvider: options.extractFallbackProvider,
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
  const includeDomains = officialDomainsOf(declaredUrls);
  const provider = options.searchProvider || 'zhipu_web_search';
  const fallbackProvider = options.searchFallbackProvider ?? 'tavily';
  const primaryRequests = plannedWebSearchRequests({ provider, includeDomains });
  if (primaryRequests > 1 && input.ledger?.reserve) {
    const reservation = input.ledger.reserve('search_queries', primaryRequests - 1);
    if (!reservation.ok) {
      if (!declaredUrls.length) throw new Error('COST_BUDGET_EXHAUSTED: 多域身份搜索预算不足');
      return declaredUrls.map(url => ({ url, title: `${name} Official`, source_kind: 'official' }));
    }
  }
  const result = await searchWebWithFallback({
    provider,
    fallbackProvider,
    fallbackLedger: input.ledger,
    providerApiKeys: { zhipu_web_search: options.webSearchApiKey, tavily: options.searchApiKey },
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
  if (!result.ok && !declaredUrls.length) throw new Error(`${result.code || 'WEB_SEARCH_FAILED'}: ${result.error || '官方源发现失败'}`);
  if (!result.ok && declaredUrls.length) return declaredUrls.map(url => ({ url, title: `${name} Official`, source_kind: 'official' }));
  if (!result.sources.length && result.fallback_error && !declaredUrls.length) {
    throw new Error(`${result.fallback_error.code || 'WEB_SEARCH_FALLBACK_FAILED'}: ${result.fallback_error.error || '官方源发现失败'}`);
  }
  const declared = declaredUrls.map(url => ({ url, title: `${name} Official`, source_kind: 'official' }));
  const discovered = result.sources.map(source => ({ ...source, source_kind: 'official' }));
  const seen = new Set();
  return [...declared, ...discovered].filter(source => !seen.has(source.url) && seen.add(source.url));
}

/** 官方正文获取（核验层契约）：sources → [{url, body_text}]；失败抛错，空正文过滤。 */
async function acquireOfficialSources(sources, options = {}) {
  const normalized = (Array.isArray(sources) ? sources : [])
    .map(source => ({ ...source, url: canonicalizeUrl(source?.url) }))
    .filter(source => source.url);
  if (!normalized.length) return [];
  const direct = await fetchOfficialSources(normalized, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const expectedIdentityKeys = Array.isArray(options.candidateIdentityKeys)
    ? options.candidateIdentityKeys
    : candidateIdentityKeysOf({ identity_aliases: options.identityAliases }, options.candidateName);
  const relevant = page => !expectedIdentityKeys.length || expectedIdentityKeys.some(key => identityAppearsInBody(key, page.body_text));
  const directByUrl = new Map(direct.pages.map(page => [page.url, page]));
  const pending = normalized.filter(source => !directByUrl.has(source.url) || !relevant(directByUrl.get(source.url)));
  if (!pending.length) return direct.pages;
  if ((options.extractFallbackProvider ?? 'tavily') !== 'tavily') {
    if (direct.pages.length) return direct.pages;
    throw new Error('OFFICIAL_SOURCE_FETCH_FAILED: 官方页面直连未取得正文，且未配置正文提取备用 provider');
  }
  // extract 相关性 query 用来源标题拼接（discover 检索词为 "<name> official"，标题携带候选名上下文）。
  const query = [options.candidateName, ...(options.identityAliases || []), ...pending.map(source => source?.title)].filter(Boolean).join(' ');
  const result = await extractTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    urls: pending.map(source => source.url),
    query,
    extractDepth: options.extractDepth || 'advanced',
    chunksPerSource: options.chunksPerSource,
  });
  if (!result.ok) {
    if (direct.pages.length) return direct.pages;
    throw new Error(`${result.code || 'TAVILY_EXTRACT_FAILED'}: ${result.error || '官方正文获取失败'}`);
  }
  const extracted = result.contents
    .map(item => ({ url: item.url, body_text: String(item.content || '').trim() }))
    .filter(page => page.body_text);
  for (const page of extracted) {
    const current = directByUrl.get(page.url);
    if (!current || !relevant(current) || relevant(page)) directByUrl.set(page.url, page);
  }
  return [...directByUrl.values()];
}

/** 官方源适配器工厂：{ discoverOfficialSources, acquireOfficialSources }（核验层契约形状）。 */
function createIdentityVerificationAdapters(options = {}) {
  return {
    discoverOfficialSources: input => discoverOfficialSources(input, options),
    acquireOfficialSources: (sources, criteria = {}) => acquireOfficialSources(sources, { ...options, ...criteria }),
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
        candidate: {
          name: candidate?.name || '',
          entity_type: candidate?.entity_type || '',
          ...(candidate?.vendor_hint ? { vendor_hint: candidate.vendor_hint } : {}),
        },
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
  // responses 预算覆盖身份建议重试和最多两轮系列成员建议；搜索预算由候选官方域数和备用 provider 计算。
  const budgetSize = Math.max(1, options.identityBudgetSize || 8);
  return {
    snapshot,
    policy,
    policyRevision: options.policyRevision || revisionOf(policy),
    bridgeRevision: options.bridgeRevision ?? bridge.revision,
    // 缺省读 receipts 文件启用 24h 五条件复用（零网络零 AI）；测试/调用方注入优先
    receipts: options.identityReceipts ?? readIdentityReceipts(),
    ledger: options.identityLedger || createCostLedger({
      search_queries: options.identitySearchBudget ?? budgetSize * 2,
      pages: budgetSize * 3,
      responses_calls: budgetSize * 4,
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
