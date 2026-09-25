'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { candidateKeyOf } = require('../../src/pending/index');
const { createCatalogWorkbench } = require('../../src/catalog/catalog-workbench');


test('catalog recovery projects safe defaults and rejects sensitive or empty overrides', () => {
  const calls = [];
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    recoveryPlanForDraft: (draftId, input) => {
      calls.push({ draftId, input });
      return { ok: true, draft_id: draftId, recovery_token: 'recovery-token', recovery_mode: 'synthesis_only' };
    },
  });
  const result = coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].input.generatorOptions.model, 'deepseek-v4-flash');
  assert.equal(calls[0].input.generatorOptions.searchProvider, 'zhipu_web_search');
  assert.equal(calls[0].input.generatorOptions.searchFallbackProvider, 'tavily');
  assert.equal(calls[0].input.generatorOptions.extractProvider, 'direct_fetch');
  assert.equal(calls[0].input.generatorOptions.extractFallbackProvider, 'tavily');
  assert.equal(calls[0].input.generatorOptions.searchEngine, 'search_std');
  assert.throws(() => coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: '' },
  }), error => error.code === 'MODEL_REQUIRED');
  assert.throws(() => coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { apiKey: 'secret' },
  }), error => error.code === 'RECOVERY_OPTIONS_INVALID');
});

test('catalog workbench resume roundtrip matches recovery token', async () => {
  let resumeTokenSeen = null;
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    recoveryPlanForDraft: (draftId, input) => ({
      ok: true,
      draft_id: draftId,
      recovery_token: 'sha256:token-xyz',
      recovery_mode: 'synthesis_only',
      cost_plan: { hard_limits: {} },
    }),
    resumeCatalogDraft: async (draftId, options) => {
      resumeTokenSeen = options.recoveryToken;
      return { ok: true, draft: { draft_id: draftId, state: 'preview_ready', readiness: { status: 'ready' } } };
    },
  });
  const plan = coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
  });
  assert.equal(plan.ok, true);
  const resumed = await coordinator.resume('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
    recovery_token: plan.recovery_token,
    confirm_cost: true,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumeTokenSeen, 'sha256:token-xyz');
});

test('catalog workbench keeps cost, plan and explicit apply gates', async () => {
  const card = { name: 'Offline Tool', candidate_key: candidateKeyOf('tools', 'Offline Tool'), review_status: 'approved' };
  const calls = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    resolveBatchCandidates: async () => { calls.push('resolve'); return { seeds: [{ name: card.name }], unresolved: [] }; },
    prepareCatalogDraft: async () => { calls.push('prepare'); return { ok: true, draft: { draft_id: 'draft-offline', state: 'preview_ready', base_revision: 'catalog-r1', preview_hash: 'hash-1', readiness: { status: 'ready' } } }; },
    reviewCatalogDraft: () => ({ ok: true, currentRevision: 'catalog-r1', previewHash: 'hash-1' }),
    applyCatalogDraft: () => { calls.push('apply'); return { ok: true, targetRevision: 'catalog-r2' }; },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  assert.equal(plan.status, 'cost_confirmation_required');
  assert.equal((await coordinator.prepare({ ...plan, confirm_cost: false })).code, 'COST_CONFIRMATION_REQUIRED');
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.status, 'drafts_ready');
  assert.deepEqual(calls, ['resolve', 'prepare']);
  assert.equal(coordinator.apply({ draft_id: 'draft-offline', expected_revision: 'catalog-r1', preview_hash: 'hash-1', confirm: 'wrong' }).code, 'CONFIRMATION_INVALID');
  assert.equal(coordinator.apply({ draft_id: 'draft-offline', expected_revision: 'catalog-r1', preview_hash: 'hash-1', confirm: 'APPLY CATALOG DRAFT draft-offline' }).status, 'completed');
  assert.deepEqual(calls, ['resolve', 'prepare', 'apply']);
});

test('catalog workbench returns phased blocker details alongside successful drafts', async () => {
  const readyCard = { name: 'Ready Tool', candidate_key: candidateKeyOf('tools', 'Ready Tool'), review_status: 'approved' };
  const blockedCard = { name: 'Blocked Model', candidate_key: candidateKeyOf('tools', 'Blocked Model'), review_status: 'approved', entity_type: 'model', detail_kind_hint: 'api_model' };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [readyCard, blockedCard] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
    resolveBatchCandidates: async () => ({
      seeds: [{ name: readyCard.name }],
      unresolved: [],
      verification_blocked: [{ name: blockedCard.name, code: 'IDENTITY_NAME_NOT_IN_BODY', reason: '官方正文未命中 blocked-model' }],
    }),
    prepareCatalogDraft: async () => ({ ok: true, draft: { draft_id: 'draft-ready-tool', state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' } } }),
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.blocked[0].phase, 'identity_verification');
  assert.equal(result.blocked[0].code, 'IDENTITY_NAME_NOT_IN_BODY');
  assert.equal(result.blocked[0].reason, '官方正文未命中 blocked-model');
});

test('catalog workbench preserves a sanitized batch resolution error', async () => {
  const card = { name: 'Batch Failure Tool', candidate_key: candidateKeyOf('tools', 'Batch Failure Tool'), review_status: 'approved' };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
    resolveBatchCandidates: async () => { throw new Error('SOURCE_CONTEXT_UNAVAILABLE: shared resolver bootstrap failed'); },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });

  assert.equal(result.status, 'drafts_blocked');
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].code, 'SOURCE_RESOLUTION_FAILED');
  assert.equal(result.blocked[0].reason, 'SOURCE_CONTEXT_UNAVAILABLE: shared resolver bootstrap failed');
});

