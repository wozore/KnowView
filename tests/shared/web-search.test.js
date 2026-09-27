'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, searchWebWithFallback, probeWebSearch, plannedWebSearchRequests } = require('../../src/shared/web-search');

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

test('fallback web search uses zhipu first and does not call Tavily when sources are found', async () => {
  const calls = [];
  const result = await searchWebWithFallback({
    provider: 'zhipu_web_search',
    fallbackProvider: 'tavily',
    providerApiKeys: { zhipu_web_search: 'zhipu-key', tavily: 'tavily-key' },
    accessMode: 'keyed',
    query: 'official model page',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization });
      return response({ search_result: [{ link: 'https://vendor.example/model', title: 'Official model page' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallback_used, false);
  assert.deepEqual(calls, [{ url: 'https://open.bigmodel.cn/api/paas/v4/web_search', authorization: 'Bearer zhipu-key' }]);
});

test('fallback web search uses Tavily after zhipu fails and accounts the extra request', async () => {
  const calls = [];
  const spent = [];
  const result = await searchWebWithFallback({
    provider: 'zhipu_web_search',
    fallbackProvider: 'tavily',
    providerApiKeys: { zhipu_web_search: 'zhipu-key', tavily: 'tavily-key' },
    accessMode: 'keyed',
    fallbackLedger: { reserve(category, count) { spent.push([category, count]); return { ok: true }; } },
    query: 'official model page',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization });
      if (String(url).includes('bigmodel.cn')) return response({}, false, 500);
      return response({ results: [{ url: 'https://vendor.example/model', title: 'Official model page' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallback_used, true);
  assert.equal(result.fallback_from, 'zhipu_web_search');
  assert.equal(calls[1].url, 'https://api.tavily.com/search');
  assert.equal(calls[1].authorization, 'Bearer tavily-key');
  assert.deepEqual(spent, [['search_queries', 1]]);
});

test('fallback web search stops before Tavily when the confirmed fallback budget is exhausted', async () => {
  let calls = 0;
  const result = await searchWebWithFallback({
    provider: 'zhipu_web_search',
    fallbackProvider: 'tavily',
    providerApiKeys: { zhipu_web_search: 'zhipu-key' },
    query: 'official model page',
    fallbackLedger: { reserve: () => ({ ok: false, code: 'COST_BUDGET_EXHAUSTED' }) },
    fetchImpl: async () => { calls += 1; return response({}, false, 500); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_BUDGET_EXHAUSTED');
  assert.equal(result.category, 'search_queries');
  assert.equal(calls, 1, 'only the primary provider was called');
});
