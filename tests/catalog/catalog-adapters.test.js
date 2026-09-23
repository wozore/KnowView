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
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async () => response({ results: [] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources.map(source => source.url), ['https://kling.ai/document-api']);
});

test('catalog acquire uses Tavily cleaned content and canonical URLs', async () => {
  let request;
  const result = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['price_rate'] },
    sources: [{ url: 'https://kling.ai/document-api/api/video/2-6`）', title: '2.6 API', excerpt: 'Price excerpt' }],
  }, {
    searchApiKey: 'tavily-key',
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return response({ results: [{ url: 'https://kling.ai/document-api/api/video/2-6', raw_content: '# Pricing\n1 unit per second' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/extract');
  assert.deepEqual(request.body.urls, ['https://kling.ai/document-api/api/video/2-6']);
  assert.equal(result.contents[0].content, '# Pricing\n1 unit per second');
});

test('catalog capability probe checks Tavily without invoking the extraction LLM', async () => {
  let calls = 0;
  const result = await probeCatalogCapabilities({
    apiKey: 'zhipu-key',
    searchApiKey: 'tavily-key',
    accessMode: 'keyed',
    fetchImpl: async () => { calls += 1; return response({ results: [{ url: 'https://docs.tavily.com', title: 'Docs', content: 'Tavily' }] }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.search_provider, 'tavily');
  assert.equal(result.extract_provider, 'tavily');
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