test('catalog workbench resolves api_model placement before draft preparation and budgets deferred research', async () => {
  const card = {
    name: 'StepAudio 3 ASR',
    candidate_key: candidateKeyOf('tools', 'StepAudio 3 ASR'),
    review_status: 'approved',
    entity_type: 'model',
    detail_kind_hint: 'api_model',
  };
  const calls = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: { 'vendor-level2': [] } }),
    generatorOptions: { maxSearchQueries: 2, maxPages: 3, maxResponsesCalls: 4, maxSynthesisCalls: 1 },
    resolveOptions: { allowAiPlacement: true },
    planCatalogDraft: seed => (seed.placement?.existing_level2_ref?.id
      ? { ok: true, cost_plan: { hard_limits: { responses_calls: 4 } } }
      : { ok: false, code: 'PLACEMENT_REQUIRED_FOR_API_MODEL' }),
    resolveBatchCandidates: async () => ({
      seeds: [{ name: card.name, detail_kind: 'api_model', vendor_name: 'StepFun', vendor_key: 'stepfun' }],
      unresolved: [],
    }),
    resolveBatchPlacements: async (seeds, options) => {
      calls.push('placement');
      assert.deepEqual(options.snapshotOf(), { 'vendor-level2': [] });
      assert.equal(options.allowAiPlacement, true);
      assert.equal(options.placementLedger.snapshot().limits.responses_calls, 1);
      seeds[0].placement = { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:stepfun:audio' } };
      return { blocked: [] };
    },
    prepareCatalogDraft: async seed => {
      calls.push('prepare');
      assert.equal(seed.placement.existing_level2_ref.id, 'vendor-level2:stepfun:audio');
      return { ok: true, draft: { draft_id: 'draft-stepaudio', state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' } } };
    },
    listDrafts: () => [],
  });

  const plan = coordinator.plan();
  assert.equal(plan.ok, true);
  assert.equal(plan.entries[0].status, 'placement_deferred');
  assert.equal(plan.cost_plan.search_queries, 10);
  assert.equal(plan.cost_plan.pages, 3);
  assert.equal(plan.cost_plan.responses_calls, 4);
  assert.equal(plan.cost_plan.synthesis_calls, 1);
  assert.equal(plan.cost_plan.verification_search_upper_bound, 2);
  assert.equal(plan.cost_plan.verification_search_fallback_upper_bound, 1);
  assert.equal(plan.cost_plan.verification_responses_upper_bound, 4);
  assert.equal(plan.cost_plan.placement_ai_calls_upper_bound, 1);

  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.status, 'drafts_ready');
  assert.deepEqual(calls, ['placement', 'prepare']);
});

test('catalog workbench preserves per-candidate identity blockers when another draft succeeds', async () => {
  const readyCard = { name: 'Ready Tool', candidate_key: candidateKeyOf('tools', 'Ready Tool'), review_status: 'approved' };
  const blockedCard = {
    name: 'Blocked Model',
    candidate_key: candidateKeyOf('tools', 'Blocked Model'),
    review_status: 'approved',
    entity_type: 'model',
    detail_kind_hint: 'api_model',
  };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [readyCard, blockedCard] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
    resolveBatchCandidates: async () => ({
      seeds: [{ name: readyCard.name }],
      unresolved: [],
      verification_blocked: [{ name: blockedCard.name, code: 'IDENTITY_NAME_NOT_IN_BODY', reason: '官方正文未命中 blocked-model' }],
    }),
    prepareCatalogDraft: async () => ({
      ok: true,
      draft: { draft_id: 'draft-ready-tool', state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' } },
    }),
    listDrafts: () => [],
  });

  const plan = coordinator.plan();
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.drafts.length, 1);
  assert.deepEqual(prepared.blocked, [{
    name: blockedCard.name,
    phase: 'identity_verification',
    code: 'IDENTITY_NAME_NOT_IN_BODY',
    reason: '官方正文未命中 blocked-model',
  }]);
});

test('catalog workbench reports placement blockers and does not start draft generation', async () => {
  const card = {
    name: 'Model Without Placement',
    candidate_key: candidateKeyOf('tools', 'Model Without Placement'),
    review_status: 'approved',
    entity_type: 'model',
    detail_kind_hint: 'api_model',
  };
  let prepareCalls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    planCatalogDraft: () => ({ ok: false, code: 'PLACEMENT_REQUIRED_FOR_API_MODEL' }),
    resolveBatchCandidates: async () => ({ seeds: [{ name: card.name, detail_kind: 'api_model', vendor_key: 'vendor' }], unresolved: [] }),
    resolveBatchPlacements: async () => ({ blocked: [{ name: card.name, code: 'PLACEMENT_MANUAL_REQUIRED' }] }),
    prepareCatalogDraft: async () => { prepareCalls += 1; return { ok: true, draft: {} }; },
    listDrafts: () => [],
  });

  const plan = coordinator.plan();
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, 'PLACEMENT_MANUAL_REQUIRED');
  assert.equal(prepared.blocked[0].code, 'PLACEMENT_MANUAL_REQUIRED');
  assert.equal(prepareCalls, 0);
});

