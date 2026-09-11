/**
 * x-search-client.test.js —— AdvancedSearchClient 离线单元测试
 *
 * 运行：node --test tests/news/x-search-client.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAdvancedSearchClient,
} = require('../../src/news/collectors/x-search/advanced-search-client');

test('client: search 请求参数、请求头与分页 DTO 归一化', async () => {
  let interceptedUrl = null;
  let interceptedHeaders = null;

  const fetchImpl = async (url, options) => {
    interceptedUrl = url;
    interceptedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        tweets: [{ id: '123', text: 'Hello' }],
        has_next_page: true,
        next_cursor: 'cursor_abc',
      }),
    };
  };

  const client = createAdvancedSearchClient({
    apiKey: 'test_key',
    baseUrl: 'https://api.twitterapi.io',
    fetchImpl,
  });

  const res = await client.search('(from:OpenAI)', 'prev_cur');

  assert.ok(interceptedUrl.includes('/twitter/tweet/advanced_search'));
  assert.ok(interceptedUrl.includes('query=%28from%3AOpenAI%29'));
  assert.ok(interceptedUrl.includes('queryType=Latest'));
  assert.ok(interceptedUrl.includes('cursor=prev_cur'));
  assert.equal(interceptedHeaders['X-API-Key'], 'test_key');

  assert.equal(res.tweets.length, 1);
  assert.equal(res.has_next_page, true);
  assert.equal(res.next_cursor, 'cursor_abc');
});

test('client: fetchArticle 严格使用 tweet_id 参数（契约校验）', async () => {
  let interceptedUrl = null;

  const fetchImpl = async url => {
    interceptedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: { article: { title: 'AI Post', contents: 'Body text' } },
      }),
    };
  };

  const client = createAdvancedSearchClient({
    apiKey: 'test_key',
    fetchImpl,
  });

  const res = await client.fetchArticle('987654321');

  assert.ok(interceptedUrl.includes('/twitter/article'));
  // 必须严格包含 tweet_id=，绝对不能使用已废弃的 tweetId=
  assert.ok(interceptedUrl.includes('tweet_id=987654321'));
  assert.equal(interceptedUrl.includes('tweetId='), false);
  assert.ok(res.data.article);
});

test('client: HTTP 错误与有限重试机制', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 2) {
      return {
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tweets: [], has_next_page: false }),
    };
  };

  const client = createAdvancedSearchClient({
    apiKey: 'test_key',
    fetchImpl,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  const res = await client.search('query');
  assert.equal(attempts, 2, '第一次失败后成功重试');
  assert.equal(res.tweets.length, 0);
});

test('client: 错误码带 NEWS_ 前缀（NEWS_HTTP_429, NEWS_HTTP_500, NEWS_INVALID_JSON, NEWS_REQUEST_TIMEOUT）', async () => {
  // 1. NEWS_HTTP_429
  const client429 = createAdvancedSearchClient({
    apiKey: 'test_key',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    }),
  });
  await assert.rejects(
    async () => client429.search('query'),
    err => {
      assert.equal(err.code, 'NEWS_HTTP_429');
      assert.equal(err.status, 429);
      return true;
    }
  );

  // 2. NEWS_HTTP_500
  const client500 = createAdvancedSearchClient({
    apiKey: 'test_key',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }),
  });
  await assert.rejects(
    async () => client500.search('query'),
    err => {
      assert.equal(err.code, 'NEWS_HTTP_500');
      assert.equal(err.status, 500);
      return true;
    }
  );

  // 3. NEWS_INVALID_JSON
  const clientJson = createAdvancedSearchClient({
    apiKey: 'test_key',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => 'not a json <html />',
    }),
  });
  await assert.rejects(
    async () => clientJson.search('query'),
    err => {
      assert.equal(err.code, 'NEWS_INVALID_JSON');
      return true;
    }
  );

  // 4. NEWS_REQUEST_TIMEOUT
  const clientTimeout = createAdvancedSearchClient({
    apiKey: 'test_key',
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: async (_url, { signal }) => {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  });
  await assert.rejects(
    async () => clientTimeout.search('query'),
    err => {
      assert.equal(err.code, 'NEWS_REQUEST_TIMEOUT');
      return true;
    }
  );
});
