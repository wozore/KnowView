'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/core/index');
const { planCatalogResearch } = require('../../src/catalog/core/index');
const { createCostLedger, researchCatalog, scopeKindsOfFields } = require('../../src/catalog/core/index');

function seed() {
  return {
    detail_kind: 'api_model', modality: 'video', name: 'Kling 2.6 Pro', vendor_name: '可灵', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro',
    placement: { new_group_title: 'Kling' },
    placement_decision: {
      vendor: 'kuaishou', family: 'kling-video', target_mode: 'create',
      target_level2_id: 'vendor-level2:kuaishou:kling', target_level2_title: 'Kling 视频生成模型',
    },
    known_fields: { theme: 'media' },
    discovery_sources: [{ url: 'https://kling.ai/official', kind: 'official_hint' }],
  };
}

function detailOnlyPlan() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou' });
  return planCatalogResearch(seed(), snapshot);
}

function adapters(overrides = {}) {
  return {
    discover: async ({ scope }) => ({ sources: [
      { url: 'https://kling.ai/official', title: 'Official', excerpt: 'Official facts' },
      { url: 'https://third-party.example/kling', title: 'Third party', excerpt: 'Untrusted' },
    ] }),
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: `Official page for ${source.url}: API available. Price is 1 credit. Maximum duration 10 seconds.` })) }),
    ...overrides,
  };
}

test('research keeps trusted official hosts, gathers sources, and tracks Tavily-only costs', async () => {
  const plan = detailOnlyPlan();
  const result = await researchCatalog(plan, adapters(), { limits: { search_queries: 2, pages: 4 } });
  assert.equal(result.ok, true);
  // seed 声明的 official_hint 无条件预置，discover 重复返回同 URL 时合并不重复。
  assert.deepEqual(result.official_sources.map(source => source.url), ['https://kling.ai/official']);
  assert.equal(result.cost.spent.search_queries, 1);
  assert.equal(result.cost.spent.pages, 1);
  assert.equal(result.cost.spent.extraction_calls, undefined);
});