test('catalog workbench discard requires current catalog revision', () => {
  let discarded = false;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    discardCatalogDraft: () => { discarded = true; return { ok: true }; },
  });
  assert.equal(coordinator.discard('draft-abc', {}).code, 'REVISION_CONFLICT');
  assert.equal(coordinator.discard('draft-abc', { expected_revision: 'catalog-stale' }).code, 'REVISION_CONFLICT');
  assert.equal(discarded, false);
  assert.equal(coordinator.discard('draft-abc', { expected_revision: 'catalog-r1' }).ok, true);
  assert.equal(discarded, true);
});

test('catalog workbench rejects concurrent prepare to prevent duplicate drafts and spend', async () => {
  const card = { name: 'GPT-6', candidate_key: candidateKeyOf('tools', 'GPT-6'), review_status: 'approved' };
  let prepareCalls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    resolveBatchCandidates: async () => ({ seeds: [{ name: card.name }], unresolved: [] }),
    prepareCatalogDraft: async () => {
      prepareCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, draft: { draft_id: `draft-${prepareCalls}`, state: 'preview_ready', base_revision: 'catalog-r1', preview_hash: 'hash-1', readiness: { status: 'ready' } } };
    },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  const [first, second] = await Promise.all([
    coordinator.prepare({ ...plan, confirm_cost: true }),
    coordinator.prepare({ ...plan, confirm_cost: true }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'PREPARE_IN_PROGRESS');
  assert.equal(prepareCalls, 1);
});

test('catalog workbench reuses resuming draft instead of creating a duplicate', async () => {
  const card = { name: 'GPT-6', candidate_key: candidateKeyOf('tools', 'GPT-6'), review_status: 'approved' };
  const calls = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    prepareCatalogDraft: async () => { calls.push('prepare'); return { ok: true, draft: {} }; },
    listDrafts: () => [{
      draft_id: 'draft-resuming',
      schema_version: 4,
      state: 'resuming',
      base_revision: 'catalog-r1',
      seed: { name: card.name, candidate_key: card.candidate_key },
      readiness: { status: 'blocked', warnings: [] },
    }],
  });
  const plan = coordinator.plan();
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.ok, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(prepared.reused, ['draft-resuming']);
  assert.equal(prepared.drafts.length, 1);
  assert.equal(prepared.drafts[0].draft_id, 'draft-resuming');
});


test('catalog draft projection exposes stable diagnostics without raw failure payloads', () => {
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => [{
      draft_id: 'draft-blocked',
      schema_version: 4,
      state: 'preview_blocked',
      base_revision: 'catalog-r1',
      seed: { name: 'Blocked Tool' },
      readiness: { status: 'blocked', warnings: [] },
      last_error: { code: 'DEEPSEEK_OUTPUT_INVALID', error: 'missing field `model`; apiKey=secret' },
      research: { official_sources: [{ content: 'private research' }] },
    }],
  });
  const item = coordinator.list().items[0];
  assert.equal(item.error_code, 'MODEL_REQUIRED');
  assert.equal(item.recovery_kind, 'config_required');
  assert.equal(item.recovery_mode, 'synthesis_only');
  assert.deepEqual(item.missing_config_fields, ['model']);
  assert.equal('research' in item, false);
  assert.equal(JSON.stringify(item).includes('secret'), false);
  assert.equal(JSON.stringify(item).includes('private research'), false);
});

test('catalog workbench batches drafts from same vendor by merging relation patches', () => {
  const card1 = { name: 'Model A', candidate_key: 'key-a', review_status: 'approved' };
  const card2 = { name: 'Model B', candidate_key: 'key-b', review_status: 'approved' };
  const sharedVendor = { area: 'vendor-card', id: 'vendor-card:v1', operation: 'noop', record: null, provenance: {} };
  const level1PatchA = { area: 'vendor-level1', id: 'vendor-level1:v1', operation: 'replace', record: { id: 'vendor-level1:v1', level2_refs: [{ id: 'ref-1' }] }, provenance: {} };
  const level1PatchB = { area: 'vendor-level1', id: 'vendor-level1:v1', operation: 'replace', record: { id: 'vendor-level1:v1', level2_refs: [{ id: 'ref-2' }] }, provenance: {} };
  const d1 = { draft_id: 'draft-1', schema_version: 4, state: 'preview_ready', base_revision: 'c-r1', readiness: { status: 'ready' }, layer_patches: [sharedVendor, level1PatchA] };
  const d2 = { draft_id: 'draft-2', schema_version: 4, state: 'preview_ready', base_revision: 'c-r1', readiness: { status: 'ready' }, layer_patches: [sharedVendor, level1PatchB] };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'p-r1', cards: [card1, card2] }),
    loadCatalog: () => ({ revision: 'c-r1', snapshot: { 'vendor-card': [{ id: 'vendor-card:v1' }], 'vendor-level1': [{ id: 'vendor-level1:v1', level2_refs: [] }] } }),
    listDrafts: () => [d1, d2],
    reviewCatalogDraftBatch: (ids) => {
      const plan = { changePreview: { creates: {}, updates: [], noops: [] } };
      const reviews = [d1, d2].map(d => ({ draft: d, previewHash: 'h', plan }));
      return { ok: true, draft_ids: ids, currentRevision: 'c-r1', batchToken: 'token', reviews, plan };
    },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.equal(preview.draft_count, 2);
});

