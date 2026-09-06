'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  finalizeSeriesBundle,
} = require('../../src/catalog/series/series-bundle-finalizer');
const {
  validateSeriesBundle,
  bundleTokenOf,
} = require('../../src/catalog/series/series-bundle-contract');
const {
  createDraft,
  deleteDraft,
  acquireBundlePrepareLock,
  releaseBundlePrepareLock,
} = require('../../src/catalog/draft/catalog-draft-store');
const {
  listCatalogBundles,
  readCatalogBundle,
  discardCatalogBundle,
  planCatalogBundles,
  prepareCatalogBundles,
} = require('../../src/catalog/draft/catalog-bundle');
const { emptySnapshot, revisionOf } = require('../../src/catalog/core');
const { loadSeriesPolicy } = require('../../src/catalog/series');
const { CATALOG_GENERATOR_FILES } = require('../../src/shared/paths');

function bundle() {
  return {
    schema_version: 1,
    bundle_id: 'bundle-0123456789ab',
    candidate: { candidate_key: 'series-candidate-1', name: 'GLM 5', entity_type: 'series' },
    vendor_key: 'zhipu',
    series: { level2_id: 'vendor-level2:zhipu:glm', title: 'GLM 5', series_kind: 'model_series', mode: 'existing' },
    members: [{
      name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', detail_id: 'tool-level3:glm-5-3',
      tool_card_id: 'tool-card:glm-5-3', classification: 'bundled',
    }],
    base_revisions: { catalog: 'catalog-r1', policy: 'policy-r1', bridge: 'bridge-r1' },
    layer_patches: [
      { area: 'vendor-level2', id: 'vendor-level2:zhipu:glm', operation: 'replace', record: { id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:glm-5-3' }] } },
      { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3' } },
      { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'create', record: { id: 'tool-card:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' } } },
    ],
    bridge_entries: [{
      model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu',
      detail_id: 'tool-level3:glm-5-3', tool_card_id: 'tool-card:glm-5-3', series_id: 'vendor-level2:zhipu:glm',
      official_url: 'https://docs.z.ai/glm', content_hash: 'sha256:member',
      verified_at: '2026-09-05T00:00:00.000Z', catalog_revision: 'catalog-r1',
    }],
    blockers: ['BUNDLE_MEMBERS_NEED_ENRICHMENT'],
    readiness: 'blocked',
  };
}

function enrichedPatches() {
  return [
    { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', summary: '官方完整资料' } },
    { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'create', record: { id: 'tool-card:glm-5-5-3', model_key: 'zhipu-glm-5-3' } },
  ];
}

test('离线富化成功后只在内存收口 future snapshot/readiness/hash/token', async () => {
  const input = bundle();
  const result = await finalizeSeriesBundle(input, {
    snapshot: { 'vendor-level2': [{ id: 'vendor-level2:zhipu:glm' }], 'tool-level3': [], 'tool-card': [] },
    memberEnrichment: { 'zhipu-glm-5-3': { ok: true, layer_patches: [
      { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', summary: '官方完整资料' } },
      { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'create', record: { id: 'tool-card:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' } } },
    ] } },
    validate: value => validateSeriesBundle(value, {}),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bundle.readiness, 'ready');
  assert.ok(result.bundle.future_snapshot['tool-level3'].some(record => record.id === 'tool-level3:glm-5-3'));
  assert.notEqual(result.bundle.preview_hash, undefined);
  assert.equal(result.bundle.bundle_token, bundleTokenOf(result.bundle));
  assert.equal(input.readiness, 'blocked', '输入 bundle 不被原地修改');
});

test('离线富化失败保持 blocked，不产生可 Apply 的部分结果', async () => {
  const result = await finalizeSeriesBundle(bundle(), {
    snapshot: { 'vendor-level2': [], 'tool-level3': [], 'tool-card': [] },
    memberEnrichment: { 'zhipu-glm-5-3': { ok: false, code: 'RESEARCH_FAILED' } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.bundle.readiness, 'blocked');
  assert.ok(result.bundle.blockers.includes('BUNDLE_MEMBERS_NEED_ENRICHMENT'));
  assert.ok(result.bundle.blockers.includes('BUNDLE_MEMBER_ENRICHMENT_FAILED'));
});

test('Bundle v4 生命周期不读取、列出或删除 v3 Draft', async () => {
  const outcomes = [];
  const oldDraft = createDraft({ schema_version: 3, draft_kind: 'catalog', state: 'preview_ready', base_revision: 'r1' });
  const bundleDraft = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_ready', base_revision: 'r1', bundle: bundle(), bundle_id: bundle().bundle_id, bundle_token: 'btk-test' });
  try {
    const listed = listCatalogBundles({ loadCatalog: () => ({ revision: 'r1', snapshot: {} }) });
    assert.ok(listed.items.some(item => item.draft_id === bundleDraft.draft_id));
    assert.ok(!listed.items.some(item => item.draft_id === oldDraft.draft_id));
    assert.equal(readCatalogBundle(oldDraft.draft_id).code, 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED');
    assert.equal((await discardCatalogBundle(oldDraft.draft_id, { expected_revision: 'r1' }, { loadCatalog: () => ({ revision: 'r1', snapshot: {} }) })).code, 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED');
    assert.equal((await discardCatalogBundle(bundleDraft.draft_id, { expected_revision: 'r1', allowBundleDiscard: true }, { loadCatalog: () => ({ revision: 'r1', snapshot: {} }), readPending: () => ({ revision: 'pending-r1', cards: [{ candidate_key: 'series-candidate-1', intake_outcome: 'bundled_for_review' }] }), setIntakeOutcome: async (...args) => { outcomes.push(args); return { revision: 'pending-r2' }; } })).ok, true);
    assert.equal(outcomes[0][2], 'pending');
    assert.equal(outcomes[0][3], 'pending-r1');
    assert.equal(outcomes[0][4].allowBundleDiscard, true);
  } finally {
    deleteDraft(oldDraft.draft_id);
    deleteDraft(bundleDraft.draft_id);
  }
});


test('cleanup_pending 恢复只收敛 pending 并删除 Draft，不重复提交', async () => {
  const input = bundle();
  const token = bundleTokenOf(input);
  const draft = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'cleanup_pending', base_revision: 'catalog-r2', bundle: input, bundle_id: input.bundle_id, bundle_token: token, apply_checkpoint: { committed_at: '2026-09-05T00:00:00.000Z', target_revision: 'catalog-r2' } });
  const outcomes = [];
  try {
    const result = await require('../../src/catalog/draft/catalog-bundle').applyCatalogBundle({
      draft_id: draft.draft_id, expected_revision: 'catalog-r2', bundle_token: token, confirm: `APPLY CATALOG BUNDLE ${token}`,
    }, {
      loadCatalog: () => ({ revision: 'catalog-r2', snapshot: {} }),
      readPending: () => ({ revision: 'pending-r1', cards: [] }),
      setIntakeOutcome: async (...args) => { outcomes.push(args); return { ok: true }; },
    });
    assert.equal(result.status, 'cleanup_only');
    assert.equal(result.cleanup_only, true);
    assert.equal(result.target_revision, 'catalog-r2');
    assert.equal(outcomes.length, 1);
    assert.throws(() => readCatalogBundle(draft.draft_id), /ENOENT/);
  } finally {
    try { deleteDraft(draft.draft_id); } catch {}
  }
});

test('prepare lock 只回收超 TTL 且 owner 已死亡的锁，活锁仍冲突', () => {
  const lockPath = path.join(CATALOG_GENERATOR_FILES.draftsDir, '.series-bundle-prepare.lock');
  fs.mkdirSync(CATALOG_GENERATOR_FILES.draftsDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ owner: 'dead-owner', run_id: 'dead-owner', pid: 2147483647, started_at: '2020-01-01T00:00:00.000Z' }));
  const recovered = acquireBundlePrepareLock();
  try { assert.notEqual(recovered.runId, 'dead-owner'); } finally { releaseBundlePrepareLock(recovered); }
  const active = acquireBundlePrepareLock();
  try { assert.throws(() => acquireBundlePrepareLock(), error => error.code === 'EEXIST'); } finally { releaseBundlePrepareLock(active); }
});

test('成员发现后先返回完整 enrichment hard-limit，未二次确认不调用富化', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', series_kind: 'model_series', detail_refs: [] });
  const card = { candidate_key: 'cost-confirm-series', name: 'GLM 5', entity_type: 'series', review_status: 'approved' };
  let enrichCalls = 0;
  const options = {
    readPending: () => ({ revision: 'pending-cost-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: loadSeriesPolicy(), bridgeFile: 'E:/Work/AI信息获取软件开发/.tmp-bundle-cost-bridge.json', setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({ series_candidates: [{ candidate_key: card.candidate_key, name: card.name, verdict: { entity_class: 'series', vendor_key: 'zhipu', model_key: 'zhipu-glm-5', series_title: 'GLM 5', evidence: { official_url: 'https://docs.z.ai/glm' }, reasons: ['official'] }, members: [{ name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', evidence: { official_url: 'https://docs.z.ai/glm' } }] }], verification_blocked: [], unresolved: [], intake_outcomes: [] }),
    enrichMember: async () => { enrichCalls += 1; return { ok: false, code: 'SHOULD_NOT_RUN' }; },
  };
  const planned = planCatalogBundles(options);
  const result = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
  assert.equal(result.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
  assert.ok(result.enrichment_confirmation_token);
  assert.deepEqual(result.enrichment_hard_limits, { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 });
  assert.equal(enrichCalls, 0);
});

test('重复与并发 prepare 复用同一个可复用 Bundle Draft', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', series_kind: 'model_series', detail_refs: [] });
  const card = { candidate_key: 'prepare-reuse-series', name: 'GLM 5', entity_type: 'series', review_status: 'approved' };
  const options = {
    readPending: () => ({ revision: 'pending-reuse-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: loadSeriesPolicy(),
    bridgeFile: 'E:/Work/AI信息获取软件开发/.tmp-bundle-no-bridge.json',
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: [{ candidate_key: card.candidate_key, name: card.name,
        verdict: { entity_class: 'series', vendor_key: 'zhipu', model_key: 'zhipu-glm-5', series_title: 'GLM 5', evidence: { official_url: 'https://docs.z.ai/glm', content_hash: 'sha256:series' }, reasons: ['official'] },
        members: [{ name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', evidence: { official_url: 'https://docs.z.ai/glm', content_hash: 'sha256:member' } }] }],
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    memberEnrichment: { 'zhipu-glm-5-3': { ok: true, layer_patches: [
      { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3' } },
      { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'create', record: { id: 'tool-card:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' } } },
    ] } },
  };
  const planned = planCatalogBundles(options);
  const input = { ...planned, confirm_cost: true };
  const [first, concurrent] = await Promise.all([prepareCatalogBundles(input, options), prepareCatalogBundles(input, options)]);
  try {
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(concurrent.ok, true, JSON.stringify(concurrent));
    assert.equal(first.drafts.length, 1);
    assert.equal(concurrent.drafts[0].draft_id, first.drafts[0].draft_id);
    const repeated = await prepareCatalogBundles(input, options);
    assert.equal(repeated.drafts[0].draft_id, first.drafts[0].draft_id);
  } finally {
    for (const item of first.drafts || []) deleteDraft(item.draft_id);
  }
});

test('二次确认后在同一个共享 ledger 累积富化消费并成功收口', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', series_kind: 'model_series', detail_refs: [] });
  const candidateKey = 'cost-ledger-' + Date.now();
  const card = { candidate_key: candidateKey, name: 'GLM 5', entity_type: 'series', review_status: 'approved' };
  const calls = [];
  const options = {
    readPending: () => ({ revision: 'pending-ledger-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: loadSeriesPolicy(), bridgeFile: 'E:/Work/AI信息获取软件开发/.tmp-bundle-ledger-bridge.json', setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({ series_candidates: [{ candidate_key: card.candidate_key, name: card.name, verdict: { entity_class: 'series', vendor_key: 'zhipu', model_key: 'zhipu-glm-5', series_title: 'GLM 5', evidence: { official_url: 'https://docs.z.ai/glm', content_hash: 'sha256:series' }, reasons: ['official'] }, members: [{ name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', evidence: { official_url: 'https://docs.z.ai/glm', content_hash: 'sha256:member' } }] }], verification_blocked: [], unresolved: [], intake_outcomes: [] }),
    enrichMember: async ({ seed }) => {
      calls.push(seed);
      return {
        ok: true,
        cost: { spent: { search_queries: 1, pages: 2, responses_calls: 2, synthesis_calls: 1 } },
        layer_patches: [
          { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', summary: '官方完整资料', official_url: 'https://docs.z.ai/glm' } },
          { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'create', record: { id: 'tool-card:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' }, official_url: 'https://docs.z.ai/glm' } },
        ],
      };
    },
  };
  const planned = planCatalogBundles(options);
  const first = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
  assert.equal(first.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
  const confirmed = await prepareCatalogBundles({
    ...planned,
    confirm_cost: true,
    enrichment_confirmation_token: first.enrichment_confirmation_token,
  }, options);
  try {
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    assert.equal(calls.length, 1);
    const draft = readCatalogBundle(confirmed.drafts[0].draft_id);
    assert.equal(draft.cost.enrichment.spent.search_queries, 1);
    assert.equal(draft.cost.enrichment.spent.pages, 2);
  } finally {
    for (const item of confirmed.drafts || []) deleteDraft(item.draft_id);
  }
});