test('missing release date reuses and prioritizes an existing model page without searching', async () => {
  const plan = detailOnlyPlan();
  const scope = plan.research_scopes.find(item => item.kind === 'detail');
  const modelUrl = 'https://kling.ai/models/kling-2-6-pro';
  const genericSources = ['https://kling.ai/official', 'https://kling.ai/pricing'].map(url => ({
    url, title: 'Official reference', discovered_for: [`detail:${scope.subject.key}`],
  }));
  let searchCalls = 0;
  let acquiredUrls = [];
  const result = await researchCatalog(plan, {
    discover: async () => { searchCalls += 1; return { sources: [] }; },
    acquire: async ({ sources }) => {
      acquiredUrls = sources.map(source => source.url);
      return { contents: [{
        url: modelUrl, updated_date: '2026-09-21', updated_date_kind: 'official_page_update', updated_date_field: 'dateModified',
      }] };
    },
  }, {
    limits: { search_queries: 0, pages: 1, responses_calls: 0, synthesis_calls: 0 },
    missingFields: ['detail.release_date'],
    existingResearch: {
      official_sources: [
        ...genericSources,
        { url: modelUrl, title: 'Kling 2.6 Pro', content: 'Saved model-specific official page', content_origin: 'direct_fetch', discovered_for: [`detail:${scope.subject.key}`] },
      ],
      completed_scopes: [`detail:${scope.subject.key}`],
      cost: { spent: {} },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(searchCalls, 0);
  assert.deepEqual(acquiredUrls, [modelUrl], 'model-specific date page gets the single available page slot');
  const source = result.official_sources.find(item => item.url === modelUrl);
  assert.deepEqual({ date: source.updated_date, kind: source.updated_date_kind, field: source.updated_date_field }, {
    date: '2026-09-21', kind: 'official_page_update', field: 'dateModified',
  });
  assert.deepEqual(result.research_progress.page_update_refetch_attempted_ids, [source.source_id]);
  assert.equal(result.cost.spent.search_queries, 0);
  assert.equal(result.cost.spent.pages, 1);
});

test('专属页面重抓仍无更新时间时下一次恢复重新搜索可用官方页面', async () => {
  const plan = detailOnlyPlan();
  const scope = plan.research_scopes.find(item => item.kind === 'detail');
  const detailRef = `detail:${scope.subject.key}`;
  const modelUrl = 'https://kling.ai/models/kling-2-6-pro';
  let searchCalls = 0;
  const result = await researchCatalog(plan, {
    discover: async () => { searchCalls += 1; return { sources: [] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({
      url: source.url, updated_date: '2026-09-21', updated_date_kind: 'official_page_update', updated_date_field: 'dateModified',
    })) }),
  }, {
    limits: { search_queries: 2, pages: 2, responses_calls: 0, synthesis_calls: 0 },
    missingFields: ['detail.release_date'],
    existingResearch: {
      official_sources: [{
        source_id: 'source-kling-model-page', url: modelUrl, title: 'Kling 2.6 Pro',
        content: 'Saved official model page', content_origin: 'direct_fetch', discovered_for: [detailRef],
      }],
      completed_scopes: [detailRef],
      research_progress: { completed_scopes: [detailRef], page_update_refetch_attempted_ids: ['source-kling-model-page'] },
      cost: { spent: { search_queries: 0, pages: 1 } },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(searchCalls, 2, '重抓过的专属页没有更新时间后，下一次恢复允许窄域与扩域搜索');
  assert.equal(result.cost.spent.search_queries, 2);
  assert.equal(result.cost.spent.pages, 2);
});

test('identity_verified sources become trust roots and keep authorization metadata', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:stepfun', vendor_key: 'stepfun' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:stepfun', vendor_key: 'stepfun' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:stepfun:step-audio', vendor_key: 'stepfun' });
  const seed = {
    detail_kind: 'api_model', modality: 'audio', name: 'StepAudio 3 Gen Preview', vendor_name: 'stepfun', vendor_key: 'stepfun',
    tool_key: 'stepaudio-3-gen-preview', placement: { existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:stepfun' }, existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:stepfun:step-audio' } },
    official_url: 'https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen',
    known_fields: { theme: 'general' },
    discovery_sources: [
      { url: 'https://x.com/StepFun_ai/status/2099916376274313630', kind: 'identity_verified', content_hash: 'sha256:x' },
      { url: 'https://example.com/discovered', kind: 'discovery' },
    ],
  };
  const plan = planCatalogResearch(seed, snapshot);
  const result = await researchCatalog(plan, {
    discover: async () => ({ sources: [] }),
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: `StepAudio 3 Gen official page. Free during launch. ${source.url}` })) }),
  }, { limits: { search_queries: 2, pages: 4 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.official_sources.map(source => source.url), [
    'https://x.com/StepFun_ai/status/2099916376274313630',
  ]);
  const xSource = result.official_sources.find(source => source.url.startsWith('https://x.com/'));
  assert.equal(xSource.kind, 'identity_verified');
  assert.equal(xSource.content_hash, 'sha256:x');
});

test('social trusted roots only accept exact identity-verified URLs', async () => {
  const plan = planCatalogResearch({
    ...seed(),
    official_url: 'https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen',
    discovery_sources: [{ url: 'https://x.com/StepFun_ai/status/2099916376274313630', kind: 'identity_verified' }],
  }, emptySnapshot());
  const result = await researchCatalog(plan, {
    discover: async () => ({ sources: [
      { url: 'https://x.com/StepFun_ai/status/2099916376274313630', title: 'Official', source_kind: 'official' },
      { url: 'https://x.com/Chinazhidx/all', title: 'Third party', source_kind: 'official' },
    ] }),
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official evidence' })) }),
  }, { limits: { search_queries: 4, pages: 4 } });
  assert.equal(result.ok, true);
  assert.ok(result.official_sources.some(source => source.url === 'https://x.com/StepFun_ai/status/2099916376274313630'));
  assert.equal(result.official_sources.some(source => source.url === 'https://x.com/Chinazhidx/all'), false);
});

test('plain search candidates never become trust roots on their own', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:stepfun', vendor_key: 'stepfun' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:stepfun', vendor_key: 'stepfun' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:stepfun:step-audio', vendor_key: 'stepfun' });
  const seed = {
    detail_kind: 'api_model', modality: 'audio', name: 'StepAudio 3 Gen Preview', vendor_name: 'stepfun', vendor_key: 'stepfun',
    tool_key: 'stepaudio-3-gen-preview', placement: { existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:stepfun' }, existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:stepfun:step-audio' } },
    official_url: 'https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen',
    known_fields: { theme: 'general' },
    discovery_sources: [{ url: 'https://rival-audio.example/stepaudio', kind: 'discovery' }],
  };
  const plan = planCatalogResearch(seed, snapshot);
  const result = await researchCatalog(plan, {
    discover: async () => ({ sources: [{ url: 'https://rival-audio.example/stepaudio', title: 'Looks official', excerpt: 'Price free', source_kind: 'official' }] }),
    acquire: async () => ({ contents: [] }),
  }, { limits: { search_queries: 2, pages: 4 } });
  assert.equal(result.ok, true);
  assert.equal(result.official_sources.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('已忽略')));
});