test('catalog workbench batches drafts through one preview and one apply', () => {
  const card = { name: 'Batch Tool', candidate_key: candidateKeyOf('tools', 'Batch Tool'), review_status: 'approved' };
  const calls = [];
  const drafts = [{ draft_id: 'draft-b', schema_version: 4, state: 'preview_ready', base_revision: 'catalog-r1', seed: { name: 'Batch Tool', candidate_key: card.candidate_key }, readiness: { status: 'ready' } }];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => drafts,
    reviewCatalogDraftBatch: ids => ({ ok: true, draft_ids: ids, currentRevision: 'catalog-r1', batchToken: 'batch-token', reviews: drafts.map(draft => ({ draft, plan: { changePreview: { creates: { 'tool-card': ['tool-1'] }, updates: [], noops: [] } } })), plan: { changePreview: { creates: { 'tool-card': ['tool-1'] }, updates: [], noops: [] } } }),
    applyCatalogDrafts: input => { calls.push(input); return { ok: true, status: 'completed', targetRevision: 'catalog-r2', appliedDraftIds: input.draftIds }; },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.equal(preview.draft_count, 1);
  assert.deepEqual(preview.draft_ids, ['draft-b']);
  assert.equal(coordinator.applyBatch({ draft_ids: ['draft-b'], expected_revision: 'catalog-r1', batch_token: 'batch-token', confirm: 'APPLY CATALOG DRAFTS batch-token' }).status, 'completed');
  assert.equal(calls.length, 1);
});


