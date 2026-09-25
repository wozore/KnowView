'use strict';

const { getProvider, resolveProvider, apiKeyForProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { canonicalizeUrl } = require('../../shared/web-source-contract');
const { searchWebWithFallback, plannedWebSearchRequests, probeWebSearch } = require('../../shared/web-search');
const { extractTavily } = require('../../shared/tavily-client');
const { LOCAL_API_BASE } = require('../../shared/llm-endpoints');
const { registrableHostOf, synthesizeLayerFields } = require('../core');
const { requestStructuredJson } = require('../../shared/llm-gateway');
const { fetchOfficialSources } = require('./official-source-fetch');
const { identityAppearsInBody } = require('./model-identity-verification');

function discoveryKeywords(predicates = []) {
  const keywords = [];
  if (predicates.some(predicate => ['api_available', 'access_conditions'].includes(predicate))) keywords.push('developer API OpenAPI API documentation authentication access availability');
  if (predicates.some(predicate => ['price_rate', 'pricing_model', 'billing_period'].includes(predicate))) keywords.push('official pricing credits cost billing price');
  if (predicates.some(predicate => ['release_date', 'last_updated_date', 'availability_status'].includes(predicate))) keywords.push('official release notes announcement changelog');
  if (predicates.some(predicate => ['max_duration', 'output_resolution', 'audio_capability', 'supported_languages', 'capability', 'limitation'].includes(predicate))) keywords.push('official model guide specifications limits duration resolution audio languages');
  if (predicates.some(predicate => predicate.startsWith('vendor_'))) keywords.push('official company product platform about');
  return keywords.join(' ');
}

function officialDomainsOf(plan, domainScope = 'seed') {
  const urls = [plan?.seed?.official_url, ...(plan?.seed?.discovery_sources || []).map(source => source?.url)].map(canonicalizeUrl).filter(Boolean);
  const hosts = [...new Set(urls.map(url => new URL(url).hostname.toLowerCase().replace(/^www\./, '')))];
  // domain_scope='registrant'：扩域轮，把每个精确子域放宽到同厂商注册域根
  //（platform.openai.com → +openai.com），让厂商主站公告/帮助中心进入搜索范围。
  if (domainScope !== 'registrant') return hosts;
  const widened = new Set(hosts);
  for (const host of hosts) {
    const root = registrableHostOf(host);
    if (root) widened.add(root);
  }
  return [...widened];
}

function buildOfficialDiscoveryQuery({ plan, scope, missing_predicates: missingPredicates = [] }) {
  const hints = [plan.seed.official_url, ...(plan.seed.discovery_sources || []).map(source => source?.url)].filter(Boolean).join(' ');
  return [
    plan.seed.name,
    plan.seed.vendor_name,
    hints,
    discoveryKeywords(missingPredicates),
    `official ${scope.kind}`,
  ].filter(Boolean).join(' ');
}

function explicitOfficialSourcesOf(plan, scope) {
  // 与 research 信任根同口径：official_url + 授权 kind（official_hint/identity_verified）全部进入，
  // 已核验的官方 X 等多来源即使 Tavily 无结果也可直接抓取正文。
  const urls = [
    plan?.seed?.official_url,
    ...(plan?.seed?.discovery_sources || [])
      .filter(source => source?.url && ['official_hint', 'identity_verified', 'verified_official'].includes(source?.kind))
      .map(source => source.url),
  ].map(canonicalizeUrl).filter(Boolean);
  return [...new Set(urls)].map(url => ({
    url,
    title: url,
    excerpt: '',
    source_kind: 'official_hint',
    source_role: 'seed_official_hint',
    discovered_for: sourceScopeOf(scope),
  }));
}

function sourceScopeOf(scope) {
  return `${scope.kind}:${scope.subject?.key || ''}`;
}

async function discoverOfficialSources(input, options = {}) {
  const declaredSources = explicitOfficialSourcesOf(input.plan, input.scope);
  const provider = options.searchProvider || 'zhipu_web_search';
  const fallbackProvider = options.searchFallbackProvider ?? 'tavily';
  const includeDomains = officialDomainsOf(input.plan, input.domain_scope);
  const plannedRequests = plannedWebSearchRequests({ provider, includeDomains });
  if (plannedRequests > 1 && input.ledger?.reserve) {
    const reservation = input.ledger.reserve('search_queries', plannedRequests - 1);
    if (!reservation.ok) return { ok: false, code: 'COST_BUDGET_EXHAUSTED', error: 'search_queries 成本预算不足以覆盖多域搜索' };
  }
  const result = await searchWebWithFallback({
    provider,
    fallbackProvider,
    fallbackLedger: input.ledger,
    providerApiKeys: { zhipu_web_search: options.webSearchApiKey, tavily: options.searchApiKey },
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: buildOfficialDiscoveryQuery(input),
    includeDomains,
    searchDepth: options.searchDepth || 'advanced',
    maxResults: options.maxSearchResults ?? 5,
    providerOptions: { engine: options.searchEngine || 'search_std' },
    maxRequests: plannedRequests,
  });
  if (!result.ok) {
    // Tavily 失败（如配额用尽）时降级：以 seed 声明的官方提示页为信任根直接返回。
    // 声明页经登记表人工核验，是比泛搜更强的信任根；无声明页时维持 fail 原样返回。
    if (declaredSources.length) {
      return { ok: true, sources: declaredSources, usage: null, fallback_error: { code: result.code || 'WEB_SEARCH_FAILED', error: result.error || '官方来源搜索失败' } };
    }
    return result;
  }
  const discoveredSources = result.sources.map(source => ({
    ...source,
    source_kind: 'official',
    discovered_for: sourceScopeOf(input.scope),
  }));
  return {
    ok: true,
    sources: [...declaredSources, ...discoveredSources],
    usage: result.usage,
    ...(result.fallback_error ? { fallback_error: result.fallback_error } : {}),
  };
}

function queryForScope(input) {
  return [
    input.plan.seed.name,
    input.plan.seed.vendor_name,
    discoveryKeywords(input.scope.predicates),
    input.scope.predicates.join(' '),
  ].filter(Boolean).join(' ');
}

async function acquireOfficialSources(input, options = {}) {
  const sources = (input.sources || []).map(source => ({ ...source, url: canonicalizeUrl(source.url) })).filter(source => source.url);
  if (!sources.length) return { ok: true, contents: [], failed: [] };
  const detailModel = input.scope?.kind === 'detail' && input.plan?.seed?.detail_kind === 'api_model';
  const seed = input.plan?.seed || {};
  const modelIdentity = String(seed.model_key || '').startsWith(`${seed.vendor_key || ''}-`)
    ? String(seed.model_key).slice(String(seed.vendor_key).length + 1)
    : '';
  const relevant = content => !detailModel || [seed.name, seed.identity_key, modelIdentity]
    .filter(Boolean).some(identity => identityAppearsInBody(identity, content));
  const direct = await fetchOfficialSources(sources, {
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
  });
  const directContents = direct.pages.filter(page => relevant(page.body_text))
    .map(page => ({ url: page.url, content: page.body_text, content_origin: 'direct_fetch' }));
  const relevantDirectUrls = new Set(directContents.map(page => page.url));
  const pending = sources.filter(source => !relevantDirectUrls.has(source.url));
  if (!pending.length) return { ok: true, contents: directContents, failed: direct.failed, usage: { requests: 0 } };
  if ((options.extractFallbackProvider ?? 'tavily') !== 'tavily') {
    return directContents.length
      ? { ok: true, contents: directContents, failed: direct.failed, usage: { requests: 0 } }
      : { ok: false, code: 'OFFICIAL_SOURCE_FETCH_FAILED', error: '官方正文直连失败且未配置备用提取 provider', failed: direct.failed };
  }
  const result = await extractTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    urls: pending.map(source => source.url),
    query: queryForScope(input),
    extractDepth: options.extractDepth || 'advanced',
    format: options.extractFormat || 'markdown',
    chunksPerSource: options.chunksPerSource ?? 5,
  });
  if (!result.ok) {
    if (directContents.length) {
      return {
        ok: true,
        contents: directContents,
        failed: [...direct.failed, ...pending.map(source => ({ url: source.url, error: result.code || 'TAVILY_EXTRACT_FAILED' }))],
        usage: { requests: 0 },
        fallback_error: { provider: 'tavily', code: result.code || 'TAVILY_EXTRACT_FAILED' },
      };
    }
    return result;
  }
  return {
    ok: true,
    contents: [...directContents, ...result.contents
      .filter(item => relevant(item.content || ''))
      .map(item => ({ ...item, content_origin: 'tavily_extract' }))],
    failed: [
      ...direct.failed,
      ...(result.failed || []),
      ...result.contents.filter(item => !relevant(item.content || '')).map(item => ({ url: item.url, error: 'TARGET_NAME_NOT_IN_BODY' })),
    ],
    usage: result.usage,
  };
}