test('canonicalizes discovered URLs before trust and page budgeting', async () => {
  const plan = detailOnlyPlan();
  let acquireCalls = 0;
  const result = await researchCatalog(plan, adapters({
    discover: async () => ({ sources: [
      { url: 'https://kling.ai/document-api/apiReference/model/imageToVideo`）', title: 'Official', excerpt: 'Official facts' },
      { url: 'not-a-url', title: 'Invalid', excerpt: 'Ignore' },
    ] }),
    acquire: async ({ sources }) => {
      acquireCalls += 1;
      return { contents: sources.map(source => ({ url: source.url, content: 'API available. Price is 1 credit. Maximum duration 10 seconds.' })) };
    },
  }), { limits: { search_queries: 2, pages: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.official_sources.length, 2);
  assert.ok(result.official_sources.some(source => source.url === 'https://kling.ai/document-api/apiReference/model/imageToVideo'));
  assert.equal(result.cost.spent.pages, 2);
  assert.equal(acquireCalls, 1);
});

test('hard cost ledger stops before exceeding limits', async () => {
  let discoverCalls = 0;
  const plan = detailOnlyPlan();
  const result = await researchCatalog(plan, adapters({ discover: async () => { discoverCalls += 1; return { sources: [] }; } }), { limits: { search_queries: 0, pages: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_BUDGET_EXHAUSTED');
  assert.equal(result.category, 'search_queries');
  assert.equal(result.requested, 1);
  assert.equal(result.remaining, 0);
  assert.equal(discoverCalls, 0);
  assert.equal(result.cost.spent.search_queries, 0);
});

test('research without missingFields studies every active scope once', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const result = await researchCatalog(plan, adapters({
    discover: async ({ scope }) => { requested.push(scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  }), { limits: { search_queries: 4, pages: 8 } });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['vendor', 'group', 'detail']);
  assert.equal(result.official_sources.length, 4);
});

test('resume researches only scopes whose fields are still missing', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const localAdapters = adapters({
    discover: async ({ scope, domain_scope }) => { requested.push(domain_scope === 'registrant' ? `${scope.kind}:registrant` : scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  });
  const first = await researchCatalog(plan, localAdapters, { limits: { search_queries: 4, pages: 8 } });
  assert.equal(first.ok, true);
  requested.length = 0;
  const resumed = await researchCatalog(plan, localAdapters, {
    existingResearch: first,
    missingFields: ['detail.api_pricing'],
    // 镜像 assistant.resumeResearchLimits：恢复预算 = 已花 + 全新增量，扩宽轮消耗增量份额
    limits: { search_queries: first.cost.spent.search_queries + 4, pages: 8 },
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(requested, ['detail', 'detail:registrant']);
});

test('fresh research ignores stale field narrowing and covers every current scope', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const result = await researchCatalog(plan, {
    discover: async ({ scope, domain_scope }) => {
      requested.push(`${scope.kind}:${domain_scope || 'seed'}`);
      return { sources: [{ url: `https://kling.ai/${scope.kind}/${domain_scope || 'seed'}`, title: scope.kind, excerpt: 'Official fact.' }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official fact.' })) }),
  }, {
    missingFields: ['detail.release_date'],
    limits: { search_queries: 6, pages: 8 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, [
    'vendor:seed', 'vendor:registrant',
    'group:seed', 'group:registrant',
    'detail:seed', 'detail:registrant',
  ]);
});

test('resume adds newly required plan scopes to scopes selected by missing fields', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const vendor = plan.research_scopes.find(scope => scope.kind === 'vendor');
  const detail = plan.research_scopes.find(scope => scope.kind === 'detail');
  const requested = [];
  const result = await researchCatalog(plan, {
    discover: async ({ scope, domain_scope }) => {
      requested.push(`${scope.kind}:${domain_scope || 'seed'}`);
      return { sources: [{ url: `https://kling.ai/${scope.kind}/${domain_scope || 'seed'}`, title: scope.kind, excerpt: 'Official fact.' }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official fact.' })) }),
  }, {
    existingResearch: {
      official_sources: [{ url: 'https://kling.ai/official', title: 'Saved official page', content: 'Reusable body.', content_origin: 'direct_fetch' }],
      completed_scopes: [`${vendor.kind}:${vendor.subject.key}`, `${detail.kind}:${detail.subject.key}`],
      cost: { spent: {} },
    },
    missingFields: ['detail.release_date'],
    limits: { search_queries: 8, pages: 8 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['group:seed', 'group:registrant', 'detail:seed', 'detail:registrant']);
});

test('checkpoint without reusable body reruns all current scopes and retains cumulative spend', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const result = await researchCatalog(plan, {
    discover: async ({ scope, domain_scope }) => {
      requested.push(`${scope.kind}:${domain_scope || 'seed'}`);
      return { sources: [{ url: `https://kling.ai/${scope.kind}/${domain_scope || 'seed'}`, title: scope.kind, excerpt: 'Official fact.' }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official fact.' })) }),
  }, {
    existingResearch: {
      official_sources: [{ url: 'https://kling.ai/official', title: 'Metadata only' }],
      completed_scopes: plan.research_scopes.map(scope => `${scope.kind}:${scope.subject.key}`),
      cost: { spent: { search_queries: 3, pages: 0 } },
    },
    missingFields: ['detail.release_date'],
    limits: { search_queries: 9, pages: 8 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, [
    'vendor:seed', 'vendor:registrant',
    'group:seed', 'group:registrant',
    'detail:seed', 'detail:registrant',
  ]);
  assert.equal(result.cost.spent.search_queries, 9, 'saved spend remains charged while all current scopes are retried');
});

test('legacy Qwen release_date checkpoint re-fetches only its model page for update metadata', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:alibaba', vendor_key: 'alibaba' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:alibaba', vendor_key: 'alibaba', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:alibaba:qwen-audio' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:alibaba:qwen-audio', vendor_key: 'alibaba', detail_refs: [] });
  const pageUrl = 'https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-asr-flash-streaming';
  const plan = planCatalogResearch({
    detail_kind: 'api_model', modality: 'audio', name: 'Qwen Audio 3.1 ASR Flash Streaming',
    vendor_name: '阿里云', vendor_key: 'alibaba', tool_key: 'qwen-audio-3-1-asr-flash-streaming',
    model_key: 'alibaba-qwen-audio-3-1-asr-flash-streaming',
    placement: { existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:alibaba' }, existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:alibaba:qwen-audio' } },
    known_fields: { theme: 'general' }, discovery_sources: [{ url: pageUrl, kind: 'official_hint' }], official_url: pageUrl,
  }, snapshot);
  const detailScope = plan.research_scopes.find(scope => scope.kind === 'detail');
  const detailRef = `detail:${detailScope.subject.key}`;
  const modelPage = {
    source_id: 'source-qwen-model-page', url: pageUrl, title: 'Qwen Audio 3.1 ASR Flash Streaming', excerpt: 'Qwen Audio 3.1 ASR Flash Streaming official API.',
    content: 'Qwen Audio 3.1 ASR Flash Streaming official model page.', content_origin: 'direct_fetch', discovered_for: [detailRef],
  };
  const genericPage = {
    source_id: 'source-qwen-model-index', url: 'https://help.aliyun.com/zh/model-studio/models', title: 'Models',
    excerpt: 'Official model catalog.', content: 'Qwen Audio 3.1 ASR Flash Streaming appears in the official model index.',
    content_origin: 'direct_fetch', discovered_for: [detailRef], updated_date: '2026-09-23',
    updated_date_kind: 'official_page_update', updated_date_field: 'dateModified',
  };
  let acquiredUrls = [];
  const result = await researchCatalog(plan, {
    discover: async () => ({ sources: [modelPage, genericPage] }),
    acquire: async ({ sources }) => {
      acquiredUrls = sources.map(source => source.url);
      return { contents: sources.map(source => ({
        url: source.url, content: 'Qwen Audio 3.1 ASR Flash Streaming official model page refreshed.', content_origin: 'direct_fetch',
        updated_date: '2026-09-21', updated_date_kind: 'official_page_update', updated_date_field: 'lastModifiedTime',
      })) };
    },
  }, {
    existingResearch: {
      official_sources: [modelPage, genericPage],
      completed_scopes: [detailRef],
      cost: { spent: { search_queries: 1, pages: 2 } },
    },
    missingFields: ['detail.release_date'],
    limits: { search_queries: 6, pages: 5 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(acquiredUrls, [pageUrl]);
  const refreshed = result.official_sources.find(source => source.source_id === 'source-qwen-model-page');
  assert.equal(refreshed.updated_date, '2026-09-21');
  assert.equal(refreshed.updated_date_kind, 'official_page_update');
  assert.equal(refreshed.updated_date_field, 'lastModifiedTime');
  assert.equal(result.cost.spent.pages, 3, 'metadata refetch is charged to the existing page budget');
});

test('budget exhaustion preserves partial sources for a missing-field resume', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const localAdapters = adapters({
    discover: async ({ scope, domain_scope }) => { requested.push(domain_scope === 'registrant' ? `${scope.kind}:registrant` : scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  });
  const failed = await researchCatalog(plan, localAdapters, { limits: { search_queries: 2, pages: 1 } });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'COST_BUDGET_EXHAUSTED');
  assert.equal(failed.official_sources.length, 3);
  assert.deepEqual(requested, ['vendor', 'group']);

  requested.length = 0;
  const resumed = await researchCatalog(plan, localAdapters, {
    existingResearch: failed,
    missingFields: ['detail.api_pricing'],
    limits: { search_queries: failed.cost.spent.search_queries + 4, pages: 8 },
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(requested, ['detail', 'detail:registrant']);
});

test('discovery widens to registrant roots when the seed-scope pass finds nothing new', async () => {
  const subdomainSeed = {
    ...seed(),
    official_url: 'https://docs.kling.ai/model',
    discovery_sources: [{ url: 'https://docs.kling.ai/model', kind: 'official_hint' }],
  };
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou' });
  const plan = planCatalogResearch(subdomainSeed, snapshot);
  const scopes = [];
  const result = await researchCatalog(plan, {
    discover: async ({ domain_scope }) => {
      scopes.push(domain_scope || 'seed');
      if ((domain_scope || 'seed') === 'seed') return { sources: [{ url: 'https://third-party.example/kling', title: 'Third party', excerpt: 'Untrusted' }] };
      return { sources: [{ url: 'https://www.kling.ai/news/kling-2-6-pro-launch', title: 'Launch', excerpt: 'Official launch announcement.' }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official launch announcement. API available.' })) }),
  }, { limits: { search_queries: 4, pages: 4 } });
  assert.equal(result.ok, true);
  assert.deepEqual(scopes, ['seed', 'registrant']);
  assert.ok(result.official_sources.some(source => source.url === 'https://www.kling.ai/news/kling-2-6-pro-launch'), '同厂商主域来源应通过官方闸门');
  assert.equal(result.official_sources.some(source => source.url === 'https://third-party.example/kling'), false);
});

test('registrableHostOf widens vendor subdomains but not shared hosting roots', () => {
  const { registrableHostOf } = require('../../src/catalog/core/index');
  assert.equal(registrableHostOf('platform.openai.com'), 'openai.com');
  assert.equal(registrableHostOf('openai.com'), null);
  assert.equal(registrableHostOf('docs.kling.ai'), 'kling.ai');
  assert.equal(registrableHostOf('foo.github.io'), null);
  assert.equal(registrableHostOf(''), null);
});

test('official gate accepts vendor main domain once a subdomain hint exists', () => {
  const { officialRootsOf, isTrustedOfficialUrl } = require('../../src/catalog/core/index');
  const roots = officialRootsOf({
    official_url: 'https://platform.openai.com/docs',
    discovery_sources: [{ url: 'https://platform.openai.com/docs', kind: 'official_hint' }],
  });
  assert.ok(roots.includes('openai.com'));
  assert.equal(isTrustedOfficialUrl('https://openai.com/index/gpt-6-astra/', roots), true);
  assert.equal(isTrustedOfficialUrl('https://openai-competitor.example/index/gpt-6-astra/', roots), false);
});

test('scopeKindsOfFields maps fields to their owning layer scopes', () => {
  assert.deepEqual(scopeKindsOfFields(['detail.access_level', 'vendor.features', 'group.group_summary']).sort(), ['detail', 'group', 'vendor']);
  assert.deepEqual(scopeKindsOfFields(['detail.api_pricing']), ['detail']);
  assert.deepEqual(scopeKindsOfFields([]), []);
});

test('cost ledger reports deterministic remaining capacity', () => {
  const ledger = createCostLedger({ search_queries: 2, pages: 3 });
  assert.equal(ledger.reserve('search_queries', 1).ok, true);
  assert.equal(ledger.snapshot().remaining.search_queries, 1);
  assert.equal(ledger.reserve('search_queries', 2).ok, false);
  assert.equal(ledger.snapshot().spent.search_queries, 1);
});