test('catalog batch preview keeps ready drafts usable when other drafts are blocked', () => {
  const ready = { draft_id: 'draft-ready', schema_version: 4, state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' }, seed: { name: 'Ready', candidate_key: 'ready-key' } };
  const blocked = { draft_id: 'draft-blocked', schema_version: 4, state: 'preview_blocked', base_revision: 'catalog-r1', readiness: { status: 'blocked', blocking_reasons: ['missing source'] }, seed: { name: 'Blocked', candidate_key: 'blocked-key' } };
  let reviewed;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => [ready, blocked],
    reviewCatalogDraftBatch: ids => {
      reviewed = ids;
      return { ok: true, draft_ids: ids, currentRevision: 'catalog-r1', batchToken: 'batch-token', reviews: [{ draft: ready, plan: { changePreview: { creates: {}, updates: [], noops: [] } } }], plan: { changePreview: { creates: {}, updates: [], noops: [] } } };
    },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.deepEqual(reviewed, ['draft-ready']);
  assert.equal(preview.blockers.length, 1);
  assert.equal(preview.blockers[0].draft_id, 'draft-blocked');
});

test('catalog prepare reuses a matching ready draft without resolving or preparing again', async () => {
  const card = { name: 'Reusable Tool', candidate_key: candidateKeyOf('tools', 'Reusable Tool'), review_status: 'approved' };
  let calls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
    listDrafts: () => [{ draft_id: 'draft-reused', schema_version: 4, state: 'preview_ready', base_revision: 'catalog-r1', seed: { name: card.name, candidate_key: card.candidate_key }, readiness: { status: 'ready' } }],
    resolveBatchCandidates: async () => { calls += 1; return { seeds: [] }; },
    prepareCatalogDraft: async () => { calls += 1; return {}; },
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(result.reused[0], 'draft-reused');
  assert.equal(calls, 0);
});

test('catalog prepare rejects a reused Draft whose model modality no longer matches the candidate', async () => {
  const card = { name: 'StepAudio 3 ASR', candidate_key: candidateKeyOf('tools', 'StepAudio 3 ASR'), review_status: 'approved', entity_type: 'model', detail_kind_hint: 'api_model' };
  let resolved = 0;
  let preparedSeed;
  const oldDraft = {
    draft_id: 'draft-stepaudio-text', schema_version: 4, draft_kind: 'catalog', state: 'preview_ready', base_revision: 'catalog-r1',
    seed: { name: card.name, candidate_key: card.candidate_key, detail_kind: 'api_model' },
    research_plan: { profile: { detail_kind: 'api_model', modality: 'text' } },
    readiness: { status: 'ready' },
  };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    listDrafts: () => [oldDraft],
    planCatalogDraft: seed => seed.placement?.existing_level2_ref
      ? { ok: true, cost_plan: { hard_limits: {} } }
      : { ok: false, code: 'PLACEMENT_REQUIRED_FOR_API_MODEL' },
    resolveBatchCandidates: async () => {
      resolved += 1;
      return { seeds: [{ name: card.name, detail_kind: 'api_model', placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:stepfun:audio' } } }] };
    },
    resolveBatchPlacements: async () => ({ blocked: [] }),
    prepareCatalogDraft: async seed => {
      preparedSeed = seed;
      return { ok: true, draft: { draft_id: 'draft-stepaudio-audio', state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' } } };
    },
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(result.ok, true);
  assert.equal(resolved, 1);
  assert.equal(preparedSeed.modality, 'audio');
  assert.deepEqual(result.reused, []);
});

test('already_complete outcome is rechecked when its model key is absent from the catalog', () => {
  const card = {
    name: 'GPT-6 Sol', candidate_key: 'candidate-gpt-6-sol', review_status: 'approved',
    entity_type: 'model', detail_kind_hint: 'api_model', identity_key: 'gpt-6-sol', intake_outcome: 'already_complete',
  };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({
      revision: 'catalog-r1',
      snapshot: {
        'tool-level3': [{ id: 'tool-level3:gpt-5.6-sol', vendor_key: 'openai', title: 'GPT-5.6 Sol', model_key: 'openai-gpt-5.6-sol' }],
        'tool-card': [],
      },
    }),
    registry: { schema_version: 1, entries: { openai: { vendor_name: 'OpenAI', official_url: 'https://openai.com', model_prefixes: ['GPT-'] } } },
    productRegistry: { schema_version: 1, products: {} },
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
  });
  const plan = coordinator.plan();
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, [card.candidate_key]);
});

test('stale bundled_for_review marker and mismatched series receipt do not hide a model candidate', () => {
  const card = {
    name: 'Hy Image 3.5', candidate_key: 'candidate-hy-image-35', review_status: 'approved',
    entity_type: 'model', detail_kind_hint: 'api_model', identity_key: 'hy-image-3.5', intake_outcome: 'bundled_for_review',
  };
  const identityReceipts = [{
    candidate_name: card.name, identity_key: 'hunyuan', entity_class: 'series',
    catalog_revision: 'catalog-r1', verified_at: new Date().toISOString(),
  }];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    identityReceipts,
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
  });
  assert.deepEqual(coordinator.plan().candidates, [card.candidate_key]);
  assert.equal(coordinator.bundlePlan().code, 'SERIES_CANDIDATE_NOT_APPROVED');
});

test('already complete resolution is reported as complete instead of SEED_NOT_RESOLVED', async () => {
  const card = { name: 'Existing Model', candidate_key: 'candidate-existing-model', review_status: 'approved', entity_type: 'model', detail_kind_hint: 'api_model' };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    planCatalogDraft: () => ({ ok: false, code: 'PLACEMENT_REQUIRED_FOR_API_MODEL' }),
    resolveBatchCandidates: async () => ({ seeds: [], intake_outcomes: [{ candidate_key: card.candidate_key, outcome: 'already_complete' }] }),
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'candidates_complete');
  assert.equal(result.completed[0].name, card.name);
  assert.deepEqual(result.blocked, []);
});

test('目录已有模型在身份/系列核验前按规范 model_key 标记完成', async () => {
  const cards = [
    { name: 'StepAudio 3 ASR', candidate_key: 'candidate-stepaudio', identity_key: 'stepaudio-3-asr', review_status: 'approved', entity_type: 'model', detail_kind_hint: 'api_model' },
    { name: 'Hy Image 3.5', candidate_key: 'candidate-hy35', identity_key: 'hy-image-3.5', review_status: 'approved', entity_type: 'model', detail_kind_hint: 'api_model' },
  ];
  const snapshot = {
    'tool-level3': [
      { id: 'tool-level3:stepaudio-3-asr', title: 'StepAudio 3 ASR', detail_kind: 'api_model', vendor_key: 'stepfun', model_key: 'stepfun-stepaudio-3-asr' },
      { id: 'tool-level3:hy-image-3.5-preview', title: 'Hy-Image-3.5-Preview', detail_kind: 'api_model', vendor_key: 'tencent', model_key: 'tencent-hy-image-3.5-preview' },
    ],
    'tool-card': [],
  };
  let resolveCalls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot }),
    registry: {
      schema_version: 1,
      entries: {
        stepfun: { vendor_name: 'StepFun', official_urls: ['https://platform.stepfun.ai'], model_prefixes: ['stepaudio'] },
        tencent: { vendor_name: '腾讯（混元）', official_urls: ['https://cloud.tencent.com'], model_prefixes: ['hy'] },
      },
    },
    productRegistry: {
      schema_version: 1,
      products: {
        'hy-image-3.5': {
          name: 'Hy Image 3.5', vendor_key: 'tencent',
          official_urls: ['https://cloud.tencent.com/document/product/1823/135745'],
          identity_aliases: ['Hy-Image-3.5-Preview'], lifecycle: 'active',
        },
      },
    },
    resolveBatchCandidates: async () => { resolveCalls += 1; throw new Error('已有模型不应再做身份核验'); },
    planCatalogDraft: () => { throw new Error('已有模型不应再规划 Draft'); },
    prepareCatalogDraft: async () => { throw new Error('已有模型不应生成 Draft'); },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.completed.map(item => item.name), ['StepAudio 3 ASR', 'Hy Image 3.5']);

  const prepared = await coordinator.prepare(plan);
  assert.equal(prepared.status, 'candidates_complete');
  assert.deepEqual(prepared.completed.map(item => item.name), ['StepAudio 3 ASR', 'Hy Image 3.5']);
  assert.equal(resolveCalls, 0);
});

