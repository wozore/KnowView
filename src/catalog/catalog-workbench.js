'use strict';
/**
 * Maintainer-only coordinator for approved pending tool candidates.
 *
 * This module deliberately does not call catalog-batch: that module's contract
 * includes automatic Apply.  Every operation here is a single Catalog
 * Assistant Draft operation and remains reviewable until an explicit Apply.
 *
 * Draft 面板投影、恢复诊断与恢复选项归一化在 catalog-workbench-view.js。
 */
const { readPending, pendingCandidateToSeed } = require('../pending/index');
const { estimateResolutionNeed, lookupRegistryForCard } = require('./intake/index');
const { loadCatalogSnapshot } = require('./core/index');
const assistant = require('./draft/index');
const draftStore = require('./draft/index');
const bundleDraft = require('./draft/catalog-bundle');
const { listBundleDraftsForWorkbench } = require('./catalog-workbench-bundle-list');
const { codeError, planHashOf, projectDraft, normalizeRecoveryOptions, assertRequestFields, bundleReviewDto, bundleApplyDto } = require('./catalog-workbench-view');
const { auditNewCatalogBrandIcons } = require('./catalog-brand-icons');
const { createCatalogBatchPreview, staleDraftProjection, supersedeStaleDraftFiles } = require('./catalog-workbench-draft-batch');
const { approvedCatalogCandidates, createCatalogPrepareHandler } = require('./catalog-workbench-prepare');

let prepareInFlight = false;

function snapshotOf(options) { return typeof options.loadCatalog === 'function' ? options.loadCatalog() : loadCatalogSnapshot(); }
function pendingOf(options) { return typeof options.readPending === 'function' ? options.readPending(options) : readPending('tools', options); }
function approvedCandidates(options) { return approvedCatalogCandidates(pendingOf(options), snapshotOf(options), options); }
function candidateKey(card) { return card.candidate_key; }

const CATALOG_DRAFT_SCHEMA_VERSION = 4;
const CATALOG_DRAFT_KIND = 'catalog';
const BUNDLE_PREPARE_FIELDS = new Set(['pending_revision', 'catalog_revision', 'plan_hash', 'confirm_cost', 'enrichment_confirmation_token']);
const BUNDLE_REVIEW_FIELDS = new Set();
const BUNDLE_APPLY_FIELDS = new Set(['draft_id', 'expected_revision', 'bundle_token', 'confirm']);
const BUNDLE_DISCARD_FIELDS = new Set(['expected_revision', 'confirm']);

function isCatalogDraft(draft) {
  return draft && draft.schema_version === CATALOG_DRAFT_SCHEMA_VERSION && (draft.draft_kind || CATALOG_DRAFT_KIND) === CATALOG_DRAFT_KIND;
}

