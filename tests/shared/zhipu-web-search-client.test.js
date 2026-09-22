'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchZhipu } = require('../../src/shared/zhipu-web-search-client');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

test('zhipu web search sends the documented request and normalizes results', async () => {
  let request;
  const result = await searchZhipu({
    query: 'official docs', apiKey: 'test-key', engine: 'search_pro', count: 3, domain: 'example.com',
    fetchImpl: async (url, init) => {
      request = { url, headers: init.headers, body: JSON.parse(init.body) };
      return response({ search_result: [{ link: 'https://example.com/docs', title: 'Docs', content: 'Excerpt' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.search_engine, 'search_pro');
  assert.equal(request.body.search_intent, false);
  assert.equal(request.body.count, 3);
  assert.equal(request.body.search_domain_filter, 'example.com');
  assert.equal(result.sources[0].url, 'https://example.com/docs');
  assert.equal(result.usage.requests, 1);
});

test('zhipu web search fails closed without exposing response details', async () => {
  const result = await searchZhipu({
    query: 'test', apiKey: 'secret-key',
    fetchImpl: async () => response({ secret: 'do-not-return' }, false, 500),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZHIPU_WEB_SEARCH_FAILED');
  assert.equal(result.sources.length, 0);
  assert.equal(result.usage.requests, 1);
  assert.equal(result.error.includes('do-not-return'), false);
  assert.equal(result.error.includes('secret-key'), false);
});