test('projection reclassifies stale manual_required schema failures as retryable', () => {
  const { projectDraft } = require('../../src/catalog/catalog-workbench');
  const projected = projectDraft({
    draft_id: 'draft-1',
    state: 'preview_blocked',
    research: { ok: true, official_sources: [{ source_id: 's1' }] },
    readiness: { status: 'blocked', blocking_reasons: ['ZhipuAI synthesis JSON 结构不符合契约'] },
    last_error: { code: 'DEEPSEEK_SYNTHESIS_SCHEMA_INVALID', recovery_kind: 'manual_required', error: 'ZhipuAI synthesis JSON 结构不符合契约' },
  });
  assert.equal(projected.recovery_kind, 'retryable');
  assert.equal(projected.recovery_mode, 'synthesis_only');
  assert.equal(projected.error_code, 'SCHEMA_INVALID');
});

test('projection marks a ready Draft with a now-wrong inferred modality as blocked', () => {
  const { projectDraft } = require('../../src/catalog/catalog-workbench');
  const projected = projectDraft({
    draft_id: 'draft-stepaudio-text',
    state: 'preview_ready',
    seed: { name: 'StepAudio 3 ASR', detail_kind: 'api_model' },
    research_plan: { profile: { detail_kind: 'api_model', modality: 'text' } },
    readiness: { status: 'ready', blocking_reasons: [], warnings: [] },
  });
  assert.equal(projected.readiness, 'blocked');
  assert.equal(projected.state, 'preview_blocked');
  assert.equal(projected.error_code, 'DRAFT_PROFILE_MODALITY_MISMATCH');
  assert.match(projected.blocking_reasons[0], /重新准备/);
});


test('Bundle 工作台隔离 v3 Draft、返回 snake_case review DTO 并收口 Apply 结果', async () => {
  const calls = [];
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => [
      { schema_version: 3, draft_kind: 'catalog', draft_id: 'draft-v3', state: 'preview_ready', readiness: { status: 'ready' } },
      { schema_version: 4, draft_kind: 'series_bundle', draft_id: 'draft-v4', state: 'preview_ready', readiness: { status: 'ready' } },
    ],
    listCatalogBundles: () => ({ catalog_revision: 'catalog-r1', items: [{ draft_id: 'draft-v4', draft_kind: 'series_bundle' }], count: 1 }),
    reviewCatalogBundle: () => ({ ok: true, currentRevision: 'catalog-r1', previewHash: 'ph', bundleToken: 'bt', draft: { draft_id: 'draft-v4', base_revision: 'catalog-r1', preview_hash: 'ph', bundle_token: 'bt', members: [] } }),
    applyCatalogBundle: input => { calls.push(input); return Promise.resolve({ ok: true, status: 'committed', targetRevision: 'catalog-r2', outcome_pending: true, outcome_warning: { code: 'INTAKE_OUTCOME_WRITE_FAILED' } }); },
  });
  assert.deepEqual(coordinator.list().items.map(item => item.draft_id), []);
  const review = coordinator.bundleReview('draft-v4');
  assert.equal(review.current_revision, 'catalog-r1');
  assert.equal(review.preview_hash, 'ph');
  assert.equal(review.bundle_token, 'bt');
  assert.equal(review.confirmation, 'APPLY CATALOG BUNDLE bt');
  assert.equal('currentRevision' in review, false);
  await assert.rejects(coordinator.bundleApply({ draft_id: 'draft-v4', expected_revision: 'catalog-r1', bundle_token: 'bt', confirm: review.confirmation, api_key: 'secret' }), error => error.code === 'BUNDLE_REQUEST_INVALID');
  const applied = await coordinator.bundleApply({ draft_id: 'draft-v4', expected_revision: 'catalog-r1', bundle_token: 'bt', confirm: review.confirmation });
  assert.deepEqual(applied, {
    ok: true,
    status: 'committed',
    target_revision: 'catalog-r2',
    dist_requested: false,
    dist_built: false,
    dist_pending: false,
    cleanup_pending: false,
    cleanup_only: false,
    outcome_pending: true,
    outcome_warning: { code: 'INTAKE_OUTCOME_WRITE_FAILED' },
  });
  assert.equal(calls[0].confirm, review.confirmation);
});


