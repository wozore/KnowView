'use strict';

const { envValue } = require('./env');
const { normalizeSources } = require('./web-source-contract');

const SEARCH_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const SEARCH_ENGINES = new Set(['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark']);
const DEFAULT_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 60000;

function failure(code, error, usage = { requests: 0 }) {
  return { ok: false, code, error, sources: [], usage };
}

function queryOf(options) {
  return typeof options.query === 'string' ? options.query.trim().slice(0, 70) : '';
}

function countOf(value) {
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function engineOf(options) {
  const engine = options.searchEngine || options.engine || options.providerOptions?.engine || 'search_std';
  return SEARCH_ENGINES.has(engine) ? engine : '';
}

function buildSearchPayload(options = {}) {
  const payload = {
    search_query: queryOf(options),
    search_engine: engineOf(options),
    search_intent: false,
    count: countOf(options.count ?? options.maxResults),
  };
  const domain = typeof options.domain === 'string'
    ? options.domain.trim()
    : typeof options.searchDomainFilter === 'string' ? options.searchDomainFilter.trim() : '';
  if (domain) payload.search_domain_filter = domain;
  if (options.searchRecencyFilter) payload.search_recency_filter = String(options.searchRecencyFilter);
  if (options.contentSize) payload.content_size = String(options.contentSize);
  return payload;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'ZHIPU_WEB_SEARCH_AUTH_REQUIRED';
  if (status === 408 || status === 504) return 'ZHIPU_WEB_SEARCH_TIMEOUT';
  if (status === 429) return 'ZHIPU_WEB_SEARCH_RATE_LIMITED';
  return 'ZHIPU_WEB_SEARCH_FAILED';
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function searchZhipu(options = {}) {
  const query = queryOf(options);
  if (!query) return failure('ZHIPU_WEB_SEARCH_QUERY_REQUIRED', '缺少智谱搜索 query');
  if (!engineOf(options)) return failure('ZHIPU_WEB_SEARCH_ENGINE_INVALID', '不支持的智谱搜索引擎');
  const apiKey = options.apiKey ?? envValue('ZHIPU_API_KEY');
  if (typeof apiKey !== 'string' || !apiKey.trim()) return failure('ZHIPU_WEB_SEARCH_AUTH_REQUIRED', '缺少 ZHIPU_API_KEY');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return failure('ZHIPU_WEB_SEARCH_NETWORK_ERROR', '当前运行环境无 fetch');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const signal = timeoutSignal(timeoutMs);
  let response;
  try {
    response = await fetchImpl(options.endpoint || SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildSearchPayload(options)),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT';
    return failure(timeout ? 'ZHIPU_WEB_SEARCH_TIMEOUT' : 'ZHIPU_WEB_SEARCH_NETWORK_ERROR', timeout ? '智谱搜索请求超时' : '智谱搜索网络请求失败', { requests: 1 });
  }
  if (!response?.ok) return failure(classifyStatus(response?.status), response?.status === 429 ? '智谱搜索请求被限流' : `智谱搜索请求失败（HTTP ${response?.status || 0}）`, { requests: 1 });
  let data;
  try { data = await response.json(); } catch { return failure('ZHIPU_WEB_SEARCH_OUTPUT_INVALID', '智谱搜索响应不是 JSON', { requests: 1 }); }
  const rows = data && Array.isArray(data.search_result) ? data.search_result : null;
  if (!rows) return failure('ZHIPU_WEB_SEARCH_OUTPUT_INVALID', '智谱搜索响应格式无效', { requests: 1 });
  return { ok: true, sources: normalizeSources(rows), usage: { requests: 1 } };
}

module.exports = {
  SEARCH_ENDPOINT,
  SEARCH_ENGINES,
  buildSearchPayload,
  searchZhipu,
};
