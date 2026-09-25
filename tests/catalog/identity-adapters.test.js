/**
 * identity-adapters.test.js — 身份核验层适配器全离线回归
 *
 * 测试原理：fetchImpl 全部注入 fake（绝不真实联网），断言 discover/acquire
 * 的 Web Search/Tavily 备用请求与官方正文直连/提取回退语义、
 * suggest 的结构化建议链路；resolution 级验证未注入 identityAdapters 时
 * 默认构造被采用（核验链路真实推进而非秒失败）。
 *
 * 运行方式：node --test tests/catalog/identity-adapters.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdentityVerificationAdapters,
  createIdentitySuggestAdapter,
  identityContextOf,
  identityAdapterOptionsOf,
} = require('../../src/catalog/intake/identity-adapters');
const { resolveBatchCandidates } = require('../../src/catalog/intake/resolution');
const { emptySnapshot } = require('../../src/catalog/core/index');

const VALID_SUGGESTION = {
  entity_class: 'model',
  vendor_key: 'openai',
  identity: 'gpt-5-6',
  series_title: null,
  family: null,
  reasons: ['official docs'],
};

test('identity verification ledger reserves search fallback and series-member retry upper bounds', () => {
  const context = identityContextOf({
    identityBudgetSize: 2,
    identitySnapshotOf: () => emptySnapshot(),
    identityPolicy: {},
    policyRevision: 'policy-r1',
    bridgeRevision: 'bridge-r1',
    identityReceipts: [],
    searchProvider: 'zhipu_web_search',
    searchFallbackProvider: 'tavily',
  });
  assert.equal(context.ledger.snapshot().limits.search_queries, 4);
  assert.equal(context.ledger.snapshot().limits.pages, 6);
  assert.equal(context.ledger.snapshot().limits.responses_calls, 8, '包含身份建议格式重试和最多两轮系列成员建议');
});

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

// ── discover：官方源发现（核验层契约）────────────────────────────

test('discover：保留已声明来源，同时按官方域执行智谱定向搜索', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push({ endpoint: String(endpoint), body: JSON.parse(init.body), headers: init.headers });
    return jsonResponse({ search_result: [{ link: 'https://platform.openai.com/docs/gpt-5-6', title: 'GPT-5.6', content: 'official page' }] });
  };
  const adapters = createIdentityVerificationAdapters({
    fetchImpl, accessMode: 'keyed', searchApiKey: 'search-key', webSearchApiKey: 'web-search-key', maxSearchResults: 3, searchDepth: 'basic',
  });
  const sources = await adapters.discoverOfficialSources({
    name: 'GPT-5.6',
    entity_type: 'model',
    official_urls: ['https://platform.openai.com/docs', 'https://openai.com/blog/x', 'not-a-url'],
  });
  assert.equal(calls.length, 2, '按两个登记官方域执行智谱搜索');
  assert.ok(calls.every(call => call.endpoint.includes('/web_search')));
  assert.ok(calls.every(call => call.body.search_domain_filter));
  assert.deepEqual(sources.map(source => source.url), [
    'https://platform.openai.com/docs', 'https://openai.com/blog/x', 'https://platform.openai.com/docs/gpt-5-6',
  ], '声明来源、目标搜索结果均保留，非法 URL 被过滤');
});

test('discover：official_urls 为空时不传 include_domains', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({ results: [] });
  };
  const adapters = createIdentityVerificationAdapters({ fetchImpl, searchProvider: 'tavily', searchFallbackProvider: 'tavily', accessMode: 'keyed', searchApiKey: 'k' });
  const sources = await adapters.discoverOfficialSources({ name: 'Some Model', entity_type: 'model', official_urls: [] });
  assert.equal('include_domains' in calls[0], false);
  assert.deepEqual(sources, []);
});

test('discover：首选和备用搜索都失败时保留失败错误', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) });
  const adapters = createIdentityVerificationAdapters({ fetchImpl, searchProvider: 'tavily', searchFallbackProvider: 'tavily', accessMode: 'keyed', searchApiKey: 'k' });
  await assert.rejects(
    () => adapters.discoverOfficialSources({ name: 'X Model', entity_type: 'model', official_urls: [] }),
    /TAVILY_SEARCH_RATE_LIMITED/,
  );
});

// ── acquire：官方正文获取（核验层契约）────────────────────────────

test('acquire：直连失败后 Tavily Extract 读取剩余官方正文', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push({ endpoint: String(endpoint), body: init.body ? JSON.parse(init.body) : null });
    if (String(endpoint).startsWith('https://openai.com/')) return { ok: false, status: 503, text: async () => '' };
    return jsonResponse({
      results: [
        { url: 'https://openai.com/a', raw_content: 'GPT-5.6 body' },
        { url: 'https://openai.com/b', content: 'second body' },
        { url: 'https://openai.com/c', raw_content: '   ' },
      ],
      failed_results: [],
    });
  };
  const adapters = createIdentityVerificationAdapters({
    fetchImpl, accessMode: 'keyed', searchApiKey: 'k', chunksPerSource: 2, extractDepth: 'basic',
  });
  const pages = await adapters.acquireOfficialSources([
    { url: 'https://openai.com/a/', title: 'GPT-5.6' },
    { url: 'not-a-url', title: 'skipped' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endpoint, 'https://openai.com/a/');
  assert.equal(calls[1].endpoint, 'https://api.tavily.com/extract');
  assert.deepEqual(calls[1].body.urls, ['https://openai.com/a/']);
  assert.equal(calls[1].body.query, 'GPT-5.6');
  assert.equal(calls[1].body.chunks_per_source, 2);
  assert.equal(calls[1].body.extract_depth, 'basic');
  assert.deepEqual(pages, [
    { url: 'https://openai.com/a', body_text: 'GPT-5.6 body' },
    { url: 'https://openai.com/b', body_text: 'second body' },
  ]);
});

test('acquire：直连正文没有候选名时使用 Tavily Extract 补取相关正文', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init = {}) => {
    calls.push(String(endpoint));
    if (String(endpoint) === 'https://docs.example.com/models') {
      return { ok: true, status: 200, text: async () => '<html><body>模型文档目录</body></html>' };
    }
    return jsonResponse({ results: [{ url: 'https://docs.example.com/models', raw_content: 'Qwen-Image-2.1 is available through the official API.' }] });
  };
  const adapters = createIdentityVerificationAdapters({ fetchImpl, accessMode: 'keyed', searchApiKey: 'extract-key' });
  const pages = await adapters.acquireOfficialSources([
    { url: 'https://docs.example.com/models', title: 'Qwen-Image-2.1 Official' },
  ], { candidateName: 'Qwen-Image-2.1', candidateIdentityKeys: ['qwen-image-2.1'] });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('/extract'));
  assert.match(pages[0].body_text, /Qwen-Image-2\.1/);
});

test('acquire：无有效 urls 直接返回空数组且不发起请求', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return jsonResponse({ results: [], failed_results: [] }); };
  const adapters = createIdentityVerificationAdapters({ fetchImpl });
  assert.deepEqual(await adapters.acquireOfficialSources([{ url: 'nope' }]), []);
  assert.equal(called, 0);
});

test('acquire：extract 失败抛错', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'bad request' });
  const adapters = createIdentityVerificationAdapters({ fetchImpl, accessMode: 'keyed', searchApiKey: 'k' });
  await assert.rejects(
    () => adapters.acquireOfficialSources([{ url: 'https://openai.com/a' }]),
    /TAVILY_EXTRACT_FAILED/,
  );
});

// ── suggest：身份建议（requestStructuredJson 链路）───────────────

test('suggest：合法输出 → {ok,value}；input 按 candidate/pages(截断4000) 形状序列化', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push({ endpoint: String(endpoint), body: JSON.parse(init.body) });
    return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(VALID_SUGGESTION) }] });
  };
  const suggest = createIdentitySuggestAdapter({ provider: 'zhipu', model: 'glm-test', apiKey: 'zk', fetchImpl, timeoutMs: 1234 });
  const result = await suggest({
    candidate: { name: 'GPT-5.6', entity_type: 'model' },
    pages: [{ url: 'https://openai.com/a', body_text: 'x'.repeat(5000) }],
    instructions: '按规则判断',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, VALID_SUGGESTION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'https://open.bigmodel.cn/api/anthropic/v1/messages');
  assert.equal(calls[0].body.model, 'glm-test');
  assert.equal(calls[0].body.max_tokens, 2000);
  assert.equal(calls[0].body.system, '按规则判断');
  const input = JSON.parse(calls[0].body.messages[0].content);
  assert.deepEqual(input.candidate, { name: 'GPT-5.6', entity_type: 'model' });
  assert.equal(input.pages.length, 1);
  assert.equal(input.pages[0].url, 'https://openai.com/a');
  assert.equal(input.pages[0].body_text.length, 4000, 'body_text 截断到 4000 字符');
});

test('suggest：非法 JSON → ok:false（OUTPUT_INVALID，核验层归类 IDENTITY_AI_UNAVAILABLE）', async () => {
  const fetchImpl = async () => jsonResponse({ content: [{ type: 'text', text: 'not json at all' }] });
  const suggest = createIdentitySuggestAdapter({ provider: 'zhipu', apiKey: 'zk', fetchImpl });
  const result = await suggest({ candidate: { name: 'X', entity_type: 'model' }, pages: [], instructions: 'i' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDENTITY_SUGGEST_OUTPUT_INVALID');
});

test('suggest：合法 JSON 但结构非法 → ok:false（SCHEMA_INVALID）', async () => {
  const fetchImpl = async () => jsonResponse({ content: [{ type: 'text', text: '{"foo":1}' }] });
  const suggest = createIdentitySuggestAdapter({ provider: 'zhipu', apiKey: 'zk', fetchImpl });
  const result = await suggest({ candidate: { name: 'X', entity_type: 'model' }, pages: [], instructions: 'i' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDENTITY_SUGGEST_SCHEMA_INVALID');
});

test('suggest：缺 provider key → {ok:false} 且不发起请求', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return jsonResponse({}); };
  const suggest = createIdentitySuggestAdapter({ provider: 'zhipu', apiKey: '', fetchImpl });
  const result = await suggest({ candidate: { name: 'X' }, pages: [], instructions: 'i' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZHIPU_AUTH_REQUIRED');
  assert.equal(called, 0);
});

// ── 白名单与 resolution 级默认构造 ────────────────────────────────

test('identityAdapterOptionsOf 只透传白名单键', () => {
  const picked = identityAdapterOptionsOf({
    searchApiKey: 'sk', fetchImpl: async () => {}, timeoutMs: 5, accessMode: 'keyed', fallbackToKey: false,
    maxSearchResults: 3, searchDepth: 'basic', searchFallbackProvider: 'tavily', extractProvider: 'direct_fetch', extractFallbackProvider: 'tavily', extractDepth: 'basic', chunksPerSource: 2,
    provider: 'zhipu', model: 'm', apiKey: 'k',
    ledger: { evil: true }, registry: { evil: true }, identityLedger: { evil: true },
  });
  assert.deepEqual(Object.keys(picked).sort(), [
    'accessMode', 'apiKey', 'chunksPerSource', 'extractDepth', 'extractFallbackProvider', 'extractProvider', 'fallbackToKey', 'fetchImpl',
    'maxSearchResults', 'model', 'provider', 'searchApiKey', 'searchDepth', 'searchEngine', 'searchFallbackProvider',
    'searchProvider', 'timeoutMs', 'webSearchApiKey',
  ]);
});

test('resolveBatchCandidates 未注入 identityAdapters 时默认构造被采用（核验链路真实推进）', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push(String(endpoint));
    if (String(endpoint).includes('/web_search')) {
      return jsonResponse({ search_result: [{ link: 'https://example.com/test-model-x', title: 'Test Model X official', content: 'announcing Test Model X' }] });
    }
    return { ok: true, status: 200, text: async () => '<html><body>Test Model X is an official AI model you can call.</body></html>' };
  };
  const result = await resolveBatchCandidates(
    [{ name: 'Test Model X', detail_kind_hint: 'api_model', candidate_key: 'default-adapters-k1' }],
    {
      registry: { schema_version: 1, entries: {} },
      fetchImpl,
      webSearchApiKey: 'zhipu-search-test-key',
      identityContext: {
        snapshot: emptySnapshot(),
        policy: {
          vendor_aliases: { example: ['example'] },
          vendors: [{ vendor_key: 'example', families: [{ family: 'example', evidence: { url: 'https://example.com/models' } }] }],
        },
        policyRevision: 'policy-rev-mock',
        bridgeRevision: 'bridge-rev-mock',
        ledger: { reserve: () => ({ ok: true }) },
        suggestIdentity: async () => ({ ok: true, value: { ...VALID_SUGGESTION, vendor_key: 'example', identity: 'test-model-x' } }),
      },
      setIntakeOutcome: null,
    },
  );
  assert.deepEqual(calls, ['https://open.bigmodel.cn/api/paas/v4/web_search', 'https://example.com/test-model-x'], '默认适配器使用智谱搜索与官方正文直连');
  assert.equal(result.verification_blocked.length, 0);
  assert.equal(result.seeds.length, 1, '核验通过产出 api_model seed，而非秒失败 verification_blocked');
  assert.equal(result.seeds[0].model_key, 'example-test-model-x');
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].verdict.model_key, 'example-test-model-x');
});