test('Bundle 列表按 candidate_key 去重，ready 覆盖同候选旧 blocked Draft', () => {
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listCatalogBundles: () => ({
      catalog_revision: 'catalog-r1',
      items: [{ draft_id: 'draft-old', state: 'preview_blocked', bundle_id: 'bundle-old', candidate: { candidate_key: 'candidate-1', name: 'StepAudio 3' } }],
      count: 1,
    }),
    listDrafts: () => [{ draft_id: 'draft-new', schema_version: 4, draft_kind: 'series_bundle', state: 'preview_ready', bundle_id: 'bundle-new', bundle: { candidate: { candidate_key: 'candidate-1', name: 'StepAudio 3' } }, updated_at: '2026-09-22T03:38:20.828Z' }],
  });
  const result = coordinator.bundleList();
  assert.deepEqual(result.items.map(item => item.draft_id), ['draft-new']);
  assert.equal(result.items[0].state, 'preview_ready');
});

test('blocked Bundle 可独立丢弃并由 coordinator 内部注入 allowBundleDiscard 与 operation', async () => {
  let discardInput;
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogBundles: () => ({ ok: true, status: 'cost_confirmation_required', candidates: ['series-1'], pending_revision: 'pending-r1', catalog_revision: 'catalog-r1', plan_hash: 'bundle-plan', cost_plan: { verification_responses_upper_bound: 1 } }),
    readCatalogBundle: () => ({ ok: true, draft_id: 'draft-v4', state: 'preview_blocked', bundle_token: 'bt-blocked', readiness: { status: 'blocked' } }),
    discardCatalogBundle: async (id, input) => { discardInput = { id, input }; return { ok: true, outcome: 'pending' }; },
  });
  const plan = coordinator.bundlePlan();
  assert.equal(plan.enrichment_cost_confirmation_required, true);
  assert.equal(plan.enrichment_cost.status, 'member_dependent');
  // 浏览器传入未授权字段时抛出 BUNDLE_REQUEST_INVALID
  await assert.rejects(
    coordinator.bundleDiscard('draft-v4', { expected_revision: 'catalog-r1', confirm: 'DISCARD CATALOG BUNDLE bt-blocked', allowBundleDiscard: true }),
    error => error.code === 'BUNDLE_REQUEST_INVALID'
  );
  // 正常只传入公开 DTO 字段，内部注入 allowBundleDiscard 和 operation
  const discarded = await coordinator.bundleDiscard('draft-v4', { expected_revision: 'catalog-r1', confirm: 'DISCARD CATALOG BUNDLE bt-blocked' });
  assert.deepEqual(discarded, { ok: true, draft_id: 'draft-v4', status: 'discarded', outcome: 'pending' });
  assert.deepEqual(discardInput, {
    id: 'draft-v4',
    input: { expected_revision: 'catalog-r1', allowBundleDiscard: true, operation: 'catalog-bundle-discard' },
  });
});

test('Bundle 计划和准备拿到 Catalog 默认 Web Search 配置与备用预算', () => {
  const seriesCard = { name: 'Series Candidate', candidate_key: 'tools:series-candidate', review_status: 'approved', entity_type: 'series' };
  let receivedOptions;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [seriesCard] }),
    loadCatalog: () => ({ revision: 'catalog-r1', snapshot: {} }),
    identityReceipts: [],
    generatorOptions: {
      searchProvider: 'zhipu_web_search',
      searchFallbackProvider: 'tavily',
      extractProvider: 'direct_fetch',
      extractFallbackProvider: 'tavily',
    },
    planCatalogBundles: options => {
      receivedOptions = options;
      return { ok: true, status: 'cost_confirmation_required', candidates: ['tools:series-candidate'], plan_hash: 'plan-r1' };
    },
  });
  assert.equal(coordinator.bundlePlan().ok, true);
  assert.equal(receivedOptions.resolveOptions.searchProvider, 'zhipu_web_search');
  assert.equal(receivedOptions.resolveOptions.searchFallbackProvider, 'tavily');
  assert.equal(receivedOptions.resolveOptions.extractProvider, 'direct_fetch');
  assert.equal(receivedOptions.generatorOptions.extractFallbackProvider, 'tavily');
});

test('普通 Catalog plan 和 prepare 排除 series candidate，series 只能由 Bundle 入口处理', async () => {
  const normalCard = { name: 'Normal Tool', candidate_key: 'tools:normal-tool', review_status: 'approved', entity_type: 'tool' };
  const seriesCard = { name: 'Series Model', candidate_key: 'tools:series-model', review_status: 'approved', entity_type: 'series' };
  const bundledCard = { name: 'Bundled Model', candidate_key: 'tools:bundled-model', review_status: 'approved', entity_type: 'model', intake_outcome: 'bundled_for_review' };
  const completeCard = { name: 'Complete Model', candidate_key: 'tools:complete-model', review_status: 'approved', entity_type: 'model', intake_outcome: 'already_complete' };
  const plannedSeeds = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [normalCard, seriesCard, bundledCard, completeCard] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    identityReceipts: [{ candidate_name: 'Bundled Model', identity_key: 'bundled-model', entity_class: 'series', catalog_revision: 'catalog-r1', verified_at: new Date().toISOString() }],
    planCatalogDraft: seed => { plannedSeeds.push(seed); return { ok: true, cost_plan: { hard_limits: {} } }; },
    planCatalogBundles: () => ({ ok: true, candidates: [seriesCard] }),
  });
  const plan = coordinator.plan();
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, ['tools:normal-tool']);
  assert.equal(plannedSeeds.length, 1);
  assert.equal(plannedSeeds[0].name, 'Normal Tool');

  // 若只有 series 候选，普通 plan 判定没有已批准工具待补卡
  const seriesOnlyCoordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [seriesCard] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
  });
  const seriesOnlyPlan = seriesOnlyCoordinator.plan();
  assert.equal(seriesOnlyPlan.ok, false);
  assert.equal(seriesOnlyPlan.code, 'PENDING_CANDIDATE_NOT_APPROVED');

  // Series 候选依然可以通过 bundlePlan 正常被获取
  const bundlePlan = coordinator.bundlePlan();
  assert.equal(bundlePlan.ok, true);
});

