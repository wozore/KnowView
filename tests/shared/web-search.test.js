'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, probeWebSearch, plannedWebSearchRequests } = require('../../src/shared/web-search');

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('智谱 Web Search 多域请求预算在发请求前生效', async () => {
  let calls = 0;
  assert.equal(plannedWebSearchRequests({ provider: 'zhipu_web_search', includeDomains: ['a.example', 'b.example'] }), 2);
  const result = await searchWeb({
    provider: 'zhipu_web_search', query: 'official', includeDomains: ['a.example', 'b.example'],
    maxRequests: 1, fetchImpl: async () => { calls += 1; return response({ search_result: [] }); },
  });
  assert.equal(result.code, 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED');
  assert.equal(calls, 0);
});

test('智谱 Web Search 按域名依次查询、过滤并去重来源', async () => {
  const calls = [];
  const result = await searchWeb({
    provider: 'zhipu_web_search', query: 'official', includeDomains: ['a.example', 'b.example'],
    maxResults: 5, maxRequests: 2, apiKey: 'test-key', fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.search_domain_filter);
      return response({ search_result: [
        { title: 'official docs', link: `https://${body.search_domain_filter}/docs`, content: 'Official information' },
        { title: 'unrelated', link: 'https://other.example/page', content: 'Filtered' },
      ] });
    },
  });
  assert.deepEqual(calls, ['a.example', 'b.example']);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'zhipu_web_search');
  assert.equal(result.usage.requests, 2);
  assert.deepEqual(result.sources.map(item => item.url), ['https://a.example/docs', 'https://b.example/docs']);
});

test('不支持的搜索 provider fail-closed 且不发请求', async () => {
  let calls = 0;
  const result = await searchWeb({ provider: 'unsupported_provider', query: 'test', fetchImpl: async () => { calls += 1; } });
  assert.equal(result.code, 'WEB_SEARCH_PROVIDER_UNSUPPORTED');
  assert.equal(calls, 0);
});

test('Web Search 探针使用单条智谱搜索请求', async () => {
  const result = await probeWebSearch({
    provider: 'zhipu_web_search',
    maxRequests: 1,
    apiKey: 'test-key',
    fetchImpl: async () => response({ search_result: [{ title: 'docs', link: 'https://docs.example/api' }] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'zhipu_web_search');
  assert.equal(result.source_count, 1);
  assert.equal(result.usage.requests, 1);
});
