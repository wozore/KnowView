'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, probeWebSearch, plannedWebSearchRequests } = require('../../src/shared/web-search');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

test('web search plans zhipu multi-domain requests and enforces budget before fetch', async () => {
  assert.equal(plannedWebSearchRequests({ provider: 'zhipu_web_search', includeDomains: ['a.example', 'b.example'] }), 2);
  let calls = 0;
  const result = await searchWeb({ provider: 'zhipu_web_search', query: 'test', includeDomains: ['a.example', 'b.example'], maxRequests: 1, apiKey: 'k', fetchImpl: async () => { calls += 1; return response({ search_result: [] }); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED');
  assert.equal(result.usage.requests, 0);
  assert.equal(calls, 0);
});

test('web search fans out zhipu serially and applies host filters/deduplication', async () => {
  const calls = [];
  const result = await searchWeb({
    provider: 'zhipu_web_search', query: 'test', includeDomains: ['a.example', 'b.example'], excludeDomains: ['blocked.example'], maxResults: 2, apiKey: 'k',
    providerOptions: { engine: 'search_std' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.search_domain_filter);
      return response({ search_result: [
        { link: 'https://docs.a.example/a', title: 'A', content: 'a' },
        { link: 'https://docs.a.example/a#dup', title: 'dup' },
        { link: 'https://blocked.example/x', title: 'blocked' },
        { link: 'https://docs.b.example/b', title: 'B', content: 'b' },
      ] });
    },
  });
  assert.deepEqual(calls, ['a.example', 'b.example']);
  assert.deepEqual(result.sources.map(item => item.url), ['https://docs.a.example/a', 'https://docs.b.example/b']);
  assert.equal(result.usage.requests, 2);
});

test('web search probe returns a small uniform summary', async () => {
  const result = await probeWebSearch({ provider: 'zhipu_web_search', apiKey: 'k', fetchImpl: async () => response({ search_result: [{ link: 'https://example.com', title: 'x' }] }) });
  assert.deepEqual(result, { ok: true, provider: 'zhipu_web_search', source_count: 1, usage: { requests: 1 } });
});
