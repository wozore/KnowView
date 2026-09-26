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
  updateDraft,
  deleteDraft,
  listDrafts,
  readDraft,
  draftPath,
  acquireBundlePrepareLock,
  releaseBundlePrepareLock,
} = require('../../src/catalog/draft/catalog-draft-store');
const {
  listCatalogBundles,
  readCatalogBundle,
  discardCatalogBundle,
  planCatalogBundles,
  prepareCatalogBundles,
  projectBundleDraft,
  reviewCatalogBundle,
  applyCatalogBundle,
} = require('../../src/catalog/draft/catalog-bundle');
const { emptySnapshot, revisionOf } = require('../../src/catalog/core');
const { loadSeriesPolicy, planSeriesBundle, bundlePreviewHashOf } = require('../../src/catalog/series');
const { createCatalogWorkbench } = require('../../src/catalog/catalog-workbench');
const { fingerprint } = require('../../src/catalog/draft/catalog-bundle-retry');
const { reconcileBundlePatchOperations } = require('../../src/catalog/draft/catalog-bundle-prepare');
const { CATALOG_GENERATOR_FILES } = require('../../src/shared/paths');
const { readModelIdentityBridge } = require('../../src/shared/model-identity-bridge');

function bundle() {
  return {
    schema_version: 1,
    bundle_id: 'bundle-0123456789ab',
    candidate: { candidate_key: 'series-candidate-1', name: 'GLM 5', entity_type: 'series' },
    vendor_key: 'zhipu',
    series: { level2_id: 'vendor-level2:zhipu:glm', title: 'GLM 5', series_kind: 'model_series', mode: 'existing' },
    members: [{
      name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', detail_id: 'tool-level3:glm-5-3',
      tool_card_id: 'tool-card:glm-5-3', classification: 'bundled', task_types: ['LLM'],
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

function modalityPolicy(modalities) {
  const taskType = modality => `Fixture ${modality}`;
  const usageKind = modality => modality === 'audio' ? 'audio_realtime' : modality;
  return {
    vendors: [{
      vendor_key: 'fixture',
      families: modalities.map(modality => ({
        family: `fixture_${modality}`,
        usage_kind: usageKind(modality),
        modality,
        series_kind: 'model_series',
        task_types: [taskType(modality)],
        series: [{
          id: `vendor-level2:fixture:${modality}`,
          title: `Fixture ${modality}`,
          generation_state: 'newest',
          expected_members: [],
          search_terms: [],
        }],
      })),
    }],
    task_type_registry: Object.fromEntries(modalities.map(modality => [taskType(modality), { aliases: [], usage_kind: usageKind(modality) }])),
    capacity: { visible_members: 6 },
  };
}

function enrichmentPatches(seed) {
  const detailId = `tool-level3:${seed.detail_key}`;
  const officialUrl = seed.official_url || 'https://fixture.example/model';
  return [
    { area: 'tool-level3', id: detailId, operation: 'create', record: {
      id: detailId, model_key: seed.model_key, title: seed.name, vendor_key: seed.vendor_key,
      detail_kind: 'api_model', official_url: officialUrl, summary: 'Fixture model', task_types: seed.task_types,
    } },
    { area: 'tool-card', id: `tool-card:${seed.tool_key}`, operation: 'create', record: {
      id: `tool-card:${seed.tool_key}`, model_key: seed.model_key, title: seed.name,
      vendor_key: seed.vendor_key, detail_kind: 'api_model', official_url: officialUrl,
      detail_ref: { kind: 'tool-level3', id: detailId }, task_types: seed.task_types,
    } },
  ];
}

test('Bundle DTO exposes safe per-member diagnostics without research content or raw sources', () => {
  const dto = projectBundleDraft({
    schema_version: 4,
    draft_id: 'bundle-safe-dto',
    draft_kind: 'series_bundle',
    state: 'preview_blocked',
    bundle: {
      candidate: { candidate_key: 'candidate-safe', name: 'Safe series' },
      members: [{
        name: 'Safe member', model_key: 'fixture-safe-member', classification: 'bundled',
        enrichment: {
          status: 'failed',
          missing_fields: ['summary'],
          research: {
            official_sources: [{ url: 'https://fixture.example?token=RAW_SECRET', content: 'RAW_SECRET' }],
            missing_fields: ['summary'],
            private_content: 'RAW_SECRET',
          },
          last_error: {
            code: 'SYNTHESIS_SCHEMA_INVALID', error: 'RAW_SECRET', research_error: 'RAW_SECRET',
            content: 'RAW_SECRET', missing_fields: ['summary'], official_source_count: 1,
          },
        },
      }],
      enrichment_errors: [{
        model_key: 'fixture-safe-member', code: 'SYNTHESIS_SCHEMA_INVALID', error: 'RAW_SECRET',
        research_error: 'RAW_SECRET', official_sources: [{ content: 'RAW_SECRET' }], official_source_count: 1,
      }],
      blockers: ['BUNDLE_MEMBERS_NEED_ENRICHMENT'],
    },
  });
  assert.equal(dto.members[0].enrichment_status, 'failed');
  assert.deepEqual(dto.members[0].missing_fields, ['summary']);
  assert.equal(dto.members[0].official_source_count, 1);
  assert.equal(dto.members[0].has_reusable_research, true);
  assert.equal(dto.enrichment_errors[0].code, 'SYNTHESIS_SCHEMA_INVALID');
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes('RAW_SECRET'), false);
  assert.equal(serialized.includes('official_sources'), false);
  assert.equal(serialized.includes('private_content'), false);
});

function plannedFixtureAudioBundle(candidateKey, memberDefs, snapshot, policy) {
  const name = 'Fixture audio series';
  const planned = planSeriesBundle({
    candidate: { candidate_key: candidateKey, name, entity_type: 'series', modality: 'audio' },
    verdict: { entity_class: 'series', vendor_key: 'fixture', model_key: 'fixture-audio-series', series_title: name, evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:fixture-series' } },
    subModelVerdicts: memberDefs,
    policy,
    snapshot,
    bridgeRevision: null,
    now: new Date('2026-09-26T00:00:00.000Z'),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  return planned.bundle;
}

test('成员研究只覆盖 Bundle 投影后的成员层，缺少目标补丁时零外部调用', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:fixture', vendor_key: 'fixture', title: 'Fixture' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:fixture', vendor_key: 'fixture', title: 'Fixture', level2_refs: [] });
  const policy = modalityPolicy(['audio']);
  const member = { name: 'Fixture Audio Member', model_key: 'fixture-audio-member', evidence: { official_url: 'https://fixture.example/audio' } };
  const planned = plannedFixtureAudioBundle(`bundle-member-plan-${Date.now()}`, [member], snapshot, policy);
  const current = planned.members[0];
  let capturedPlan;
  let providerCalls = 0;
  const adapters = {
    discover: async ({ scope }) => {
      providerCalls += 1;
      return { sources: [{ url: 'https://fixture.example/audio', title: scope.kind, excerpt: 'Official model page.' }] };
    },
    acquire: async ({ sources }) => {
      providerCalls += 1;
      return { contents: sources.map(source => ({ url: source.url, content: 'Official model page.' })) };
    },
    synthesize: async input => {
      providerCalls += 1;
      capturedPlan = input.plan;
      assert.deepEqual(Object.keys(input.expected_layer_fields), ['detail']);
      return { ok: false, code: 'FIXTURE_SYNTHESIS_STOP' };
    },
  };
  const result = await finalizeSeriesBundle(planned, { snapshot, adapters, validate: () => ({ ok: true, blockers: [] }) });
  assert.equal(result.ok, false);
  assert.equal(capturedPlan.layer_plan['vendor-level2'].operation, 'noop');
  assert.deepEqual(capturedPlan.research_scopes.map(scope => scope.kind), ['detail']);
  assert.ok(providerCalls > 0);

  for (const missing of [
    ['vendor-level2', planned.series.level2_id],
    ['tool-card', current.tool_card_id],
  ]) {
    const invalid = JSON.parse(JSON.stringify(planned));
    invalid.layer_patches = invalid.layer_patches.filter(patch => patch.area !== missing[0] || patch.id !== missing[1]);
    let invalidCalls = 0;
    const blocked = await finalizeSeriesBundle(invalid, {
      snapshot,
      adapters: {
        discover: async () => { invalidCalls += 1; return { sources: [] }; },
        acquire: async () => { invalidCalls += 1; return { contents: [] }; },
        synthesize: async () => { invalidCalls += 1; return { ok: false, code: 'SHOULD_NOT_RUN' }; },
      },
      validate: () => ({ ok: true, blockers: [] }),
    });
    assert.ok(blocked.bundle.enrichment_errors.some(error => error.code === 'BUNDLE_MEMBER_PATCH_MISSING'));
    assert.equal(invalidCalls, 0);
  }
});

function setStoredDraftUpdatedAt(draftId, updatedAt) {
  const file = draftPath(draftId);
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...draft, updated_at: updatedAt }, null, 2)}\n`, 'utf8');
}

test('prepare 将解析出的 audio/image/video modality 传入规划和成员富化', async () => {
  const modalities = ['audio', 'image', 'video'];
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const cards = modalities.map(modality => ({
    candidate_key: `bundle-modality-${suffix}-${modality}`,
    name: `Fixture ${modality} series`,
    entity_type: 'series',
    review_status: 'approved',
  }));
  const seriesCandidates = modalities.map((modality, index) => ({
    candidate_key: cards[index].candidate_key,
    name: cards[index].name,
    modality,
    verdict: {
      entity_class: 'series', vendor_key: 'fixture',
      model_key: `fixture-${modality}-series`, series_title: cards[index].name,
      evidence: { official_url: `https://fixture.example/${modality}`, content_hash: `sha256:fixture-${modality}-series` },
    },
    members: [{
      name: `Fixture ${modality} member`, model_key: `fixture-${modality}-member`,
      evidence: { official_url: `https://fixture.example/${modality}`, content_hash: `sha256:fixture-${modality}-member` },
    }],
  }));
  const capturedSeeds = [];
  const options = {
    readPending: () => ({ revision: 'pending-modality-r1', cards }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: modalityPolicy(modalities),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-modality-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: seriesCandidates,
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ seed }) => {
      capturedSeeds.push(seed);
      return { ok: true, layer_patches: enrichmentPatches(seed) };
    },
  };
  let prepared;
  try {
    const planned = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...planned, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.deepEqual(capturedSeeds.map(seed => seed.modality).sort(), [...modalities].sort());
    assert.deepEqual(prepared.drafts.map(draft => draft.series.profile_modality).sort(), [...modalities].sort());
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('prepare 为每个成员独立保留已确认额度并在逐成员完成后持久化 checkpoint', async () => {
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const card = {
    candidate_key: `bundle-member-checkpoint-${suffix}`,
    name: 'Fixture audio series', entity_type: 'series', review_status: 'approved',
  };
  const modelKeys = ['fixture-audio-member-a', 'fixture-audio-member-b'];
  const options = {
    readPending: () => ({ revision: 'pending-member-checkpoint-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: modalityPolicy(['audio']),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-member-checkpoint-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: [{
        candidate_key: card.candidate_key, name: card.name, modality: 'audio',
        verdict: { entity_class: 'series', vendor_key: 'fixture', model_key: 'fixture-audio-series', series_title: card.name },
        members: modelKeys.map((model_key, index) => ({
          name: `Fixture audio member ${index ? 'B' : 'A'}`, model_key,
          evidence: { official_url: 'https://fixture.example/audio' },
        })),
      }],
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ bundle: current, member, seed, limits }) => {
      assert.deepEqual(limits, { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 });
      const calls = listDrafts({ schema_version: 4, draft_kind: 'series_bundle' })
        .filter(draft => draft.bundle?.candidate?.candidate_key === card.candidate_key);
      if (member.model_key === modelKeys[1]) {
        assert.equal(calls.length, 1, '首次开始富化前已创建唯一 Draft');
        assert.equal(calls[0].state, 'enriching');
        assert.equal(calls[0].bundle.members.find(item => item.model_key === modelKeys[0]).enrichment.status, 'ready');
        assert.deepEqual(calls[0].bundle.members.find(item => item.model_key === modelKeys[0]).enrichment.cost, {
          total_spent: { search_queries: 2 }, last_attempt_spent: { search_queries: 2 }, uncertain_spent: {},
        });
      }
      assert.equal(current.bundle_id, calls[0]?.bundle.bundle_id || current.bundle_id);
      if (member.model_key === modelKeys[1]) return { ok: false, code: 'FIXTURE_MEMBER_FAILED', cost: { spent: { search_queries: 1 } } };
      return {
        ok: true,
        cost: { spent: { search_queries: 2 } },
        layer_patches: enrichmentPatches(seed),
      };
    },
  };
  let prepared;
  try {
    const planned = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...planned, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.ok, false, JSON.stringify(prepared));
    assert.equal(prepared.status, 'bundles_blocked');
    assert.deepEqual(prepared.counts, { ready: 0, blocked: 1, blocked_drafts: 1, blocked_candidates: 0 });
    const stored = listDrafts({ schema_version: 4, draft_kind: 'series_bundle' })
      .find(draft => draft.bundle?.candidate?.candidate_key === card.candidate_key);
    assert.equal(stored.state, 'preview_blocked');
    const [ready, failed] = modelKeys.map(key => stored.bundle.members.find(member => member.model_key === key));
    assert.equal(ready.enrichment.status, 'ready');
    assert.equal(failed.enrichment.status, 'failed');
    assert.equal(stored.bundle.cost.enrichment.spent.search_queries, 3, JSON.stringify(stored.bundle.members.map(item => ({ key: item.model_key, cost: item.enrichment?.cost }))));
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('prepare mixed Bundle results report accurate ready and blocked counts', async () => {
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const cards = ['ready', 'blocked'].map(kind => ({
    candidate_key: `bundle-mixed-${suffix}-${kind}`,
    name: `Fixture ${kind} audio series`, entity_type: 'series', review_status: 'approved',
  }));
  const options = {
    readPending: () => ({ revision: `pending-bundle-mixed-${suffix}`, cards }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: modalityPolicy(['audio']),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-mixed-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: cards.map((card, index) => ({
        candidate_key: card.candidate_key, name: card.name, modality: 'audio',
        verdict: {
          entity_class: 'series', vendor_key: 'fixture', model_key: `fixture-audio-series-${index}`,
          series_title: card.name, evidence: { official_url: 'https://fixture.example/audio', content_hash: `sha256:mixed-series-${index}` },
        },
        members: [{
          name: `Fixture ${index ? 'blocked' : 'ready'} audio member`, model_key: `fixture-audio-mixed-${suffix}-${index}`,
          evidence: { official_url: 'https://fixture.example/audio', content_hash: `sha256:mixed-member-${index}` },
        }],
      })),
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ seed }) => seed.name.includes('blocked')
      ? { ok: false, code: 'FIXTURE_MEMBER_FAILED', missing_fields: ['summary'] }
      : { ok: true, layer_patches: enrichmentPatches(seed) },
  };
  let prepared;
  try {
    const planned = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...planned, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.status, 'bundles_mixed');
    assert.deepEqual(prepared.counts, { ready: 1, blocked: 1, blocked_drafts: 1, blocked_candidates: 0 });
    assert.equal(prepared.drafts.filter(draft => draft.readiness.status === 'ready').length, 1);
    assert.equal(prepared.drafts.filter(draft => draft.readiness.status !== 'ready').length, 1);
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('prepare 混合身份阶段阻断候选与 ready Bundle 时区分是否已生成 Draft', async () => {
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const cards = ['ready', 'identity-blocked'].map(kind => ({
    candidate_key: `bundle-stage-mixed-${suffix}-${kind}`,
    name: `Fixture ${kind} audio series`, entity_type: 'series', review_status: 'approved',
  }));
  const options = {
    readPending: () => ({ revision: `pending-bundle-stage-mixed-${suffix}`, cards }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: modalityPolicy(['audio']),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-stage-mixed-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: [{
        candidate_key: cards[0].candidate_key, name: cards[0].name, modality: 'audio',
        verdict: {
          entity_class: 'series', vendor_key: 'fixture', model_key: 'fixture-audio-stage-series',
          series_title: cards[0].name, evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:stage-series' },
        },
        members: [{
          name: 'Fixture stage-ready audio member', model_key: `fixture-audio-stage-${suffix}`,
          evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:stage-member' },
        }],
      }],
      verification_blocked: [{ candidate_key: cards[1].candidate_key, name: cards[1].name, code: 'IDENTITY_EVIDENCE_MISSING' }],
      unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ seed }) => ({ ok: true, layer_patches: enrichmentPatches(seed) }),
  };
  let prepared;
  try {
    const plan = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...plan, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.status, 'bundles_mixed');
    assert.deepEqual(prepared.counts, { ready: 1, blocked: 1, blocked_drafts: 0, blocked_candidates: 1 });
    assert.equal(prepared.blocked[0].code, 'IDENTITY_EVIDENCE_MISSING');
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('最新同版本 Bundle 被 list/plan 共用，旧 ready review/apply 与相同时间冲突均 fail-closed', async () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-latest-selection-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const member = {
    name: 'Fixture latest audio member', model_key: `fixture-audio-latest-${suffix}`,
    evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:latest-member' },
  };
  const planned = plannedFixtureAudioBundle(candidateKey, [member], snapshot, policy);
  planned.retry_source_fingerprint = fingerprint(card);
  const finalized = await finalizeSeriesBundle(planned, {
    snapshot, policy, bridgeRevision: null,
    enrichMember: async ({ seed }) => ({ ok: true, layer_patches: enrichmentPatches(seed) }),
    validate: value => validateSeriesBundle(value, { snapshot, policy, bridgeRevision: null }),
  });
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  const readyBundle = finalized.bundle;
  const readyDraft = createDraft({
    schema_version: 4, draft_kind: 'series_bundle', state: 'preview_ready',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle: readyBundle, bundle_id: readyBundle.bundle_id, bundle_token: readyBundle.bundle_token,
    readiness: { status: 'ready', blocking_reasons: [] },
  });
  const blockedBundle = JSON.parse(JSON.stringify(readyBundle));
  blockedBundle.members[0].enrichment.status = 'failed';
  blockedBundle.members[0].enrichment.last_error = { code: 'SYNTHESIS_SCHEMA_INVALID', missing_fields: ['summary'] };
  blockedBundle.enrichment_errors = [{ model_key: member.model_key, name: member.name, code: 'SYNTHESIS_SCHEMA_INVALID', missing_fields: ['summary'] }];
  blockedBundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  blockedBundle.readiness = 'blocked';
  blockedBundle.preview_hash = bundlePreviewHashOf(blockedBundle);
  blockedBundle.bundle_token = bundleTokenOf(blockedBundle);
  const blockedDraft = createDraft({
    schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle: blockedBundle, bundle_id: blockedBundle.bundle_id, bundle_token: blockedBundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: blockedBundle.blockers },
  });
  setStoredDraftUpdatedAt(readyDraft.draft_id, '2026-09-26T00:00:00.000Z');
  setStoredDraftUpdatedAt(blockedDraft.draft_id, '2026-09-26T00:01:00.000Z');
  assert.equal(listDrafts({ schema_version: 4, draft_kind: 'series_bundle' }).filter(draft => draft.bundle?.candidate?.candidate_key === candidateKey).length, 2);
  const options = {
    readPending: () => ({ revision: `pending-latest-selection-${suffix}`, cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-latest-selection-${suffix}.json`),
    setIntakeOutcome: null,
  };
  try {
    assert.equal(listCatalogBundles(options).items.filter(item => item.candidate?.candidate_key === candidateKey).length, 2);
    const workbench = createCatalogWorkbench(options);
    const listed = workbench.bundleList();
    const selected = listed.items.filter(item => item.candidate?.candidate_key === candidateKey);
    assert.deepEqual(selected.map(item => item.draft_id), [blockedDraft.draft_id], JSON.stringify(listed));
    assert.equal(selected[0].state, 'preview_blocked');
    const plan = planCatalogBundles(options);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.retry_summary.draft_ids[0], blockedDraft.draft_id);
    assert.deepEqual(plan.work[0].retry.superseded_draft_ids, [readyDraft.draft_id]);

    const oldReview = reviewCatalogBundle(readyDraft.draft_id, options);
    assert.equal(oldReview.code, 'BUNDLE_DRAFT_SUPERSEDED');
    const oldApply = await applyCatalogBundle({
      draft_id: readyDraft.draft_id, expected_revision: revisionOf(snapshot), bundle_token: readyDraft.bundle_token,
      confirm: `APPLY CATALOG BUNDLE ${readyDraft.bundle_token}`,
    }, options);
    assert.equal(oldApply.code, 'BUNDLE_DRAFT_SUPERSEDED');
    assert.equal(readDraft(readyDraft.draft_id).state, 'preview_ready', 'superseded file is retained and not applied');

    updateDraft(blockedDraft.draft_id, { state: 'enriching' }, 'latest-selection-enriching');
    setStoredDraftUpdatedAt(blockedDraft.draft_id, '2026-09-26T00:02:00.000Z');
    assert.equal(readDraft(blockedDraft.draft_id).state, 'enriching');
    assert.equal(workbench.bundleList().items.find(item => item.candidate?.candidate_key === candidateKey).state, 'enriching', JSON.stringify(workbench.bundleList()));
    assert.equal(planCatalogBundles(options).retry_summary.draft_ids[0], blockedDraft.draft_id);

    setStoredDraftUpdatedAt(readyDraft.draft_id, '2026-09-26T00:03:00.000Z');
    setStoredDraftUpdatedAt(blockedDraft.draft_id, '2026-09-26T00:03:00.000Z');
    const ambiguousPlan = planCatalogBundles(options);
    assert.equal(ambiguousPlan.ok, false);
    assert.equal(ambiguousPlan.code, 'BUNDLE_DRAFT_DUPLICATE');
    const ambiguousList = workbench.bundleList();
    assert.deepEqual(ambiguousList.items.filter(item => item.candidate?.candidate_key === candidateKey), []);
    assert.equal(ambiguousList.selection_errors.find(error => error.candidate_key === candidateKey).code, 'BUNDLE_DRAFT_DUPLICATE');
    assert.equal(reviewCatalogBundle(readyDraft.draft_id, options).code, 'BUNDLE_DRAFT_DUPLICATE');
    const ambiguousApply = await applyCatalogBundle({
      draft_id: readyDraft.draft_id, expected_revision: revisionOf(snapshot), bundle_token: readyDraft.bundle_token,
      confirm: `APPLY CATALOG BUNDLE ${readyDraft.bundle_token}`,
    }, options);
    assert.equal(ambiguousApply.code, 'BUNDLE_DRAFT_DUPLICATE');
  } finally {
    deleteDraft(readyDraft.draft_id);
    deleteDraft(blockedDraft.draft_id);
  }
});

test('ready Bundle 的 intake outcome 写失败只返回 warning，不计为阻断候选', async () => {
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const card = {
    candidate_key: `bundle-outcome-warning-${suffix}`,
    name: 'Fixture outcome warning audio series', entity_type: 'series', review_status: 'approved',
  };
  const memberKey = `fixture-audio-outcome-${suffix}`;
  const options = {
    readPending: () => ({ revision: `pending-bundle-outcome-warning-${suffix}`, cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: modalityPolicy(['audio']),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-outcome-warning-${suffix}.json`),
    resolveBatchCandidates: async () => ({
      series_candidates: [{
        candidate_key: card.candidate_key, name: card.name, modality: 'audio',
        verdict: {
          entity_class: 'series', vendor_key: 'fixture', model_key: `fixture-audio-outcome-series-${suffix}`,
          series_title: card.name, evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:outcome-series' },
        },
        members: [{
          name: 'Fixture outcome warning audio member', model_key: memberKey,
          evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:outcome-member' },
        }],
      }],
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ seed }) => ({ ok: true, layer_patches: enrichmentPatches(seed) }),
    setIntakeOutcome: async () => { throw Object.assign(new Error('fixture pending update failure'), { code: 'PENDING_OUTCOME_WRITE_FAILED' }); },
  };
  let prepared;
  try {
    const plan = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...plan, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.status, 'bundles_ready');
    assert.deepEqual(prepared.counts, { ready: 1, blocked: 0, blocked_drafts: 0, blocked_candidates: 0 });
    assert.deepEqual(prepared.blocked, []);
    assert.deepEqual(prepared.warnings, [{ candidate_key: card.candidate_key, name: card.name, code: 'PENDING_OUTCOME_WRITE_FAILED' }]);
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('synthesize 中断后研究 checkpoint 可复用且只累计本轮成本增量', async () => {
  const input = bundle();
  input.members[0].evidence = { official_url: 'https://docs.z.ai/glm' };
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:zhipu', vendor_key: 'zhipu', title: '智谱 AI' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱 AI', level2_refs: [{ kind: 'vendor-level2', id: input.series.level2_id }] });
  snapshot['vendor-level2'].push({ id: input.series.level2_id, vendor_key: 'zhipu', detail_refs: [{ kind: 'tool-level3', id: input.members[0].detail_id }] });
  const counters = { discover: 0, acquire: 0, synthesize: 0 };
  const adapters = {
    discover: async () => {
      counters.discover += 1;
      return { ok: true, sources: [{ url: 'https://docs.z.ai/glm', title: 'GLM official' }] };
    },
    acquire: async ({ sources }) => {
      counters.acquire += sources.length;
      return { ok: true, contents: sources.map(source => ({ url: source.url, content: 'Official model documentation.' })) };
    },
    synthesize: async ({ ledger }) => {
      counters.synthesize += 1;
      assert.equal(ledger.reserve('responses_calls', 1).ok, true);
      assert.equal(ledger.reserve('synthesis_calls', 1).ok, true);
      throw Object.assign(new Error('fixture synthesis interruption'), { code: 'SYNTHESIS_INTERRUPTED' });
    },
  };
  const first = await finalizeSeriesBundle(input, { snapshot, adapters });
  assert.equal(first.ok, false);
  const second = await finalizeSeriesBundle(first.bundle, { snapshot, adapters });
  assert.equal(second.ok, false);
  assert.equal(counters.discover, 1, '成员研究只发现 detail scope，第二次复用已保存的研究');
  assert.equal(counters.synthesize, 2);
  const member = second.bundle.members[0];
  assert.equal(member.enrichment.cost.total_spent.responses_calls, 2);
  assert.equal(member.enrichment.cost.last_attempt_spent.responses_calls, 1, '本轮增量不重复计算累计值');
  assert.equal(member.enrichment.cost.last_attempt_spent.search_queries, 0);
  assert.equal(second.bundle.cost.enrichment.spent.responses_calls, 2);
});

test('blocked Bundle 原位重试只重跑失败成员并复用其研究 checkpoint', async () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-retry-one-member-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const memberDefs = [
    { name: 'Fixture audio member A', model_key: 'fixture-audio-member-a', evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:fixture-a' } },
    { name: 'Fixture audio member B', model_key: 'fixture-audio-member-b', evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:fixture-b' } },
  ];
  const bundle = plannedFixtureAudioBundle(candidateKey, memberDefs, snapshot, policy);
  const [readyMember, failedMember] = bundle.members;
  const readySeed = {
    detail_key: readyMember.detail_id.slice('tool-level3:'.length),
    tool_key: readyMember.tool_card_id.slice('tool-card:'.length),
    model_key: readyMember.model_key, name: readyMember.name, vendor_key: 'fixture',
    official_url: readyMember.evidence.official_url,
  };
  for (const patch of enrichmentPatches(readySeed)) {
    const index = bundle.layer_patches.findIndex(item => item.area === patch.area && item.id === patch.id);
    bundle.layer_patches[index] = patch;
  }
  const readyLimits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  const failedLimits = { search_queries: 5, pages: 10, responses_calls: 10, synthesis_calls: 2 };
  const readySpent = { search_queries: 2, pages: 1, responses_calls: 1, synthesis_calls: 1 };
  const failedSpent = { search_queries: 3, pages: 1, responses_calls: 1, synthesis_calls: 1 };
  readyMember.enrichment = { status: 'ready', attempts: 1, limits: readyLimits,
    cost: { total_spent: readySpent, last_attempt_spent: readySpent, uncertain_spent: {} }, research: null, missing_fields: [], last_error: null };
  failedMember.enrichment = {
    status: 'failed', attempts: 1, limits: failedLimits,
    cost: { total_spent: failedSpent, last_attempt_spent: failedSpent, uncertain_spent: {} },
    research: { ok: true, official_sources: [{ url: 'https://fixture.example/audio', title: 'fixture', content: 'saved official text' }], warnings: [],
      completed_scopes: ['vendor', 'group', 'detail'], research_progress: { completed_scopes: ['vendor', 'group', 'detail'], failed_scope: null },
      missing_fields: [], cost: { limits: failedLimits, spent: failedSpent, remaining: { search_queries: 2, pages: 9, responses_calls: 9, synthesis_calls: 1 } } },
    missing_fields: [], last_error: { code: 'SYNTHESIS_SCHEMA_INVALID' },
  };
  bundle.enrichment_hard_limits = { search_queries: 8, pages: 18, responses_calls: 18, synthesis_calls: 3 };
  bundle.cost.enrichment = { limits: bundle.enrichment_hard_limits,
    spent: { search_queries: 5, pages: 2, responses_calls: 2, synthesis_calls: 2 },
    remaining: { search_queries: 3, pages: 16, responses_calls: 16, synthesis_calls: 1 } };
  bundle.enrichment_errors = [{ model_key: failedMember.model_key, name: failedMember.name, code: 'SYNTHESIS_SCHEMA_INVALID' }];
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = require('../../src/catalog/series/series-bundle-contract').bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  let resolveCalls = 0;
  const enrichCalls = [];
  const options = {
    readPending: () => ({ revision: 'pending-retry-member-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-retry-member-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => { resolveCalls += 1; throw new Error('retry must not resolve identity'); },
    enrichMember: async ({ member, seed, existingResearch, limits }) => {
      enrichCalls.push(member.model_key);
      assert.equal(member.model_key, failedMember.model_key);
      assert.equal(existingResearch.official_sources[0].content, 'saved official text');
      assert.equal(seed.modality, 'audio');
      assert.deepEqual(limits, failedLimits);
      return { ok: true, layer_patches: enrichmentPatches(seed) };
    },
  };
  try {
    const plan = planCatalogBundles(options);
    assert.equal(plan.work[0].kind, 'retry');
    assert.deepEqual(plan.retry_summary.failed_members.map(member => member.model_key), [failedMember.model_key]);
    assert.equal(plan.retry_summary.requires_confirmation, false);
    const result = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(resolveCalls, 0);
    assert.deepEqual(enrichCalls, [failedMember.model_key]);
    assert.equal(result.drafts[0].draft_id, stored.draft_id);
    const saved = listDrafts({ schema_version: 4, draft_kind: 'series_bundle' }).find(item => item.draft_id === stored.draft_id);
    assert.equal(saved.state, 'preview_ready', JSON.stringify({ blockers: saved.bundle.blockers, errors: saved.bundle.enrichment_errors, readiness: saved.readiness }));
    assert.ok(saved.bundle.members.every(member => member.enrichment.status === 'ready'));
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('Qwen Audio 旧 Bundle 修复过期 patch 与缺失 Voice 标签后可通过审核预览', async () => {
  const snapshot = emptySnapshot();
  snapshot['vendor-level1'].push({ id: 'vendor-level1:alibaba', vendor_key: 'alibaba', title: '阿里云', level2_refs: [] });
  const policy = loadSeriesPolicy();
  const suffix = Date.now();
  const bridgeFile = path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-qwen-recovery-${suffix}.json`);
  const bridgeRevision = readModelIdentityBridge(bridgeFile).revision;
  const card = { candidate_key: `bundle-qwen-recovery-${suffix}`, name: 'Qwen-Audio-3.1', entity_type: 'series', review_status: 'approved' };
  const officialUrl = 'https://help.aliyun.com/zh/model-studio/models';
  const planned = planSeriesBundle({
    candidate: { candidate_key: card.candidate_key, name: card.name, entity_type: 'series', modality: 'audio' },
    verdict: { entity_class: 'series', vendor_key: 'alibaba', model_key: 'alibaba-qwen-audio-3-1', series_title: card.name, family: 'qwen_audio', modality: 'audio', evidence: { official_url: officialUrl, content_hash: 'sha256:qwen-series' } },
    subModelVerdicts: [
      { name: 'qwen-audio-3.1-asr-flash-streaming', model_key: 'alibaba-qwen-audio-3.1-asr-flash-streaming', evidence: { official_url: officialUrl, content_hash: 'sha256:stream' } },
      { name: 'qwen-audio-3.1-asr-flash-filetrans', model_key: 'alibaba-qwen-audio-3.1-asr-flash-filetrans', evidence: { official_url: officialUrl, content_hash: 'sha256:file' } },
      { name: 'qwen-audio-3.1-realtime-plus', model_key: 'alibaba-qwen-audio-3.1-realtime-plus', evidence: { official_url: officialUrl, content_hash: 'sha256:voice' } },
    ],
    policy, snapshot, bridgeRevision, now: new Date('2026-09-26T00:00:00.000Z'),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const bundle = planned.bundle;
  const realtime = bundle.members.find(member => member.name.includes('realtime'));
  delete realtime.task_types;
  for (const patch of bundle.layer_patches) {
    if (patch.id === realtime.detail_id || patch.id === realtime.tool_card_id) delete patch.record.task_types;
    if (patch.id === 'tool-level3:qwen-audio-3-1-asr-flash-filetrans'
      || patch.id === 'tool-card:qwen-audio-3-1-asr-flash-filetrans') patch.operation = 'replace';
  }
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  const spent = { search_queries: 0, pages: 0, responses_calls: 0, synthesis_calls: 0 };
  for (const member of bundle.members) {
    const detailKey = member.detail_id.slice('tool-level3:'.length);
    const missingFields = [];
    member.enrichment = {
      status: 'ready', attempts: 1, limits,
      cost: { total_spent: spent, last_attempt_spent: spent, uncertain_spent: {} },
      research: {
        ok: true,
        official_sources: [{ url: officialUrl, title: 'Aliyun Model Studio', content: 'Saved official model research.', content_origin: 'direct_fetch' }],
        completed_scopes: [`detail:${detailKey}`], missing_fields: missingFields, cost: { spent },
      },
      missing_fields: missingFields, last_error: null,
    };
  }
  bundle.enrichment_hard_limits = { search_queries: 9, pages: 24, responses_calls: 24, synthesis_calls: 3 };
  bundle.cost.enrichment = { limits: bundle.enrichment_hard_limits, spent: {}, remaining: bundle.enrichment_hard_limits };
  bundle.enrichment_errors = bundle.members.map(member => ({ model_key: member.model_key, name: member.name, code: 'BUNDLE_BRIDGE_PROJECTION_MISSING', missing_fields: [] }));
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: card.candidate_key, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  const calls = [];
  const options = {
    readPending: () => ({ revision: `pending-qwen-recovery-${suffix}`, cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy, bridgeFile,
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => { throw new Error('retry must not repeat identity verification'); },
    enrichMember: async ({ member, seed }) => {
      calls.push({ name: member.name, task_types: seed.task_types });
      return { ok: true, layer_patches: enrichmentPatches(seed) };
    },
  };
  try {
    const plan = planCatalogBundles(options);
    assert.equal(plan.work[0].kind, 'retry');
    assert.equal(plan.retry_summary.projection_repair, true);
    assert.deepEqual(plan.retry_summary.incremental_limits, {});
    const prepared = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(calls.length, 0, '桥接投影修复复用已完成的合成结果，不重复调用模型');
    const saved = readDraft(stored.draft_id);
    assert.equal(saved.state, 'preview_ready');
    assert.equal(saved.bundle.layer_patches.find(patch => patch.id === 'tool-level3:qwen-audio-3-1-asr-flash-filetrans').operation, 'create');
    assert.deepEqual(saved.bundle.members.find(member => member.name.includes('realtime')).task_types, ['Voice']);
    assert.equal(reviewCatalogBundle(stored.draft_id, options).ok, true);
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('只读重试计划过滤旧 group 缺口但保留 detail 日期缺口和相应预算', () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-retry-stale-group-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const definitions = [
    { name: 'Group-only member', model_key: `fixture-group-only-${suffix}`, evidence: { official_url: 'https://fixture.example/audio' } },
    { name: 'Release-date member', model_key: `fixture-release-date-${suffix}`, evidence: { official_url: 'https://fixture.example/audio' } },
  ];
  const bundle = plannedFixtureAudioBundle(candidateKey, definitions, snapshot, policy);
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  const spent = { search_queries: 3, pages: 8, responses_calls: 7, synthesis_calls: 0 };
  const groupFields = ['group.group_summary', 'group.group_official_url', 'group.group_status'];
  const fieldsByMember = [groupFields, [...groupFields, 'detail.release_date']];
  const combinedSpent = { search_queries: 0, pages: 0, responses_calls: 0, synthesis_calls: 0 };
  bundle.members.forEach((member, index) => {
    const missingFields = fieldsByMember[index];
    const lastError = { code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: missingFields };
    for (const key of Object.keys(combinedSpent)) combinedSpent[key] += spent[key];
    member.enrichment = {
      status: 'failed', attempts: 1, limits,
      cost: { total_spent: spent, last_attempt_spent: spent, uncertain_spent: {} },
      research: {
        ok: true,
        official_sources: [{ url: 'https://fixture.example/audio', content: 'Saved official page.', content_origin: 'direct_fetch' }],
        missing_fields: missingFields, completed_scopes: ['detail:fixture'], cost: { spent },
      },
      missing_fields: missingFields,
      last_error: lastError,
    };
  });
  bundle.enrichment_hard_limits = { search_queries: 6, pages: 16, responses_calls: 16, synthesis_calls: 2 };
  bundle.cost.enrichment = { limits: bundle.enrichment_hard_limits, spent: combinedSpent,
    remaining: { search_queries: 0, pages: 0, responses_calls: 2, synthesis_calls: 2 } };
  bundle.enrichment_errors = bundle.members.map((member, index) => ({
    model_key: member.model_key, name: member.name, code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: fieldsByMember[index],
  }));
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  const options = {
    readPending: () => ({ revision: `pending-retry-stale-group-${suffix}`, cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-retry-stale-group-${suffix}.json`),
    setIntakeOutcome: null,
  };
  try {
    const before = readDraft(stored.draft_id);
    const plan = planCatalogBundles(options);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const members = new Map(plan.retry_summary.failed_members.map(member => [member.model_key, member]));
    const budgets = new Map(plan.work[0].retry.member_plans.map(member => [member.model_key, member]));
    const groupOnly = members.get(bundle.members[0].model_key);
    const releaseMissing = members.get(bundle.members[1].model_key);
    const groupBudget = budgets.get(bundle.members[0].model_key);
    const releaseBudget = budgets.get(bundle.members[1].model_key);
    assert.deepEqual(groupOnly.missing_fields, []);
    assert.deepEqual(groupOnly.error.missing_fields, []);
    assert.equal(groupBudget.incremental_limits.search_queries, 0);
    assert.equal(groupBudget.incremental_limits.pages, 0);
    assert.deepEqual(releaseMissing.missing_fields, ['detail.release_date']);
    assert.deepEqual(releaseMissing.error.missing_fields, ['detail.release_date']);
    assert.equal(releaseBudget.incremental_limits.search_queries, 2);
    assert.equal(releaseBudget.incremental_limits.pages, 2);
    assert.deepEqual(plan.retry_summary.incremental_limits, { search_queries: 2, pages: 2, responses_calls: 0, synthesis_calls: 0 });
    assert.equal(readDraft(stored.draft_id).updated_at, before.updated_at);
    assert.deepEqual(readDraft(stored.draft_id).bundle.members[0].enrichment.missing_fields, groupFields,
      '只读计划不得改写存储的旧诊断');
    assert.deepEqual(readDraft(stored.draft_id).bundle.members[0].enrichment.last_error.missing_fields, groupFields);
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('更新时间缺口复用模型专属官方页面时只预留一次页面额度', () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-retry-date-page-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const name = 'Kling 2.6 Pro';
  const modelKey = 'fixture-kling-2-6-pro';
  const bundle = plannedFixtureAudioBundle(candidateKey, [{ name, model_key: modelKey, evidence: { official_url: 'https://fixture.example/audio' } }], snapshot, policy);
  const member = bundle.members[0];
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  const spent = { search_queries: 3, pages: 8, responses_calls: 1, synthesis_calls: 0 };
  const detailScope = 'detail:kling-2-6-pro';
  member.enrichment = {
    status: 'failed', attempts: 1, limits,
    cost: { total_spent: spent, last_attempt_spent: spent, uncertain_spent: {} },
    research: {
      ok: true,
      official_sources: [{ url: 'https://fixture.example/models/kling-2-6-pro', content: 'Saved official detail page', content_origin: 'direct_fetch', discovered_for: [detailScope] }],
      completed_scopes: [detailScope], missing_fields: ['detail.release_date'], cost: { spent },
    },
    missing_fields: ['detail.release_date'],
    last_error: { code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: ['detail.release_date'] },
  };
  bundle.enrichment_hard_limits = limits;
  bundle.cost.enrichment = { limits, spent, remaining: { search_queries: 0, pages: 0, responses_calls: 7, synthesis_calls: 1 } };
  bundle.enrichment_errors = [{ model_key: modelKey, name, code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: ['detail.release_date'] }];
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  try {
    const plan = planCatalogBundles({
      readPending: () => ({ revision: `pending-date-page-${suffix}`, cards: [card] }),
      loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
      bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-date-page-${suffix}.json`),
      setIntakeOutcome: null,
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(plan.retry_summary.incremental_limits, { search_queries: 0, pages: 1, responses_calls: 0, synthesis_calls: 0 });
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('恢复前依据当前 snapshot 修正 create/replace patch 操作', () => {
  const input = {
    layer_patches: [
      { area: 'tool-level3', id: 'tool-level3:missing', operation: 'replace', record: { id: 'tool-level3:missing' } },
      { area: 'vendor-level1', id: 'vendor-level1:existing', operation: 'create', record: { id: 'vendor-level1:existing' } },
    ],
  };
  const result = reconcileBundlePatchOperations(input, {
    'tool-level3': [],
    'vendor-level1': [{ id: 'vendor-level1:existing' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(input.layer_patches.map(patch => patch.operation), ['create', 'replace']);
});

test('legacy blocked Bundle 先要求增量确认，且旧确认绑定 Draft 更新时间和版本', async () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-retry-legacy-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const [memberDef] = [{ name: 'Fixture audio member', model_key: 'fixture-audio-member', evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:fixture-a' } }];
  const bundle = plannedFixtureAudioBundle(candidateKey, [memberDef], snapshot, policy);
  const member = bundle.members[0];
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  bundle.enrichment_hard_limits = limits;
  bundle.cost.enrichment = { limits, spent: { ...limits }, remaining: { search_queries: 0, pages: 0, responses_calls: 0, synthesis_calls: 0 } };
  bundle.enrichment_errors = [{ model_key: member.model_key, name: member.name, code: 'COST_BUDGET_EXHAUSTED' }];
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = require('../../src/catalog/series/series-bundle-contract').bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  let externalCalls = 0;
  const options = {
    readPending: () => ({ revision: 'pending-retry-legacy-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-retry-legacy-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => { externalCalls += 1; throw new Error('must not resolve identity'); },
    enrichMember: async () => { externalCalls += 1; return { ok: false, code: 'SHOULD_NOT_RUN' }; },
  };
  try {
    const plan = planCatalogBundles(options);
    assert.equal(plan.retry_summary.requires_confirmation, true);
    assert.deepEqual(plan.retry_summary.incremental_limits, limits);
    const unchanged = listDrafts({ schema_version: 4, draft_kind: 'series_bundle' }).find(item => item.draft_id === stored.draft_id);
    const request = { ...plan, confirm_cost: true };
    const required = await prepareCatalogBundles(request, options);
    assert.equal(required.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    assert.equal(required.enrichment_confirmation_token, plan.retry_confirmation_token);
    assert.equal(externalCalls, 0);
    assert.equal(listDrafts({ schema_version: 4, draft_kind: 'series_bundle' }).find(item => item.draft_id === stored.draft_id).updated_at, unchanged.updated_at);
    const invalid = await prepareCatalogBundles({ ...request, enrichment_confirmation_token: 'expired-token' }, options);
    assert.equal(invalid.code, 'ENRICHMENT_CONFIRMATION_INVALID');
    assert.equal(externalCalls, 0);
    updateDraft(stored.draft_id, { last_error: { code: 'MANUAL_CHANGE' } }, 'retry-test-touch');
    await assert.rejects(prepareCatalogBundles({ ...request, enrichment_confirmation_token: plan.retry_confirmation_token }, options), error => error.code === 'PLAN_CHANGED');
    const newerSnapshot = emptySnapshot();
    newerSnapshot['vendor-level1'].push({ id: 'vendor-level1:revision-change', vendor_key: 'revision-change', title: 'Revision change', level2_refs: [] });
    const staleOptions = { ...options, loadCatalog: () => ({ revision: revisionOf(newerSnapshot), snapshot: newerSnapshot }) };
    await assert.rejects(prepareCatalogBundles({ ...request, enrichment_confirmation_token: plan.retry_confirmation_token }, staleOptions), error => error.code === 'REVISION_CONFLICT');
    assert.equal(externalCalls, 0);
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('旧 Qwen Audio Bundle 根据当前 SeriesPolicy 恢复 audio profile 后同 Draft 重研', async () => {
  const snapshot = emptySnapshot();
  const policy = loadSeriesPolicy();
  const suffix = Date.now();
  const card = { candidate_key: `legacy-qwen-audio-${suffix}`, name: 'Qwen-Audio 3.1', entity_type: 'series', review_status: 'approved' };
  const officialUrl = 'https://help.aliyun.com/zh/model-studio/models';
  const planned = planSeriesBundle({
    candidate: { candidate_key: card.candidate_key, name: card.name, entity_type: 'series', modality: 'omni' },
    verdict: { entity_class: 'series', vendor_key: 'alibaba', model_key: 'alibaba-qwen-audio-3-1', series_title: card.name, family: 'qwen_audio', modality: 'omni', evidence: { official_url: officialUrl, content_hash: 'sha256:fixture-series' } },
    subModelVerdicts: [{ name: 'Qwen Audio 3.1 ASR Flash Streaming', model_key: 'alibaba-qwen-audio-3-1-asr-flash-streaming', evidence: { official_url: officialUrl, content_hash: 'sha256:fixture-member' } }],
    policy, snapshot, bridgeRevision: null, now: new Date('2026-09-26T00:00:00.000Z'),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const bundle = planned.bundle;
  delete bundle.series.profile_modality;
  delete bundle.members[0].profile_modality;
  bundle.candidate.modality = 'omni';
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  bundle.enrichment_hard_limits = limits;
  bundle.cost.enrichment = { limits, spent: {}, remaining: limits };
  bundle.enrichment_errors = [{ model_key: bundle.members[0].model_key, name: bundle.members[0].name, code: 'SOURCE_RESOLUTION_FAILED' }];
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = require('../../src/catalog/series/series-bundle-contract').bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked',
    base_revision: revisionOf(snapshot), seed: { candidate_key: card.candidate_key, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  let calls = 0;
  const options = {
    readPending: () => ({ revision: 'pending-legacy-qwen-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.legacy-qwen-audio-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => { throw new Error('legacy Bundle must not repeat identity search'); },
    enrichMember: async ({ seed, existingResearch }) => {
      calls += 1;
      assert.equal(seed.modality, 'audio');
      assert.equal(existingResearch, null, '旧 Draft 没有 raw research 时必须从头安全重研');
      return { ok: true, layer_patches: enrichmentPatches(seed) };
    },
  };
  try {
    const plan = planCatalogBundles(options);
    const result = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls, 1);
    assert.equal(result.drafts[0].draft_id, stored.draft_id);
    assert.equal(result.drafts[0].series.modality, 'omni');
    assert.equal(result.drafts[0].series.profile_modality, 'audio');
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('running checkpoint 的未知费用先隔离，不得在重启后重复使用额度', async () => {
  const snapshot = emptySnapshot();
  const policy = modalityPolicy(['audio']);
  const suffix = Date.now();
  const candidateKey = `bundle-retry-interrupted-${suffix}`;
  const card = { candidate_key: candidateKey, name: 'Fixture audio series', entity_type: 'series', review_status: 'approved' };
  const bundle = plannedFixtureAudioBundle(candidateKey, [
    { name: 'Fixture audio member', model_key: 'fixture-audio-interrupted', evidence: { official_url: 'https://fixture.example/audio', content_hash: 'sha256:fixture-a' } },
  ], snapshot, policy);
  const member = bundle.members[0];
  const limits = { search_queries: 3, pages: 8, responses_calls: 8, synthesis_calls: 1 };
  const spent = { search_queries: 1, pages: 1 };
  member.enrichment = { status: 'running', attempts: 1, limits,
    cost: { total_spent: spent, last_attempt_spent: spent, uncertain_spent: {} },
    research: null, missing_fields: [], last_error: null };
  bundle.enrichment_hard_limits = limits;
  bundle.cost.enrichment = { limits, spent, remaining: { search_queries: 2, pages: 7, responses_calls: 8, synthesis_calls: 1 } };
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT'];
  bundle.readiness = 'blocked';
  bundle.preview_hash = require('../../src/catalog/series/series-bundle-contract').bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  const stored = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'enriching',
    base_revision: revisionOf(snapshot), seed: { candidate_key: candidateKey, name: card.name, entity_type: 'series' },
    bundle, bundle_id: bundle.bundle_id, bundle_token: bundle.bundle_token,
    readiness: { status: 'blocked', blocking_reasons: bundle.blockers } });
  let externalCalls = 0;
  const options = {
    readPending: () => ({ revision: 'pending-retry-interrupted-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }), policy,
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-retry-interrupted-${suffix}.json`),
    setIntakeOutcome: null,
    enrichMember: async () => { externalCalls += 1; return { ok: false, code: 'SHOULD_NOT_RUN' }; },
  };
  try {
    const plan = planCatalogBundles(options);
    assert.deepEqual(plan.retry_summary.incremental_limits, limits, '未知 research 请求的额度需全额重新确认');
    const result = await prepareCatalogBundles({ ...plan, confirm_cost: true }, options);
    assert.equal(result.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    assert.equal(externalCalls, 0);
    assert.equal(listDrafts({ schema_version: 4, draft_kind: 'series_bundle' }).find(item => item.draft_id === stored.draft_id).updated_at, stored.updated_at);
  } finally {
    deleteDraft(stored.draft_id);
  }
});

test('Qwen Audio 的系列 omni 通过真实 usage_kind 解析为 audio 富化 profile', async () => {
  const snapshot = emptySnapshot();
  const suffix = Date.now();
  const card = {
    candidate_key: `bundle-qwen-audio-${suffix}`,
    name: 'Qwen-Audio 3.1', entity_type: 'series', review_status: 'approved',
  };
  const officialUrl = 'https://help.aliyun.com/zh/model-studio/models';
  const options = {
    readPending: () => ({ revision: 'pending-qwen-audio-r1', cards: [card] }),
    loadCatalog: () => ({ revision: revisionOf(snapshot), snapshot }),
    policy: loadSeriesPolicy(),
    bridgeFile: path.join(CATALOG_GENERATOR_FILES.draftsDir, `.bundle-qwen-audio-${suffix}.json`),
    setIntakeOutcome: null,
    resolveBatchCandidates: async () => ({
      series_candidates: [{
        candidate_key: card.candidate_key, name: card.name, modality: 'omni',
        verdict: {
          entity_class: 'series', vendor_key: 'alibaba', model_key: 'alibaba-qwen-audio-3-1',
          series_title: card.name, family: 'qwen_audio',
          evidence: { official_url: officialUrl, content_hash: 'sha256:qwen-series' },
        },
        members: [{
          name: 'Qwen Audio 3.1 ASR Flash Streaming',
          model_key: 'alibaba-qwen-audio-3-1-asr-flash-streaming',
          evidence: { official_url: officialUrl, content_hash: 'sha256:qwen-member' },
        }],
      }],
      verification_blocked: [], unresolved: [], intake_outcomes: [],
    }),
    enrichMember: async ({ seed }) => {
      assert.equal(seed.modality, 'audio');
      assert.equal(seed.known_fields.theme, 'general', 'theme 是展示主题，与 audio profile 分离');
      return { ok: true, layer_patches: enrichmentPatches(seed) };
    },
  };
  let prepared;
  try {
    const planned = planCatalogBundles(options);
    const confirmation = await prepareCatalogBundles({ ...planned, confirm_cost: true }, options);
    assert.equal(confirmation.code, 'ENRICHMENT_COST_CONFIRMATION_REQUIRED');
    prepared = await prepareCatalogBundles({
      ...planned, confirm_cost: true,
      enrichment_confirmation_token: confirmation.enrichment_confirmation_token,
    }, options);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.drafts[0].series.modality, 'omni');
    assert.equal(prepared.drafts[0].series.profile_modality, 'audio');
  } finally {
    for (const draft of prepared?.drafts || []) deleteDraft(draft.draft_id);
  }
});

test('omni 不会静默降级成 text 富化 profile', async () => {
  const input = bundle();
  input.series.modality = 'omni';
  input.candidate.modality = 'omni';
  let providerCalls = 0;
  const result = await finalizeSeriesBundle(input, {
    snapshot: emptySnapshot(),
    adapters: {
      discover: async () => { providerCalls += 1; },
      acquire: async () => { providerCalls += 1; },
      synthesize: async () => { providerCalls += 1; },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.bundle.enrichment_errors[0].error, /CATALOG_PROFILE_UNSUPPORTED:api_model:omni/);
  assert.equal(providerCalls, 0, '缺少 omni profile 时在发起研究前 fail closed');
});

test('离线富化成功后只在内存收口 future snapshot/readiness/hash/token', async () => {
  const input = bundle();
  const result = await finalizeSeriesBundle(input, {
    snapshot: { 'vendor-level2': [{ id: 'vendor-level2:zhipu:glm' }], 'tool-level3': [], 'tool-card': [] },
    memberEnrichment: { 'zhipu-glm-5-3': { ok: true, layer_patches: [
      { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'replace', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', summary: '官方完整资料' } },
      { area: 'tool-card', id: 'tool-card:glm-5-3', operation: 'replace', record: { id: 'tool-card:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' } } },
    ] } },
    validate: value => validateSeriesBundle(value, {}),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bundle.readiness, 'ready');
  assert.ok(result.bundle.future_snapshot['tool-level3'].some(record => record.id === 'tool-level3:glm-5-3'));
  assert.equal(result.bundle.layer_patches.find(patch => patch.id === 'tool-level3:glm-5-3').operation, 'create');
  assert.equal(result.bundle.layer_patches.find(patch => patch.id === 'tool-card:glm-5-3').operation, 'create');
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

test('富化失败保留合成缺口诊断，避免只显示通用 blocker', async () => {
  const result = await finalizeSeriesBundle(bundle(), {
    snapshot: { 'vendor-level2': [], 'tool-level3': [], 'tool-card': [] },
    memberEnrichment: {
      'zhipu-glm-5-3': {
        ok: false,
        code: 'PROFILE_MISMATCH_SUSPECTED',
        error: '缺少必需目录字段: detail.api_pricing',
        research: { ok: true, official_sources: [{ url: 'https://docs.z.ai/glm' }] },
        synthesis: { missing_fields: ['detail.api_pricing'], errors: [{ code: 'SYNTHESIS_COVERAGE_INCOMPLETE' }] },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.bundle.enrichment_errors[0], {
    model_key: 'zhipu-glm-5-3',
    name: 'GLM-5.3',
    code: 'PROFILE_MISMATCH_SUSPECTED',
    error: '缺少必需目录字段: detail.api_pricing',
    missing_fields: ['detail.api_pricing'],
    synthesis_errors: [{ code: 'SYNTHESIS_COVERAGE_INCOMPLETE' }],
    research_code: null,
    research_error: null,
    official_source_count: 1,
  });
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
test('孤立 Bundle 在 pending 候选已不存在时可幂等 discard', async () => {
  const input = bundle();
  const draft = createDraft({ schema_version: 4, draft_kind: 'series_bundle', state: 'preview_blocked', base_revision: 'r1', bundle: input, bundle_id: input.bundle_id, bundle_token: 'btk-orphan' });
  try {
    const result = await discardCatalogBundle(draft.draft_id, { expected_revision: 'r1', allowBundleDiscard: true }, {
      loadCatalog: () => ({ revision: 'r1', snapshot: {} }),
      readPending: () => ({ revision: 'pending-r1', cards: [] }),
      setIntakeOutcome: async () => { const error = new Error('PENDING_CANDIDATE_NOT_FOUND'); error.code = 'PENDING_CANDIDATE_NOT_FOUND'; throw error; },
    });
    assert.deepEqual(result, {
      ok: true,
      draft_id: draft.draft_id,
      outcome: 'pending',
      candidate_missing: true,
      outcome_warning: { code: 'PENDING_CANDIDATE_NOT_FOUND', error: 'PENDING_CANDIDATE_NOT_FOUND' },
    });
    assert.throws(() => readCatalogBundle(draft.draft_id), /ENOENT/);
  } finally {
    try { deleteDraft(draft.draft_id); } catch {}
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

test('Bundle 入口并入被身份核验判定为 series 的 api_model 待补卡（series 回执粗筛）', () => {
  const snapshot = emptySnapshot();
  const catalogRevision = revisionOf(snapshot);
  const apiModelCard = { candidate_key: 'vidu-s2-model-hint', name: 'Vidu S2', identity_key: 'vidu-s2', entity_type: 'model', detail_kind_hint: 'api_model', review_status: 'approved' };
  const options = {
    readPending: () => ({ revision: 'pending-series-receipt-r1', cards: [apiModelCard] }),
    loadCatalog: () => ({ revision: catalogRevision, snapshot }),
    now: '2026-09-24T12:00:00.000Z',
    identityReceipts: [
      { receipt_id: 'receipt-series00001', candidate_name: 'Vidu S2', identity_key: 'vidu-s2', entity_class: 'series', catalog_revision: catalogRevision, verified_at: '2026-09-24T11:30:00.000Z' },
    ],
  };
  const planned = planCatalogBundles(options);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(planned.candidates, [{ candidate_key: apiModelCard.candidate_key, name: 'Vidu S2' }]);

  // 回执过期（catalog revision 不匹配）→ 不并入，Bundle 无候选
  const stale = planCatalogBundles({
    ...options,
    identityReceipts: [{ ...options.identityReceipts[0], catalog_revision: 'catalog-stale' }],
  });
  assert.equal(stale.code, 'SERIES_CANDIDATE_NOT_APPROVED');

  // 回执为 model 类 → 不并入
  const modelClass = planCatalogBundles({
    ...options,
    identityReceipts: [{ ...options.identityReceipts[0], entity_class: 'model' }],
  });
  assert.equal(modelClass.code, 'SERIES_CANDIDATE_NOT_APPROVED');
});

test('Bundle 入口不重复接收已在目录中的 series 回执候选', () => {
  const snapshot = emptySnapshot();
  snapshot['tool-level3'].push({
    id: 'tool-level3:stepaudio-3-asr', title: 'StepAudio 3 ASR', detail_kind: 'api_model',
    vendor_key: 'stepfun', model_key: 'stepfun-stepaudio-3-asr',
  });
  const catalogRevision = revisionOf(snapshot);
  const card = {
    candidate_key: 'stepaudio-existing', name: 'StepAudio 3 ASR', identity_key: 'stepaudio-3-asr',
    entity_type: 'model', detail_kind_hint: 'api_model', review_status: 'approved',
  };
  const plan = planCatalogBundles({
    readPending: () => ({ revision: 'pending-stepaudio', cards: [card] }),
    loadCatalog: () => ({ revision: catalogRevision, snapshot }),
    registry: { schema_version: 1, entries: { stepfun: { vendor_name: 'StepFun', official_urls: ['https://platform.stepfun.ai'], model_prefixes: ['stepaudio'] } } },
    identityReceipts: [{
      receipt_id: 'receipt-stepaudio-series', candidate_name: card.name, identity_key: 'stepaudio-3-asr',
      entity_class: 'series', catalog_revision: catalogRevision, verified_at: new Date().toISOString(),
    }],
  });
  assert.equal(plan.code, 'SERIES_CANDIDATE_NOT_APPROVED');
  assert.deepEqual(plan.candidates, []);
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
      { area: 'tool-level3', id: 'tool-level3:glm-5-3', operation: 'create', record: { id: 'tool-level3:glm-5-3', model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu', detail_kind: 'api_model', official_url: 'https://docs.z.ai/glm' } },
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
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
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