async function probeCatalogCapabilities(options = {}) {
  const resolved = resolveProvider(options.provider || DEFAULT_PROVIDER_NAME);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  const extractionKey = apiKeyForProvider(provider, options.apiKey);
  if (!extractionKey) return { ok: false, code: `${provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${provider.apiKeyEnv}` };
  const retrieval = await probeWebSearch({
    provider: options.searchProvider || 'zhipu_web_search',
    fallbackProvider: options.searchFallbackProvider ?? 'tavily',
    providerApiKeys: { zhipu_web_search: options.webSearchApiKey, tavily: options.searchApiKey },
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    providerOptions: { engine: options.searchEngine || 'search_std' },
  });
  if (!retrieval.ok) return retrieval;
  return {
    ok: true,
    search_provider: options.searchProvider || 'zhipu_web_search',
    extract_provider: options.extractProvider || 'direct_fetch',
    search_fallback_provider: options.searchFallbackProvider ?? 'tavily',
    extract_fallback_provider: options.extractFallbackProvider ?? 'tavily',
    search_engine: options.searchEngine || 'search_std',
    extraction_provider: provider.name,
    protocol: provider.protocol,
    model: options.model || provider.defaultModel,
    access_mode: options.accessMode || null,
    source_count: retrieval.source_count,
    ...(retrieval.fallback_used ? { fallback_used: true, fallback_from: retrieval.fallback_from } : {}),
    ...(retrieval.fallback_error ? { fallback_error: retrieval.fallback_error } : {}),
  };
}

