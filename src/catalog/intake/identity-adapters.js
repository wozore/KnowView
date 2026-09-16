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

const { searchTavily, extractTavily, canonicalizeUrl } = require('../../shared/tavily-client');
const { requestStructuredJson } = require('../../shared/llm-gateway');
const { resolveProvider, apiKeyForProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { createCostLedger } = require('../core');
const { validateIdentitySuggestionValue } = require('./model-identity-verification');

/** resolution/bundle 转发只透传白名单键，防止上层无关 options 误入真实凭据面。 */
function identityAdapterOptionsOf(options = {}) {
  return {
    searchApiKey: options.searchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    maxSearchResults: options.maxSearchResults,
    searchDepth: options.searchDepth,
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
  const includeDomains = officialDomainsOf(input.official_urls);
  const result = await searchTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: `${name} official`,
    ...(includeDomains.length ? { includeDomains } : {}),
    searchDepth: options.searchDepth || 'advanced',
    maxResults: options.maxSearchResults ?? 5,
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
  if (!result.ok) throw new Error(`${result.code || 'TAVILY_EXTRACT_FAILED'}: ${result.error || '官方正文获取失败'}`);
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
      maxOutputTokens: 600,
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

module.exports = {
  identityAdapterOptionsOf,
  createIdentityVerificationAdapters,
  createIdentitySuggestAdapter,
};
