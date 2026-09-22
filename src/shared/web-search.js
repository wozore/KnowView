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

async function probeWebSearch(options = {}) {
  const result = await searchWeb({
    ...options,
    query: options.query || 'official web search documentation',
    maxResults: 1,
  });
  if (!result.ok) return result;
  return { ok: true, provider: result.provider, source_count: result.sources.length, usage: result.usage };
}

function plannedWebSearchRequests(options = {}) {
  return requestCountOf(options);
}

module.exports = {
  searchWeb,
  probeWebSearch,
  plannedWebSearchRequests,
};