function createCatalogAiAdapters(options = {}) {
  return {
    discover: input => discoverOfficialSources(input, options),
    acquire: input => acquireOfficialSources(input, options),
    synthesize: input => synthesizeLayerFields(input, options),
  };
}

// ═══════════════════════════════════════════════════════════════
// 厂商/官方源解析（批量生成前置步骤）
//
// 背景（Q-A 决策）：researchCatalog 的信任根只收 seed.official_url +
// discovery_sources[kind='official_hint']，seed 无两者时 roots=[]，全部搜索
// 结果会被当非官方丢弃。因此批量链路在喂 seed 给生成器之前，必须先解析出
// 厂商名 + 官方域名，写进 seed.official_url 与 discovery_sources。
//
// 解析策略：首选 Web Search、Tavily 备用 → DeepSeek 结构化提取 { vendor_name, official_url }。
// 缺搜索结果 / DeepSeek key / ledger 一律 fail-closed，不硬猜（防假官方来源）。
// ═══════════════════════════════════════════════════════════════

/** 厂商解析指令（纯函数构建）。 */
function buildVendorResolutionInstructions() {
  return '你负责从工具名和搜索候选里判定官方厂商与官方域名。规则：' +
    '只选真实官网（公司/产品的官方站点），排除 GitHub、维基百科、第三方评测/聚合/下载站、社交媒体；' +
    '无法确定时 official_url 填空字符串，vendor_name 可留空由调用方回退工具名。' +
    '输出 JSON { "vendor_name": string, "official_url": string }，字段必须是字符串。';
}

