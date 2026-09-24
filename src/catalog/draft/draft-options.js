'use strict';

const { getProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { canonicalizeUrl } = require('../../shared/web-source-contract');
const { plannedWebSearchRequests } = require('../../shared/web-search');
const { registrableHostOf } = require('../core');
const { loadAiModuleConfig } = require('../ai-config');

function normalizeGeneratorOptions(options = {}) {
  const valueOf = (camel, snake, fallback) => {
    const value = options[camel] ?? options[snake];
    return value === undefined || value === null || value === '' ? fallback : value;
  };
  const defaultProvider = getProvider(DEFAULT_PROVIDER_NAME);
  return {
    provider: valueOf('provider', 'provider', DEFAULT_PROVIDER_NAME),
    model: valueOf('model', 'model', defaultProvider.defaultModel),
    protocol: valueOf('protocol', 'protocol', defaultProvider.protocol),
    searchProvider: valueOf('searchProvider', 'search_provider', 'zhipu_web_search'),
    searchFallbackProvider: valueOf('searchFallbackProvider', 'search_fallback_provider', 'tavily'),
    extractProvider: valueOf('extractProvider', 'extract_provider', 'direct_fetch'),
    extractFallbackProvider: valueOf('extractFallbackProvider', 'extract_fallback_provider', 'tavily'),
    searchEngine: valueOf('searchEngine', 'search_engine', 'search_std'),
    accessMode: valueOf('accessMode', 'access_mode', undefined),
    timeoutMs: valueOf('timeoutMs', 'timeout_ms', undefined),
    maxSearchQueries: valueOf('maxSearchQueries', 'max_search_queries', undefined),
    maxPages: valueOf('maxPages', 'max_pages', undefined),
    maxResponsesCalls: valueOf('maxResponsesCalls', 'max_responses_calls', undefined),
    maxSynthesisCalls: valueOf('maxSynthesisCalls', 'max_synthesis_calls', undefined),
    maxRepairCalls: valueOf('maxRepairCalls', 'max_repair_calls', undefined),
    searchTimeoutMs: valueOf('searchTimeoutMs', 'search_timeout_ms', undefined),
    searchDepth: valueOf('searchDepth', 'search_depth', undefined),
    maxSearchResults: valueOf('maxSearchResults', 'max_search_results', undefined),
    extractDepth: valueOf('extractDepth', 'extract_depth', undefined),
    chunksPerSource: valueOf('chunksPerSource', 'chunks_per_source', undefined),
    ...(options.confirmCost !== undefined ? { confirmCost: options.confirmCost } : {}),
  };
}

function requireSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.detail_kind || !seed.name || !seed.vendor_name) {
    return { ok: false, code: 'SEED_INVALID', error: 'Seed 必须包含 detail_kind/name/vendor_name' };
  }
  if (seed.operation && !['create', 'replace'].includes(seed.operation)) {
    return { ok: false, code: 'SEED_INVALID', error: 'operation 只允许 create 或 replace；新流程优先使用 repair_layers' };
  }
  return { ok: true };
}

function officialDomainsOf(plan, widened = false) {
  const seed = plan?.seed || {};
  const urls = [seed.official_url, ...(seed.discovery_sources || []).map(source => source?.url)]
    .map(canonicalizeUrl).filter(Boolean);
  const hosts = [...new Set(urls.map(url => new URL(url).hostname.toLowerCase().replace(/^www\./, '')))];
  if (!widened) return hosts;
  const expanded = new Set(hosts);
  for (const host of hosts) {
    const root = registrableHostOf(host);
    if (root) expanded.add(root);
  }
  return [...expanded];
}

function searchRequestUpperBounds(plan, options = {}) {
  const scopes = Array.isArray(plan?.research_scopes) ? plan.research_scopes : [];
  const primaryProvider = options.searchProvider ?? options.search_provider ?? 'zhipu_web_search';
  const fallbackProvider = options.searchFallbackProvider ?? options.search_fallback_provider ?? 'tavily';
  const scopeCount = Math.min(scopes.length, options.maxSearchQueries ?? options.max_search_queries ?? 4);
  const fallback = fallbackProvider && fallbackProvider !== primaryProvider ? fallbackProvider : '';
  const primaryDomains = officialDomainsOf(plan, false);
  const widenedDomains = officialDomainsOf(plan, true);
  let primary = 0;
  let backup = 0;
  for (let index = 0; index < scopeCount; index += 1) {
    primary += plannedWebSearchRequests({ provider: primaryProvider, includeDomains: primaryDomains });
    primary += plannedWebSearchRequests({ provider: primaryProvider, includeDomains: widenedDomains });
    if (fallback) {
      backup += plannedWebSearchRequests({ provider: fallback, includeDomains: primaryDomains });
      backup += plannedWebSearchRequests({ provider: fallback, includeDomains: widenedDomains });
    }
  }
  return { primary, fallback: backup };
}

function researchLimits(options = {}, plan = null) {
  const primarySearchLimit = options.maxSearchQueries ?? options.max_search_queries ?? 4;
  const primaryProvider = options.searchProvider ?? options.search_provider ?? 'zhipu_web_search';
  const fallbackProvider = options.searchFallbackProvider ?? options.search_fallback_provider ?? 'tavily';
  const hasSearchFallback = Boolean(fallbackProvider && fallbackProvider !== primaryProvider);
  const requestBounds = plan ? searchRequestUpperBounds(plan, options) : null;
  return {
    search_queries: requestBounds
      ? Math.max(primarySearchLimit * (hasSearchFallback ? 2 : 1), requestBounds.primary + requestBounds.fallback)
      : primarySearchLimit * (hasSearchFallback ? 2 : 1),
    pages: options.maxPages ?? options.max_pages ?? 8,
    responses_calls: options.maxResponsesCalls ?? options.max_responses_calls ?? 12,
    synthesis_calls: options.maxSynthesisCalls ?? options.max_synthesis_calls ?? 1,
  };
}

function resumeResearchLimits(options = {}, previousCost = {}, plan = null) {
  const incremental = researchLimits(options, plan);
  const spent = previousCost?.spent || {};
  return Object.fromEntries(Object.entries(incremental).map(([category, limit]) => [category, Number(spent[category] || 0) + limit]));
}

function estimateResearchCost(plan, limits, options = {}) {
  const scopes = Array.isArray(plan.research_scopes) ? plan.research_scopes.length : 0;
  const requestBounds = searchRequestUpperBounds(plan, options);
  const maxRepairCalls = options.maxRepairCalls ?? options.max_repair_calls ?? 1;
  return {
    hard_limits: { ...limits },
    planned_scopes: scopes,
    estimated_search_queries: requestBounds.primary,
    estimated_search_fallback_queries: requestBounds.fallback,
    estimated_extract_fallback_upper_bound: Math.min(scopes, options.maxSearchQueries ?? 4),
    estimated_synthesis_calls: scopes ? 1 : 0,
    worst_case_responses_calls: Math.min(limits.responses_calls, (scopes ? 1 : 0) + maxRepairCalls),
  };
}

function loadGeneratorConfig() {
  return loadAiModuleConfig('catalog');
}

module.exports = {
  normalizeGeneratorOptions,
  requireSeed,
  researchLimits,
  resumeResearchLimits,
  estimateResearchCost,
  loadGeneratorConfig,
};