function createCatalogWorkbench(options = {}) {
  const configuredGeneratorOptions = assistant.loadGeneratorConfig();
  const generatorOptions = assistant.normalizeGeneratorOptions({ ...configuredGeneratorOptions, ...(options.generatorOptions || {}) });
  const planFn = options.planCatalogDraft || assistant.planCatalogDraft;
  const prepareFn = options.prepareCatalogDraft || assistant.prepareCatalogDraft;
  const resumeFn = options.resumeCatalogDraft || assistant.resumeCatalogDraft;
  const recoveryPlanFn = options.recoveryPlanForDraft || assistant.recoveryPlanForDraft;
  const reviewFn = options.reviewCatalogDraft || assistant.reviewCatalogDraft;
  const batchReviewFn = options.reviewCatalogDraftBatch || assistant.reviewCatalogDraftBatch;
  const applyFn = options.applyCatalogDraft || assistant.applyCatalogDraft;
  const batchApplyFn = options.applyCatalogDrafts || assistant.applyCatalogDrafts;
  const discardFn = options.discardCatalogDraft || assistant.discardCatalogDraft;
  const listFn = options.listDrafts || draftStore.listDrafts;
  const readFn = options.readDraft || draftStore.readDraft;
  const deleteDraftFn = options.deleteCatalogDraft || (options.listDrafts ? null : draftStore.deleteDraft);
  const batchPreview = createCatalogBatchPreview({
    currentSnapshot: () => snapshotOf(options),
    pendingRevision: () => approvedCandidates(options).pending.revision,
    listDrafts: listFn,
    reviewCatalogDraftBatch: batchReviewFn,
    isCatalogDraft,
    projectDraft,
    inspectNewBrandIcons: (before, after) => auditNewCatalogBrandIcons(before, after, options.brandIconOptions),
  });
  const bundlePlanFn = options.planCatalogBundles || bundleDraft.planCatalogBundles;
  const bundlePrepareFn = options.prepareCatalogBundles || bundleDraft.prepareCatalogBundles;
  const bundleListFn = options.listCatalogBundles || bundleDraft.listCatalogBundles;
  const bundleReadFn = options.readCatalogBundle || bundleDraft.readCatalogBundle;
  const bundleReviewFn = options.reviewCatalogBundle || bundleDraft.reviewCatalogBundle;
  const bundleApplyFn = options.applyCatalogBundle || bundleDraft.applyCatalogBundle;
  const bundleDiscardFn = options.discardCatalogBundle || bundleDraft.discardCatalogBundle;

  function bundleOptions() {
    return {
      ...options,
      generatorOptions,
      resolveOptions: { ...generatorOptions, ...(options.resolveOptions || {}) },
      loadCatalog: () => snapshotOf(options),
      readPending: options.readPending,
      setIntakeOutcome: options.setIntakeOutcome,
      resolveBatchCandidates: options.resolveBatchCandidates,
      pendingOptions: options.pendingOptions,
      catalogAdapters: options.catalogAdapters,
      applyOptions: options.applyOptions,
    };
  }
  function buildPlan() {
    const { pending, cards, completed } = approvedCandidates(options);
    const catalog = snapshotOf(options);
    const seeds = [];
    const blocked = [];
    for (const card of cards) {
      try {
        const registry = lookupRegistryForCard(card, options);
        seeds.push({ card, seed: pendingCandidateToSeed(card, registry.ok ? registry : {}) });
      }
      catch (error) { blocked.push({ candidate_key: candidateKey(card), code: String(error?.message || 'PENDING_CANDIDATE_INVALID').split(':')[0] }); }
    }
    if (!cards.length && !completed.length) return { ok: false, code: 'PENDING_CANDIDATE_NOT_APPROVED', pending_revision: pending.revision, catalog_revision: catalog.revision, candidates: [], blocking_reasons: ['没有已批准的工具待补卡'] };
    const plans = [];
    for (const entry of seeds) {
      try {
        const result = planFn(entry.seed, generatorOptions);
        const placementDeferred = result.code === 'PLACEMENT_REQUIRED_FOR_API_MODEL';
        const registry = placementDeferred ? lookupRegistryForCard(entry.card, options) : null;
        const researchBound = placementDeferred ? {
          seed: pendingCandidateToSeed(entry.card, registry?.ok ? registry : {}),
          research_scopes: [{ kind: 'vendor' }, { kind: 'group' }, { kind: 'detail' }],
        } : null;
        const costPlan = result.cost_plan || (placementDeferred
          ? {
            hard_limits: assistant.researchLimits(generatorOptions, researchBound),
            estimated_extract_fallback_upper_bound: Math.min(3, generatorOptions.maxSearchQueries ?? 4),
          }
          : null);
        plans.push({
          candidate_key: candidateKey(entry.card),
          name: entry.card.name,
          ok: result.ok === true || placementDeferred,
          status: placementDeferred ? 'placement_deferred' : (result.ok ? 'ready' : 'blocked'),
          cost_plan: costPlan,
          code: result.code || null,
        });
      } catch (error) {
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: false, code: String(error?.message || 'PLAN_FAILED').split(':')[0] });
      }
    }
    const resolveOptions = { ...generatorOptions, ...(options.resolveOptions || {}) };
    const resolutionNeed = estimateResolutionNeed(cards, resolveOptions);
    const placementAiUpperBound = resolveOptions.allowAiPlacement === true
      ? cards.filter(card => card.entity_type === 'model' || card.detail_kind_hint === 'api_model').length
      : 0;
    const plan = {
      pending_revision: pending.revision,
      catalog_revision: catalog.revision,
      candidates: cards.map(card => candidateKey(card)),
      entries: plans,
      blocked,
      completed,
      resolution: resolutionNeed,
      placement: { ai_calls_upper_bound: placementAiUpperBound },
    };
    return {
      ok: true,
      status: 'cost_confirmation_required',
      ...plan,
      plan_hash: planHashOf(plan),
      cost_plan: {
        ...plans.reduce((total, entry) => {
          for (const [key, value] of Object.entries(entry.cost_plan?.hard_limits || {})) total[key] = Number(total[key] || 0) + Number(value || 0);
          return total;
        }, {}),
        vendor_search_primary_upper_bound: resolutionNeed.vendor_search_primary_upper_bound,
        vendor_search_fallback_upper_bound: resolutionNeed.vendor_search_fallback_upper_bound,
        vendor_search_upper_bound: resolutionNeed.vendor_search_upper_bound,
        vendor_responses_upper_bound: resolutionNeed.vendor_responses_upper_bound,
        verification_search_primary_upper_bound: resolutionNeed.verification_search_primary_upper_bound,
        verification_search_upper_bound: resolutionNeed.verification_search_upper_bound,
        verification_search_fallback_upper_bound: resolutionNeed.verification_search_fallback_upper_bound,
        verification_extract_upper_bound: resolutionNeed.verification_extract_upper_bound,
        verification_responses_upper_bound: resolutionNeed.verification_responses_upper_bound,
        placement_ai_calls_upper_bound: placementAiUpperBound,
        extract_fallback_upper_bound: plans.reduce((total, entry) => total + Number(entry.cost_plan?.estimated_extract_fallback_upper_bound || 0), 0),
      },
    };
  }
  function assertPlan(input) {
    const current = buildPlan();
    if (!current.ok) return current;
    if (String(input?.pending_revision || '') !== current.pending_revision || String(input?.catalog_revision || '') !== current.catalog_revision) throw codeError('REVISION_CONFLICT');
    if (String(input?.plan_hash || '') !== current.plan_hash) throw codeError('PLAN_CHANGED');
    return current;
  }
  const prepareCatalog = createCatalogPrepareHandler({
    options,
    generatorOptions,
    assertPlan,
    approvedCandidates: () => approvedCandidates(options),
    candidateKey,
    isCatalogDraft,
    listDrafts: listFn,
    planCatalogDraft: planFn,
    prepareCatalogDraft: prepareFn,
    loadCatalog: () => snapshotOf(options),
  });
  async function prepare(input = {}) {
    if (input.confirm_cost !== true) {
      const current = buildPlan();
      if (!current.ok || current.candidates.length || !current.completed.length) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    }
    if (prepareInFlight) return { ok: false, code: 'PREPARE_IN_PROGRESS', blocking_reasons: ['已有一轮 Catalog Draft 准备在执行中，请等待其完成后再试。'] };
    prepareInFlight = true;
    try {
      const result = await prepareCatalog(input);
      if (result?.ok) supersedeStaleDraftFiles({ listDrafts: listFn, currentRevision: snapshotOf(options).revision, isCatalogDraft, deleteDraft: deleteDraftFn });
      return result;
    }
    finally { prepareInFlight = false; }
  }
  function list() {
    const catalogRevision = snapshotOf(options).revision;
    const drafts = listFn().filter(isCatalogDraft);
    return {
      catalog_revision: catalogRevision,
      items: drafts.map(draft => {
        const isCleanup = draft.state === 'cleanup_pending';
        const checkpoint = draft.apply_checkpoint;
        const batchToken = String(checkpoint?.batch_token || '').trim();
        const draftIds = Array.isArray(checkpoint?.draft_ids) ? checkpoint.draft_ids : [draft.draft_id];
        const projected = draft.base_revision !== catalogRevision
          ? staleDraftProjection(draft, catalogRevision, projectDraft)
          : projectDraft(draft);
        return {
          ...projected,
          cleanup_pending: isCleanup,
          cleanup_only: isCleanup,
          cleanup_action: isCleanup && batchToken ? { draft_ids: draftIds, expected_revision: String(checkpoint?.target_revision || catalogRevision).trim(), batch_token: batchToken, confirm: `APPLY CATALOG DRAFTS ${batchToken}` } : null,
        };
      }),
      count: drafts.length,
    };
  }
  function read(draftId) {
    const draft = readFn(draftId);
    const currentRevision = snapshotOf(options).revision;
    return draft.base_revision !== currentRevision ? staleDraftProjection(draft, currentRevision, projectDraft) : projectDraft(draft);
  }
  function review(draftId) { const result = reviewFn(draftId); return result.ok ? { ok: true, draft_id: draftId, current_revision: result.currentRevision, preview_hash: result.previewHash, status: 'review_ready' } : { ok: false, code: result.code || 'DRAFT_BLOCKED', draft_id: draftId, status: 'blocked' }; }
  function recoveryPlan(draftId, input = {}) {
    const expectedRevision = String(input.expected_revision || input.expectedRevision || snapshotOf(options).revision || '').trim();
    if (!expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const rawOptions = Object.prototype.hasOwnProperty.call(input, 'generator_options') ? input.generator_options : input.generatorOptions;
    const merged = normalizeRecoveryOptions(rawOptions, generatorOptions);
    const result = recoveryPlanFn(draftId, { expectedRevision, generatorOptions: merged });
    if (!result?.ok) return result;
    return { ...result, generator_options: { model: merged.model, provider: merged.provider, protocol: merged.protocol, search_provider: merged.searchProvider, search_fallback_provider: merged.searchFallbackProvider, extract_provider: merged.extractProvider, extract_fallback_provider: merged.extractFallbackProvider, search_engine: merged.searchEngine, ...(merged.accessMode ? { access_mode: merged.accessMode } : {}) } };
  }
  async function resume(draftId, input = {}) {
    if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    const expectedRevision = String(input.expected_revision || '').trim();
    if (!expectedRevision || !input.recovery_token) return { ok: false, code: 'RECOVERY_TOKEN_REQUIRED' };
    let merged;
    try { merged = normalizeRecoveryOptions(input.generator_options, generatorOptions); }
    catch (error) { return { ok: false, code: error.code || 'RECOVERY_OPTIONS_INVALID' }; }
    const plan = recoveryPlan(draftId, { expected_revision: expectedRevision, generator_options: input.generator_options });
    if (!plan.ok) return plan;
    if (plan.recovery_token !== input.recovery_token) return { ok: false, code: 'RECOVERY_TOKEN_CHANGED' };
    const result = await resumeFn(draftId, { ...merged, confirmCost: true, expectedRevision, recoveryToken: input.recovery_token, catalogAdapters: options.catalogAdapters });
    return result && result.draft ? { ok: result.ok, draft: projectDraft(result.draft), code: result.code || null } : { ok: false, code: result?.code || 'DRAFT_BLOCKED' };
  }
  function discard(draftId, input = {}) {
    const expectedRevision = String(input?.expected_revision || '').trim();
    if (!expectedRevision || snapshotOf(options).revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId };
    const result = discardFn(draftId);
    return { ok: result.ok === true, draft_id: draftId, code: result.ok ? null : result.code || 'OPERATION_FAILED' };
  }
  function apply(input = {}) {
    const draftId = String(input.draft_id || '').trim();
    const expectedRevision = String(input.expected_revision || '').trim();
    const previewHash = String(input.preview_hash || '').trim();
    if (!/^draft-[A-Za-z0-9-]+$/.test(draftId)) return { ok: false, code: 'DRAFT_ID_INVALID' };
    if (!expectedRevision || !previewHash) return { ok: false, code: 'DRAFT_BLOCKED' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFT ${draftId}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    const checked = review(draftId);
    if (!checked.ok) return checked;
    if (checked.preview_hash !== previewHash || checked.current_revision !== expectedRevision) return { ok: false, code: checked.current_revision !== expectedRevision ? 'REVISION_CONFLICT' : 'PREVIEW_CHANGED' };
    const result = applyFn({ draftId, previewHash, expectedRevision }, options.applyOptions || {});
    return result && result.ok ? { ok: true, status: 'completed', draft_id: draftId, target_revision: result.targetRevision } : { ok: false, code: result?.code || 'OPERATION_FAILED' };
  }
  function applyBatch(input = {}) {
    const draftIds = input.draft_ids;
    const expectedRevision = String(input.expected_revision || '').trim();
    const batchToken = String(input.batch_token || '').trim();
    if (!Array.isArray(draftIds) || !draftIds.length) return { ok: false, code: 'DRAFT_IDS_INVALID' };
    if (!expectedRevision || !batchToken) return { ok: false, code: 'DRAFT_BATCH_STALE' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFTS ${batchToken}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    const { pending } = approvedCandidates(options);
    const result = batchApplyFn({ draftIds, expectedRevision, batchToken }, { ...(options.applyOptions || {}), sourcePendingRevision: pending.revision });
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'OPERATION_FAILED' };
    return { ok: true, status: result.status || 'completed', target_revision: result.targetRevision, applied_draft_ids: result.appliedDraftIds || draftIds, cleanup_pending: result.cleanupPending || [], cleanup_only: result.cleanupOnly === true, dist_requested: result.dist_requested === true, dist_built: result.dist_built === true, dist_pending: result.dist_pending === true, outcome_pending: result.outcome_pending === true, ...(result.outcome_warning ? { outcome_warning: result.outcome_warning } : {}) };
  }
  function bundlePlan() {
    const result = bundlePlanFn(bundleOptions());
    if (!result?.ok) return result;
    if (result.retry_summary?.projection_repair) {
      return { ...result, enrichment_cost_confirmation_required: false, enrichment_cost: { status: 'none', message: '只重建已有成员资料的 Bundle 投影，不新增搜索、抓取或合成成本。' } };
    }
    return { ...result, enrichment_cost_confirmation_required: true, enrichment_cost: { status: 'member_dependent', message: 'Series 成员官方资料研究与合成成本将在 prepare 阶段按成员上限计入。' } };
  }
  async function bundlePrepare(input = {}) {
    assertRequestFields(input, BUNDLE_PREPARE_FIELDS, 'BUNDLE_REQUEST_INVALID', 'Bundle prepare');
    return bundlePrepareFn(input, bundleOptions());
  }
  function bundleList() {
    return listBundleDraftsForWorkbench({
      listBundles: bundleListFn,
      listDrafts: listFn,
      bundleOptions: bundleOptions(),
      projectBundleDraft: bundleDraft.projectBundleDraft,
      currentRevision: snapshotOf(options).revision,
    });
  }
  function bundleRead(draftId) {
    const result = bundleReadFn(draftId, bundleOptions());
    if (!result || result.ok === false || !result.bundle_token) return result;
    const isCleanup = result.state === 'cleanup_pending';
    const isOutcome = result.state === 'outcome_pending';
    return {
      ...result,
      discard_confirmation: `DISCARD CATALOG BUNDLE ${result.bundle_token}`,
      cleanup_pending: isCleanup,
      outcome_pending: isOutcome,
      cleanup_only: isCleanup || isOutcome,
      cleanup_action: (isCleanup || isOutcome) ? { draft_id: draftId, expected_revision: snapshotOf(options).revision, bundle_token: result.bundle_token, confirm: `APPLY CATALOG BUNDLE ${result.bundle_token}` } : null,
    };
  }
  function bundleReview(draftId, input = {}) {
    assertRequestFields(input, BUNDLE_REVIEW_FIELDS, 'BUNDLE_REQUEST_INVALID', 'Bundle review');
    try {
      const stored = readFn(draftId);
      if (stored?.schema_version === 4 && stored?.draft_kind === 'series_bundle' && stored?.state === 'cleanup_pending') {
        return { ok: false, code: 'BUNDLE_REVIEW_FORBIDDEN', draft_id: draftId, status: 'blocked', cleanup_pending: true };
      }
    } catch {}
    return bundleReviewDto(bundleReviewFn(draftId, bundleOptions()), draftId);
  }
  async function bundleApply(input = {}) {
    assertRequestFields(input, BUNDLE_APPLY_FIELDS, 'BUNDLE_REQUEST_INVALID', 'Bundle apply');
    try {
      const stored = readFn(input.draft_id);
      if (stored?.schema_version === 4 && stored?.draft_kind === 'series_bundle' && stored?.state === 'cleanup_pending') {
        const current = snapshotOf(options);
        if (current.revision !== input.expected_revision) return { ok: false, code: 'REVISION_CONFLICT', current_revision: current.revision };
        if (stored.bundle_token !== input.bundle_token) return { ok: false, code: 'BUNDLE_TOKEN_CHANGED', draft_id: input.draft_id };
        if (input.confirm !== `APPLY CATALOG BUNDLE ${input.bundle_token}`) return { ok: false, code: 'CONFIRMATION_INVALID', draft_id: input.draft_id };
        try {
          draftStore.deleteDraft(input.draft_id);
          return bundleApplyDto({ ok: true, status: 'cleanup_only', target_revision: current.revision, cleanup_only: true, cleanup_pending: false, outcome_pending: false }, options.applyOptions || {});
        } catch (error) {
          return bundleApplyDto({ ok: true, status: 'cleanup_pending', target_revision: current.revision, cleanup_pending: true, cleanup_only: true, outcome_warning: { code: 'DRAFT_DELETE_FAILED', error: error.message } }, options.applyOptions || {});
        }
      }
    } catch {}
    return bundleApplyDto(await bundleApplyFn(input, bundleOptions()), options.applyOptions || {});
  }
  async function bundleDiscard(draftId, input = {}) {
    assertRequestFields(input, BUNDLE_DISCARD_FIELDS, 'BUNDLE_REQUEST_INVALID', 'Bundle discard');
    const draft = bundleRead(draftId);
    if (!draft || draft.ok === false || !draft.bundle_token) return draft || { ok: false, code: 'BUNDLE_BLOCKED', draft_id: draftId };
    if (draft.state === 'cleanup_pending') return { ok: false, code: 'BUNDLE_DISCARD_FORBIDDEN', draft_id: draftId };
    if (input.confirm !== draft.discard_confirmation) return { ok: false, code: 'CONFIRMATION_INVALID', draft_id: draftId };
    const result = await bundleDiscardFn(draftId, { expected_revision: input.expected_revision, allowBundleDiscard: true, operation: 'catalog-bundle-discard' }, bundleOptions());
    return result && result.ok === true
      ? {
        ok: true,
        draft_id: draftId,
        status: 'discarded',
        outcome: result.outcome || null,
        ...(result.candidate_missing === true ? { candidate_missing: true } : {}),
        ...(result.outcome_warning ? { outcome_warning: result.outcome_warning } : {}),
      }
      : result;
  }
  function cleanup(input = {}) {
    const draftIds = input.draft_ids;
    const expectedRevision = String(input.expected_revision || '').trim();
    const batchToken = String(input.batch_token || '').trim();
    if (!Array.isArray(draftIds) || !draftIds.length) return { ok: false, code: 'DRAFT_IDS_INVALID' };
    if (!expectedRevision || !batchToken) return { ok: false, code: 'DRAFT_BATCH_STALE' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFTS ${batchToken}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    if (snapshotOf(options).revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const drafts = listFn().filter(isCatalogDraft);
    const cleanupDrafts = draftIds.map(id => drafts.find(draft => draft.draft_id === id));
    if (cleanupDrafts.some(draft => !draft || draft.state !== 'cleanup_pending')) return { ok: false, code: 'DRAFTS_NOT_READY' };
    const result = batchApplyFn({ draftIds, expectedRevision, batchToken }, { ...(options.applyOptions || {}) });
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'OPERATION_FAILED' };
    return { ok: true, status: result.status || 'cleanup_only', target_revision: result.targetRevision || expectedRevision, applied_draft_ids: result.appliedDraftIds || draftIds, cleanup_pending: result.cleanupPending || [], cleanup_only: true, dist_requested: result.dist_requested === true, dist_built: result.dist_built === true, dist_pending: result.dist_pending === true };
  }
  return Object.freeze({ plan: buildPlan, prepare, list, read, resume, recoveryPlan, review, discard, apply, batchPreview, applyBatch, cleanup, bundlePlan, bundlePrepare, bundleList, bundleRead, bundleReview, bundleApply, bundleDiscard });
}

function coordinator(options = {}) { return createCatalogWorkbench(options); }
function planCatalogPending(options = {}) { return coordinator(options).plan(); }
function prepareCatalogPending(input, options = {}) { return coordinator(options).prepare(input); }
function listCatalogDrafts(options = {}) { return coordinator(options).list(); }
function readCatalogDraft(draftId, options = {}) { return coordinator(options).read(draftId); }
function reviewCatalogDraft(draftId, options = {}) { return coordinator(options).review(draftId); }
function resumeCatalogDraft(draftId, input, options = {}) { return coordinator(options).resume(draftId, input); }
function recoveryPlanCatalogDraft(draftId, input = {}, options = {}) { return coordinator(options).recoveryPlan(draftId, input); }
function discardCatalogDraft(draftId, input = {}, options = {}) { return coordinator(options).discard(draftId, input); }
function applyCatalogDraft(input, options = {}) { return coordinator(options).apply(input); }
function previewCatalogDraftBatch(options = {}) { return coordinator(options).batchPreview(); }
function applyCatalogDraftBatch(input, options = {}) { return coordinator(options).applyBatch(input); }
module.exports = { createCatalogWorkbench, planHashOf, projectDraft, planCatalogPending, prepareCatalogPending, listCatalogDrafts, readCatalogDraft, reviewCatalogDraft, resumeCatalogDraft, recoveryPlanCatalogDraft, discardCatalogDraft, applyCatalogDraft, previewCatalogDraftBatch, applyCatalogDraftBatch };