/**
 * 用统一 Web Search + DeepSeek 结构化提取，从工具名解析官方厂商与官方域名。
 * @param {string} name 工具名
 * @param {object} [options] { searchApiKey, searchFetchImpl, fetchImpl, searchTimeoutMs, timeoutMs,
 *                            searchDepth, maxSearchResults, provider, apiKey, model, ledger }
 *   ledger 必传（DeepSeek 结构化 fail-closed）；缺 → COST_LEDGER_REQUIRED。
 * @returns {Promise<{ok:true, vendor_name, official_url, usage} | {ok:false, code, error}>}
 */
async function resolveOfficialSource(name, options = {}) {
  const toolName = String(name || '').trim();
  if (!toolName) return { ok: false, code: 'VENDOR_RESOLUTION_NAME_REQUIRED', error: '缺少工具名' };

  const search = await searchWebWithFallback({
    provider: options.searchProvider || 'zhipu_web_search',
    fallbackProvider: options.searchFallbackProvider ?? 'tavily',
    fallbackLedger: options.ledger,
    providerApiKeys: { zhipu_web_search: options.webSearchApiKey, tavily: options.searchApiKey },
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: `${toolName} official site`,
    maxResults: options.maxSearchResults ?? 5,
    searchDepth: options.searchDepth || 'advanced',
    providerOptions: { engine: options.searchEngine || 'search_std' },
  });
  if (!search.ok) return search;
  if (!search.sources || !search.sources.length) {
    const fallbackError = search.fallback_error ? `；备用搜索 ${search.fallback_error.code || '失败'}` : '';
    return { ok: false, code: search.fallback_error?.code || 'VENDOR_RESOLUTION_NO_RESULTS', error: `搜索无结果: ${toolName}${fallbackError}` };
  }

  const providerResult = resolveProvider(options.provider || 'deepseek');
  if (!providerResult.ok) return providerResult;
  const extractionKey = apiKeyForProvider(providerResult.provider, options.apiKey);
  if (!extractionKey) return { ok: false, code: `${providerResult.provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${providerResult.provider.apiKeyEnv}` };

  const extracted = await requestStructuredJson({
    kind: 'vendor_resolution',
    instructions: buildVendorResolutionInstructions(),
    input: JSON.stringify({
      tool_name: toolName,
      search_results: search.sources.map(source => ({ url: source.url, title: source.title })),
    }),
    maxOutputTokens: options.maxOutputTokens ?? 800,
    ledger: options.ledger,
    validate: value => value && typeof value === 'object'
      && typeof value.vendor_name === 'string' && typeof value.official_url === 'string',
  }, {
    model: options.model || getProvider('deepseek')?.defaultModel,
    apiKey: extractionKey,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint || LOCAL_API_BASE,
  });
  if (!extracted.ok) return extracted;

  const officialUrl = canonicalizeUrl(extracted.value.official_url || '');
  if (!officialUrl) return { ok: false, code: 'VENDOR_RESOLUTION_INVALID_URL', error: `解析未得到有效官方域名: ${toolName}` };
  return {
    ok: true,
    vendor_name: String(extracted.value.vendor_name || '').trim() || toolName,
    official_url: officialUrl,
    usage: extracted.usage,
  };
}

module.exports = {
  buildOfficialDiscoveryQuery,
  buildOfficialDomains: officialDomainsOf,
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
  buildVendorResolutionInstructions,
  resolveOfficialSource,
};
