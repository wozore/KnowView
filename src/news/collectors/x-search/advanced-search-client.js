/**
 * advanced-search-client.js —— TwitterAPI.io Advanced Search 与 Article Transport（T4 模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §5.1 与 §13.2 契约：
 * 1. search(query, cursor) -> /twitter/tweet/advanced_search
 *    - query 必填，queryType='Latest'，cursor 可选
 *    - 响应归一化为 DTO：{ tweets: [], has_next_page: boolean, next_cursor: string|null }
 * 2. fetchArticle(tweetId) -> /twitter/article?tweet_id=${tweetId}
 *    - 参数名严格为 tweet_id（契约修复）
 * 3. 依赖注入 fetchImpl、有限重试与超时保护
 */

'use strict';

const DEFAULT_BASE_URL = 'https://api.twitterapi.io';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

class AdvancedSearchClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {function} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries]
   * @param {number} [options.retryBaseMs]
   */
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
  } = {}) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('AdvancedSearchClient requires a non-empty apiKey string');
    }
    this.apiKey = apiKey.trim();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.trunc(maxRetries) : 0;
    this.retryBaseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : 0;
  }

  /**
   * 执行单次 HTTP 请求尝试并解析 JSON。
   * @private
   */
  async _executeSingleAttempt(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.code = `NEWS_HTTP_${response.status}`;
      err.body = body;
      throw err;
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('Response is not valid JSON');
      err.code = 'NEWS_INVALID_JSON';
      err.body = text;
      throw err;
    }
  }

  /**
   * 执行带超时和有限重试的 HTTP GET 请求。
   * @private
   */
  async _fetchWithRetry(url, { beforeAttempt = null, onAttemptFailure = null } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (beforeAttempt && beforeAttempt(attempt) === false) {
        const err = new Error('Request budget check failed');
        err.code = 'NEWS_BUDGET_PAUSED';
        throw err;
      }

      try {
        return await this._executeSingleAttempt(url);
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new Error(`Request timeout after ${this.timeoutMs}ms`);
          lastError.code = 'NEWS_REQUEST_TIMEOUT';
        }
        if (onAttemptFailure) onAttemptFailure(attempt, lastError);
        if (lastError.code === 'NEWS_BUDGET_PAUSED') {
          throw lastError;
        }
        if (attempt < this.maxRetries && this.retryBaseMs > 0) {
          await new Promise(r => setTimeout(r, this.retryBaseMs * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  /**
   * 发起 Advanced Search 查询并归一化分页 DTO。
   * @param {string} query
   * @param {string|null} [cursor=null]
   * @param {object} [options]
   * @param {function} [options.beforeAttempt]
   * @returns {Promise<{tweets: object[], has_next_page: boolean, next_cursor: string|null}>}
   */
  async search(query, cursor = null, options = {}) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search requires a non-empty query string');
    }

    const url = new URL(`${this.baseUrl}/twitter/tweet/advanced_search`);
    url.searchParams.set('query', query.trim());
    url.searchParams.set('queryType', 'Latest');
    if (cursor && typeof cursor === 'string' && cursor.trim()) {
      url.searchParams.set('cursor', cursor.trim());
    }

    const payload = await this._fetchWithRetry(url, options);

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.tweets) || typeof payload.has_next_page !== 'boolean') {
      const error = new Error('Advanced Search response DTO is invalid');
      error.code = 'NEWS_INVALID_RESPONSE_DTO';
      throw error;
    }
    const nextCursor = payload.next_cursor;
    if (payload.has_next_page && (typeof nextCursor !== 'string' || !nextCursor.trim())) {
      const error = new Error('Advanced Search next cursor is missing');
      error.code = 'NEWS_MISSING_NEXT_CURSOR';
      throw error;
    }
    return {
      tweets: payload.tweets,
      has_next_page: payload.has_next_page,
      next_cursor: typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null,
    };
  }

  /**
   * 补读 Twitter Article 长文正文。
   * @param {string} tweetId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async fetchArticle(tweetId, options = {}) {
    if (!tweetId) {
      throw new Error('fetchArticle requires a non-empty tweetId');
    }

    const url = new URL(`${this.baseUrl}/twitter/article`);
    url.searchParams.set('tweet_id', String(tweetId).trim());

    return await this._fetchWithRetry(url, options);
  }
}

/**
 * 工厂函数：创建 AdvancedSearchClient 实例。
 */
function createAdvancedSearchClient(options) {
  return new AdvancedSearchClient(options);
}

module.exports = {
  AdvancedSearchClient,
  createAdvancedSearchClient,
};
