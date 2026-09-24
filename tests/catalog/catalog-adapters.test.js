'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('../../src/catalog/intake/index');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function plan() {
  return {
    seed: {
      name: 'Kling 2.6',
      vendor_name: '可灵',
      official_url: 'https://kling.ai',
      discovery_sources: [{ url: 'https://kling.ai/document-api', kind: 'official_hint' }],
    },
  };
}

test('catalog discovery propagates keyed Tavily mode without keyless headers', async () => {
  let request;
  const result = await discoverOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async (url, init) => {
      request = { url, headers: init.headers };
      return response({ results: [] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.headers.Authorization, 'Bearer tavily-key');
  assert.equal(request.headers['X-Tavily-Access-Mode'], undefined);
});

test('zhipu search uses only the dedicated Web Search key', async () => {
  let authorization;
  const result = await discoverOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available'],
  }, {
    searchProvider: 'zhipu_web_search',
    searchFallbackProvider: 'tavily',
    apiKey: 'deepseek-secret',
    webSearchApiKey: 'zhipu-search-key',
    fetchImpl: async (url, init) => {
      authorization = init.headers.Authorization;
      return response({ search_result: [{ link: 'https://kling.ai/docs', title: 'Docs', content: 'Kling official' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(authorization, 'Bearer zhipu-search-key');
});

test('catalog discovery fails closed before fetch when keyed Tavily key is missing', async () => {
  let calls = 0;
  const result = await discoverOfficialSources({
    plan: {
      seed: {
        name: 'Kling 2.6',
        vendor_name: '可灵',
        official_url: '',
        discovery_sources: [],
      },
    },
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: '',
    accessMode: 'keyed',
    fetchImpl: async () => { calls += 1; return response({ results: [] }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_AUTH_REQUIRED');
  assert.equal(calls, 0);
});

test('catalog discovery delegates official-domain filtering to Tavily', async () => {
  let request;
  const result = await discoverOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available', 'price_rate'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: 'tavily-key',
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return response({ results: [{ url: 'https://kling.ai/document-api/api/video/2-6', title: '2.6 API', content: 'Kling 2.6 API' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.deepEqual(request.body.include_domains, ['kling.ai']);
  assert.equal(result.sources[0].discovered_for, 'detail:kling-v2-6');
});

test('catalog discovery returns seed official URLs for direct extraction in detail scope', async () => {
  const result = await discoverOfficialSources({
    plan: {
      seed: {
        name: 'Augment Code',
        vendor_name: 'Augment Code',
        official_url: 'https://www.augmentcode.com/changelog/vs-code-0-496-1-release-notes',
        discovery_sources: [
          { url: 'https://docs.augmentcode.com/introduction', kind: 'official_hint' },
          { url: 'https://example.com/not-an-official-hint', kind: 'other' },
        ],
      },
    },
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'augment-code' } },
    missing_predicates: ['release_date'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async () => response({ results: [] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://www.augmentcode.com/changelog/vs-code-0-496-1-release-notes',
    'https://docs.augmentcode.com/introduction',
  ]);
  assert.equal(result.sources.every(source => source.discovered_for === 'detail:augment-code'), true);
});

test('catalog discovery includes identity_verified sources and excludes untrusted kinds', async () => {
  const result = await discoverOfficialSources({
    plan: {
      seed: {
        name: 'StepAudio 3 Gen',
        vendor_name: 'stepfun',
        official_url: 'https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen',
        discovery_sources: [
          { url: 'https://x.com/StepFun_ai/status/2099916376274313630', kind: 'identity_verified', content_hash: 'sha256:x' },
          { url: 'https://example.com/discovered', kind: 'discovery' },
        ],
      },
    },
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'stepaudio-3-gen' } },
    missing_predicates: ['price_rate'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async () => response({ results: [] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen',
    'https://x.com/StepFun_ai/status/2099916376274313630',
  ]);
});

test('catalog discovery does not force detail hints into parent scopes', async () => {
  const result = await discoverOfficialSources({
    plan: {
      seed: {
        name: 'Kling 2.6',
        vendor_name: '可灵',
        official_url: '',
        discovery_sources: [{ url: 'https://kling.ai/document-api', kind: 'official_hint', hint_kind: 'detail_only' }],
      },
    },
    scope: { kind: 'vendor', subject: { kind: 'vendor', key: 'kling' } },
    missing_predicates: ['vendor_features'],
  }, {
    searchProvider: 'tavily',
    searchFallbackProvider: 'tavily',
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async () => response({ results: [] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources.map(source => source.url), ['https://kling.ai/document-api']);
});

test('catalog acquire uses direct official fetch first and Tavily for unreadable pages', async () => {
  let request;
  const calls = [];
  const result = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['price_rate'] },
    sources: [{ url: 'https://kling.ai/document-api/api/video/2-6`）', title: '2.6 API', excerpt: 'Price excerpt' }],
  }, {
    searchApiKey: 'tavily-key',
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url).startsWith('https://kling.ai/')) return { ok: false, status: 503, text: async () => '' };
      request = { url, body: JSON.parse(init.body) };
      return response({ results: [{ url: 'https://kling.ai/document-api/api/video/2-6', raw_content: 'Kling 2.6 Pro official API pricing: 1 unit per second' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/extract');
  assert.deepEqual(request.body.urls, ['https://kling.ai/document-api/api/video/2-6']);
  assert.equal(result.contents[0].content, 'Kling 2.6 Pro official API pricing: 1 unit per second');
  assert.deepEqual(calls, ['https://kling.ai/document-api/api/video/2-6', 'https://api.tavily.com/extract']);
  assert.equal(result.contents[0].content_origin, 'tavily_extract');
});

test('catalog acquire skips Tavily when direct official fetch returns body text', async () => {
  const calls = [];
  const result = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['api_available'] },
    sources: [{ url: 'https://kling.ai/model', title: 'Kling 2.6' }],
  }, {
    fetchImpl: async url => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => '<html><body><h1>Kling 2.6</h1><p>Official API</p></body></html>' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contents[0].content_origin, 'direct_fetch');
  assert.match(result.contents[0].content, /Kling 2.6 Official API/);
  assert.deepEqual(calls, ['https://kling.ai/model']);
});

test('catalog acquire uses Tavily when a direct API-model page has no candidate name', async () => {
  const calls = [];
  const result = await acquireOfficialSources({
    plan: {
      ...plan(),
      seed: { ...plan().seed, detail_kind: 'api_model', name: 'Kling 2.6 Pro', vendor_key: 'kuaishou', model_key: 'kuaishou-kling-2.6-pro' },
    },
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-2-6-pro' }, predicates: ['api_available'] },
    sources: [{ url: 'https://kling.ai/models', title: 'Kling 2.6 Pro' }],
  }, {
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url) === 'https://kling.ai/models') return { ok: true, status: 200, text: async () => '<html><body>模型文档导航</body></html>' };
      return response({ results: [{ url: 'https://kling.ai/models', raw_content: 'Kling 2.6 Pro offers an official API.' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contents[0].content_origin, 'tavily_extract');
  assert.match(result.contents[0].content, /Kling 2\.6 Pro/);
  assert.deepEqual(calls, ['https://kling.ai/models', 'https://api.tavily.com/extract']);
});

test('catalog capability probe checks Tavily without invoking the extraction LLM', async () => {
  let calls = 0;
  const result = await probeCatalogCapabilities({
    apiKey: 'zhipu-key',
    searchApiKey: 'tavily-key',
    webSearchApiKey: 'zhipu-search-key',
    searchProvider: 'zhipu_web_search',
    accessMode: 'keyed',
    fetchImpl: async (_url, init) => { calls += 1; assert.equal(init.headers.Authorization, 'Bearer zhipu-search-key'); return response({ search_result: [{ link: 'https://docs.example.com', title: 'Docs', content: 'Web Search' }] }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.search_provider, 'zhipu_web_search');
  assert.equal(result.search_fallback_provider, 'tavily');
  assert.equal(result.extract_provider, 'direct_fetch');
  assert.equal(result.extract_fallback_provider, 'tavily');
  assert.equal(result.search_engine, 'search_std');
  assert.equal(result.access_mode, 'keyed');
  assert.equal(result.extraction_provider, 'zhipu');
  assert.equal(calls, 1);
});

test('single-pass adapter composition exposes discover/acquire/synthesize but no extract', () => {
  const adapters = createCatalogAiAdapters({});
  assert.equal(typeof adapters.discover, 'function');
  assert.equal(typeof adapters.acquire, 'function');
  assert.equal(typeof adapters.synthesize, 'function');
  assert.equal(adapters.extract, undefined);
  assert.equal(adapters.manages_response_budget, undefined);
});
