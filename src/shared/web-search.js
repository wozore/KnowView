'use strict';

const { searchTavily } = require('./tavily-client');
const { searchZhipu } = require('./zhipu-web-search-client');
const {
  normalizeDomain,
  normalizeSources,
  filterSourcesByDomains,
} = require('./web-source-contract');

function providerOf(value) {
  return String(value || 'tavily').trim().toLowerCase();
}

function isZhipuProvider(provider) {
  return provider === 'zhipu_web_search';
}

function domainsOf(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeDomain).filter(Boolean))];
}

function requestCountOf(options = {}) {
  const provider = providerOf(options.provider);
  if (provider === 'tavily') return 1;
  if (isZhipuProvider(provider)) return Math.max(1, domainsOf(options.includeDomains).length);
  return 0;
}

function usageOf(requests) {
  return { requests: Math.max(0, Number.isFinite(requests) ? requests : 0) };
}

function failed(provider, code, error, requests = 0) {
  return { ok: false, provider, code, error, sources: [], usage: usageOf(requests) };
}

function maxResultsOf(value) {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.floor(value));
}

function budgetExceeded(provider, planned, maxRequests) {
  if (!Number.isFinite(maxRequests) || planned <= maxRequests) return null;
  return failed(provider, 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED', '搜索请求预算不足', 0);
}

function tavilyOptions(options, includeDomains, excludeDomains, maxResults) {
  const providerOptions = options.providerOptions && typeof options.providerOptions === 'object'
    ? options.providerOptions : {};
  return {
    query: options.query,
    maxResults,
    includeDomains,
    excludeDomains,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    apiKey: options.apiKey,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    searchDepth: options.searchDepth,
    ...providerOptions,
  };
}

async function searchTavilyProvider(options, includeDomains, excludeDomains, maxResults) {
  const result = await searchTavily(tavilyOptions(options, includeDomains, excludeDomains, maxResults));
  const requests = 1;
  if (!result?.ok) return failed('tavily', result?.code || 'TAVILY_SEARCH_FAILED', result?.error || 'Tavily 搜索失败', requests);
  const sources = filterSourcesByDomains(normalizeSources(result.sources), includeDomains, excludeDomains).slice(0, maxResults);
  return { ok: true, provider: 'tavily', sources, usage: { ...(result.usage && typeof result.usage === 'object' ? result.usage : {}), requests } };
}

function zhipuOptions(options, domain, maxResults) {
  const providerOptions = options.providerOptions && typeof options.providerOptions === 'object'
    ? options.providerOptions : {};
  return {
    query: options.query,
    maxResults,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    apiKey: options.apiKey,
    ...(domain ? { domain } : {}),
    ...providerOptions,
  };
}

async function searchZhipuProvider(options, includeDomains, excludeDomains, maxResults, provider) {
  const domains = includeDomains.length ? includeDomains : [''];
  const sources = [];
  let requests = 0;
  for (const domain of domains) {
    const result = await searchZhipu(zhipuOptions(options, domain, maxResults));
    requests += 1;
    if (!result?.ok) return failed(provider, result?.code || 'ZHIPU_WEB_SEARCH_FAILED', result?.error || '智谱搜索失败', requests);
    sources.push(...filterSourcesByDomains(normalizeSources(result.sources), includeDomains, excludeDomains));
  }
  const deduped = normalizeSources(sources).slice(0, maxResults);
  return { ok: true, provider, sources: deduped, usage: { requests } };
}

async function searchWeb(options = {}) {
  const provider = providerOf(options.provider);
  const includeDomains = domainsOf(options.includeDomains);
  const excludeDomains = domainsOf(options.excludeDomains);
  const maxResults = maxResultsOf(options.maxResults);
  const planned = requestCountOf({ provider, includeDomains });
  if (provider !== 'tavily' && !isZhipuProvider(provider)) return failed(provider, 'WEB_SEARCH_PROVIDER_UNSUPPORTED', '不支持的 Web Search provider');
  const budgetFailure = budgetExceeded(provider, planned, options.maxRequests);
  if (budgetFailure) return budgetFailure;
  return isZhipuProvider(provider)
    ? searchZhipuProvider(options, includeDomains, excludeDomains, maxResults, provider)
    : searchTavilyProvider(options, includeDomains, excludeDomains, maxResults);
}

function attemptOf(result, provider) {
  return {
    provider,
    ok: result?.ok === true,
    code: result?.code || null,
    source_count: Array.isArray(result?.sources) ? result.sources.length : 0,
    requests: Number(result?.usage?.requests || 0),
  };
}

/** Search with one explicitly budgeted backup provider; successful empty results remain eligible for domain widening. */
async function searchWebWithFallback(options = {}) {
  const {
    fallbackProvider: fallbackInput,
    fallbackLedger,
    fallbackApiKey,
    providerApiKeys,
    ...requestOptions
  } = options;
  const primaryProvider = providerOf(requestOptions.provider);
  const primaryApiKey = providerApiKeys?.[primaryProvider] ?? requestOptions.apiKey;
  const primary = await searchWeb({ ...requestOptions, provider: primaryProvider, apiKey: primaryApiKey });
  const primaryAttempt = attemptOf(primary, primaryProvider);
  if (primary.ok && primary.sources.length) return { ...primary, fallback_used: false, attempts: [primaryAttempt] };

  const fallbackProvider = String(fallbackInput || '').trim().toLowerCase();
  if (!fallbackProvider || fallbackProvider === primaryProvider) {
    return { ...primary, fallback_used: false, attempts: [primaryAttempt] };
  }
  const fallbackRequests = requestCountOf({ provider: fallbackProvider, includeDomains: requestOptions.includeDomains });
  if (fallbackLedger && fallbackRequests > 0) {
    const reservation = fallbackLedger.reserve('search_queries', fallbackRequests);
    if (!reservation.ok) {
      if (primary.ok) {
        return {
          ...primary,
          fallback_used: false,
          fallback_error: { provider: fallbackProvider, code: 'COST_BUDGET_EXHAUSTED', category: 'search_queries', error: '备用 Web Search 的成本预算不足' },
          attempts: [primaryAttempt, { provider: fallbackProvider, ok: false, code: 'COST_BUDGET_EXHAUSTED', source_count: 0, requests: 0 }],
        };
      }
      return {
        ok: false,
        provider: fallbackProvider,
        code: 'COST_BUDGET_EXHAUSTED',
        category: 'search_queries',
        error: '备用 Web Search 的成本预算不足',
        sources: [],
        usage: primary.usage || usageOf(0),
        fallback_used: false,
        attempts: [primaryAttempt, { provider: fallbackProvider, ok: false, code: 'COST_BUDGET_EXHAUSTED', source_count: 0, requests: 0 }],
      };
    }
  }
  const backupApiKey = providerApiKeys?.[fallbackProvider] ?? fallbackApiKey ?? requestOptions.apiKey;
  const fallback = await searchWeb({ ...requestOptions, provider: fallbackProvider, apiKey: backupApiKey, maxRequests: fallbackRequests || undefined });
  const attempts = [primaryAttempt, attemptOf(fallback, fallbackProvider)];
  const usage = { requests: Number(primary.usage?.requests || 0) + Number(fallback.usage?.requests || 0) };
  if (fallback.ok && fallback.sources.length) {
    return {
      ...fallback,
      usage,
      fallback_used: true,
      fallback_from: primaryProvider,
      primary_code: primary.code || (primary.sources?.length ? null : 'WEB_SEARCH_NO_RESULTS'),
      attempts,
    };
  }
  if (fallback.ok) {
    return {
      ...fallback,
      usage,
      fallback_used: true,
      fallback_from: primaryProvider,
      fallback_error: { provider: fallbackProvider, code: 'WEB_SEARCH_NO_RESULTS', error: '首选和备用 Web Search 均未找到来源' },
      attempts,
    };
  }
  if (primary.ok) {
    return {
      ...primary,
      usage,
      fallback_used: true,
      fallback_error: { provider: fallbackProvider, code: fallback.code || 'WEB_SEARCH_FAILED', error: fallback.error || '备用 Web Search 失败' },
      attempts,
    };
  }
  return {
    ok: false,
    provider: fallbackProvider,
    code: fallback.code || primary.code || 'WEB_SEARCH_FAILED',
    error: `${primaryProvider} 首选搜索失败${primary.code ? `（${primary.code}）` : ''}；${fallbackProvider} 备用搜索失败${fallback.code ? `（${fallback.code}）` : ''}`,
    sources: [],
    usage,
    fallback_used: true,
    fallback_from: primaryProvider,
    attempts,
  };
}

async function probeWebSearch(options = {}) {
  const result = await searchWebWithFallback({
    ...options,
    query: options.query || 'official web search documentation',
    maxResults: 1,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    provider: result.provider,
    source_count: result.sources.length,
    usage: result.usage,
    ...(result.fallback_used ? { fallback_used: true, fallback_from: result.fallback_from } : {}),
    ...(result.fallback_error ? { fallback_error: result.fallback_error } : {}),
  };
}

function plannedWebSearchRequests(options = {}) {
  return requestCountOf(options);
}

module.exports = {
  searchWeb,
  searchWebWithFallback,
  probeWebSearch,
  plannedWebSearchRequests,
};