test('cleanup_pending 与 outcome_pending 在 coordinator 中支持 cleanup-only 且不进 review/discard', async () => {
  let batchApplyCalls = [];
  let deleteDraftCalls = [];
  const cleanupDraft = {
    draft_id: 'draft-v3-clean',
    schema_version: 4,
    draft_kind: 'catalog',
    state: 'cleanup_pending',
    apply_checkpoint: {
      batch_token: 'btk-1',
      draft_ids: ['draft-v3-clean'],
      target_revision: 'catalog-r2',
    },
  };
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r2' }),
    listDrafts: () => [cleanupDraft],
    applyCatalogDrafts: (input, opts) => {
      batchApplyCalls.push({ input, opts });
      return { ok: true, status: 'cleanup_only', targetRevision: 'catalog-r2', appliedDraftIds: input.draftIds, cleanupPending: [] };
    },
  });

  const list = coordinator.list();
  assert.equal(list.items[0].cleanup_pending, true);
  assert.equal(list.items[0].cleanup_only, true);
  assert.deepEqual(list.items[0].cleanup_action, {
    draft_ids: ['draft-v3-clean'],
    expected_revision: 'catalog-r2',
    batch_token: 'btk-1',
    confirm: 'APPLY CATALOG DRAFTS btk-1',
  });

  const cleanupRes = coordinator.cleanup({
    draft_ids: ['draft-v3-clean'],
    expected_revision: 'catalog-r2',
    batch_token: 'btk-1',
    confirm: 'APPLY CATALOG DRAFTS btk-1',
  });
  assert.equal(cleanupRes.ok, true);
  assert.equal(cleanupRes.cleanup_only, true);
  assert.equal(batchApplyCalls.length, 1);

  // SeriesBundle cleanup_pending 拒绝被送入 review 和 discard
  const bundleCoordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r2' }),
    readDraft: () => ({
      schema_version: 4,
      draft_kind: 'series_bundle',
      draft_id: 'draft-v4-clean',
      state: 'cleanup_pending',
      bundle_token: 'btoken-9',
    }),
    readCatalogBundle: () => ({
      ok: true,
      draft_id: 'draft-v4-clean',
      state: 'cleanup_pending',
      bundle_token: 'btoken-9',
    }),
  });
  const reviewBlocked = bundleCoordinator.bundleReview('draft-v4-clean');
  assert.equal(reviewBlocked.ok, false);
  assert.equal(reviewBlocked.code, 'BUNDLE_REVIEW_FORBIDDEN');

  const discardBlocked = await bundleCoordinator.bundleDiscard('draft-v4-clean', {
    expected_revision: 'catalog-r2',
    confirm: 'DISCARD CATALOG BUNDLE btoken-9',
  });
  assert.equal(discardBlocked.ok, false);
  assert.equal(discardBlocked.code, 'BUNDLE_DISCARD_FORBIDDEN');

  // SeriesBundle cleanup_pending 通过 bundleApply 进行 cleanup-only
  const bundleCleanupRes = await bundleCoordinator.bundleApply({
    draft_id: 'draft-v4-clean',
    expected_revision: 'catalog-r2',
    bundle_token: 'btoken-9',
    confirm: 'APPLY CATALOG BUNDLE btoken-9',
  });
  assert.equal(bundleCleanupRes.ok, true);
  assert.equal(bundleCleanupRes.cleanup_only, true);
  assert.equal(bundleCleanupRes.cleanup_pending, false);
});

test('bundlePrepare 接受 enrichment_confirmation_token 二阶段确认且校验请求字段白名单', async () => {
  let passedInput;
  const coordinator = createCatalogWorkbench({
    prepareCatalogBundles: async input => { passedInput = input; return { ok: true, drafts: [] }; },
  });
  await assert.rejects(
    coordinator.bundlePrepare({ pending_revision: 'p1', catalog_revision: 'c1', plan_hash: 'ph', confirm_cost: true, forbidden_field: true }),
    error => error.code === 'BUNDLE_REQUEST_INVALID'
  );
  const prepared = await coordinator.bundlePrepare({
    pending_revision: 'p1',
    catalog_revision: 'c1',
    plan_hash: 'ph',
    confirm_cost: true,
    enrichment_confirmation_token: 'enrich-token-123',
  });
  assert.equal(prepared.ok, true);
  assert.equal(passedInput.enrichment_confirmation_token, 'enrich-token-123');
});
