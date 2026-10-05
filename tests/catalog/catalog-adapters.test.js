'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('../../src/catalog/intake/index');
const { fetchOfficialSources } = require('../../src/catalog/intake/official-source-fetch');

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

test('official HTML update metadata covers JSON-LD, OpenGraph, semantic time and visible dates', async () => {
  const cases = [
    ['JSON-LD dateModified', '<script type="application/ld+json">{"@type":"Product","dateModified":"2026-09-22T01:00:00+08:00"}</script><body>Kling 2.6</body>', '2026-09-22', 'dateModified'],
    ['article modified metadata', '<meta property="article:modified_time" content="2026-09-21T00:30:00Z"><body>Kling 2.6</body>', '2026-09-21', 'article:modified_time'],
    ['OpenGraph updated metadata', '<meta property="og:updated_time" content="2026-09-22"><body>Kling 2.6</body>', '2026-09-22', 'og:updated_time'],
    ['semantic time datetime', '<time itemprop="dateModified" datetime="2026-09-22T01:00:00+08:00">Updated</time><body>Kling 2.6</body>', '2026-09-22', 'time.datetime'],
    ['visible Updated at', '<body>Kling 2.6 · Updated at: 2026-09-21</body>', '2026-09-21', 'visible_updated_at'],
  ];
  for (const [label, html, date, field] of cases) {
    const result = await fetchOfficialSources([{ url: 'https://kling.ai/model' }], {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    });
    assert.equal(result.ok, true, label);
    assert.equal(result.pages[0].updated_date, date, label);
    assert.equal(result.pages[0].updated_date_kind, 'official_page_update', label);
    assert.equal(result.pages[0].updated_date_field, field, label);
  }
});

test('official source fetch ignores HTTP Date headers as update evidence', async () => {
  const result = await fetchOfficialSources([{ url: 'https://kling.ai/models' }], {
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'date' ? 'Mon, 21 Sep 2026 00:00:00 GMT' : null },
      text: async () => '<html><body>Models</body></html>',
    }),
  });
  assert.equal(result.ok, true);
  assert.equal('updated_date' in result.pages[0], false);
});

test('catalog discovery sends official-domain search only through Zhipu Web Search', async () => {
  let request;
  const result = await discoverOfficialSources({
    plan: plan(), scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available', 'price_rate'],
  }, {
    webSearchApiKey: 'zhipu-search-key',
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body), headers: init.headers };
      return response({ search_result: [{ link: 'https://kling.ai/document-api/api/video/2-6', title: '2.6 API', content: 'Kling 2.6 API' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(request.headers.Authorization, 'Bearer zhipu-search-key');
  assert.equal(request.body.search_domain_filter, 'kling.ai');
  assert.equal(result.sources[0].discovered_for, 'detail:kling-v2-6');
});

test('catalog discovery returns declared official hints and records search failure', async () => {
  const result = await discoverOfficialSources({
    plan: plan(), scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available'],
  }, {
    webSearchApiKey: 'zhipu-search-key',
    fetchImpl: async () => response({ error: 'unavailable' }, false, 503),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sources[0].url, 'https://kling.ai/');
  assert.equal(result.search_error.code, 'ZHIPU_WEB_SEARCH_FAILED');
});

test('catalog discovery fails closed when search fails and there are no declared official URLs', async () => {
  const result = await discoverOfficialSources({
    plan: { seed: { name: 'Unknown', vendor_name: 'Unknown', official_url: '', discovery_sources: [] } },
    scope: { kind: 'vendor', subject: { kind: 'vendor', key: 'unknown' } },
    missing_predicates: ['vendor_features'],
  }, {
    webSearchApiKey: 'zhipu-search-key',
    fetchImpl: async () => response({ error: 'unavailable' }, false, 503),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZHIPU_WEB_SEARCH_FAILED');
});

test('official source acquisition uses direct fetch and records unreadable pages as failed', async () => {
  const result = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['api_available'] },
    sources: [{ url: 'https://kling.ai/models', title: 'Kling 2.6' }],
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body><h1>Kling 2.6</h1><p>Official API</p></body></html>' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.contents[0].content_origin, 'direct_fetch');
  assert.match(result.contents[0].content, /Kling 2.6 Official API/);

  const failed = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['api_available'] },
    sources: [{ url: 'https://kling.ai/blocked', title: 'Kling 2.6' }],
  }, { fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'OFFICIAL_SOURCE_FETCH_FAILED');
  assert.ok(failed.failed.some(item => item.error === 'HTTP_403'));
});

test('detail metadata-only fetch requires a model-specific URL when HTML has no identity', async () => {
  const input = {
    plan: {
      ...plan(),
      seed: { ...plan().seed, detail_kind: 'api_model', name: 'Kling 2.6 Pro', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro', model_key: 'kuaishou-kling-2-6-pro' },
    },
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-2-6-pro' }, predicates: ['release_date'] },
  };
  const html = '<script>window.model={"lastModifiedTime":1790010126000}</script><div id="root"></div>';
  const modelPage = await acquireOfficialSources({
    ...input, sources: [{ url: 'https://kling.ai/models/kling-2-6-pro', title: 'Kling model' }],
  }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
  assert.equal(modelPage.ok, true);
  assert.equal(modelPage.contents[0].updated_date, '2026-09-21');
  assert.equal(modelPage.contents[0].content, undefined);

  const genericPage = await acquireOfficialSources({
    ...input, sources: [{ url: 'https://kling.ai/models', title: 'Models' }],
  }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
  assert.equal(genericPage.ok, false);
  assert.equal(genericPage.contents, undefined);
});

test('catalog capability probe checks Zhipu Web Search without invoking synthesis', async () => {
  let calls = 0;
  const result = await probeCatalogCapabilities({
    apiKey: 'zhipu-key', webSearchApiKey: 'zhipu-search-key',
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init.headers.Authorization, 'Bearer zhipu-search-key');
      return response({ search_result: [{ link: 'https://docs.example.com', title: 'Docs', content: 'Web Search' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.search_provider, 'zhipu_web_search');
  assert.equal(result.extract_provider, 'direct_fetch');
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
