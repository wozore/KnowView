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
const { resolveBatchCandidates, estimateResolutionNeed } = require('./intake/index');
const { loadCatalogSnapshot } = require('./core/index');
const assistant = require('./draft/index');
const draftStore = require('./draft/index');
const bundleDraft = require('./draft/catalog-bundle');
const { codeError, planHashOf, projectDraft, normalizeRecoveryOptions } = require('./catalog-workbench-view');

const REUSABLE_DRAFT_STATES = Object.freeze(['researching', 'preview_ready', 'preview_blocked', 'failed_retryable', 'rolled_back', 'resuming']);
let prepareInFlight = false;

function snapshotOf(options) {
  return typeof options.loadCatalog === 'function' ? options.loadCatalog() : loadCatalogSnapshot();
}
function pendingOf(options) {
  return typeof options.readPending === 'function' ? options.readPending(options) : readPending('tools', options);
}
function approvedCandidates(options) {
  const pending = pendingOf(options);
  return { pending, cards: pending.cards.filter(card => card.review_status === 'approved' && card.entity_type !== 'series') };
}
function candidateKey(card) { return card.candidate_key; }

const CATALOG_DRAFT_SCHEMA_VERSION = 3;
const CATALOG_DRAFT_KIND = 'catalog';
const BUNDLE_PREPARE_FIELDS = new Set(['pending_revision', 'catalog_revision', 'plan_hash', 'confirm_cost', 'enrichment_confirmation_token']);
const BUNDLE_REVIEW_FIELDS = new Set();
const BUNDLE_APPLY_FIELDS = new Set(['draft_id', 'expected_revision', 'bundle_token', 'confirm']);
const BUNDLE_DISCARD_FIELDS = new Set(['expected_revision', 'confirm']);

function assertRequestFields(input, allowed, code, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    throw codeError(code, `${label} 请求字段无效`);
  }
}
function bundleReviewDto(result, draftId) {
  if (!result || result.ok !== true) return { ok: false, code: result?.code || 'BUNDLE_BLOCKED', draft_id: draftId, ...(result?.draft ? { draft: result.draft } : {}), ...(Array.isArray(result?.blockers) ? { blockers: result.blockers } : {}) };
  const previewHash = result.preview_hash || result.previewHash || result.draft?.preview_hash || null;
  const bundleToken = result.bundle_token || result.bundleToken || result.draft?.bundle_token || null;
  const currentRevision = result.current_revision || result.currentRevision || null;
  return { ok: true, status: 'review_ready', draft_id: draftId, current_revision: currentRevision, base_revision: result.draft?.base_revision || currentRevision, preview_hash: previewHash, bundle_token: bundleToken, confirmation: bundleToken ? `APPLY CATALOG BUNDLE ${bundleToken}` : null, discard_confirmation: bundleToken ? `DISCARD CATALOG BUNDLE ${bundleToken}` : null, draft: result.draft || null };
}
function bundleApplyDto(result, applyOptions = {}) {
  if (!result || result.ok !== true) return result || { ok: false, code: 'OPERATION_FAILED' };
  const cleanupPending = result.cleanup_pending === true || (Array.isArray(result.cleanup_pending) && result.cleanup_pending.length > 0);
  const outcomeWarning = result.outcome_warning || null;
  return { ok: true, status: result.status || 'committed', target_revision: result.target_revision || result.targetRevision || null, dist_built: result.dist_built === true || (result.dist_built === undefined && applyOptions.buildDist !== false), cleanup_pending: cleanupPending, cleanup_only: result.cleanup_only === true || result.cleanupOnly === true, outcome_pending: result.outcome_pending === true || Boolean(outcomeWarning), outcome_warning: outcomeWarning };
}
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
  const bundlePlanFn = options.planCatalogBundles || bundleDraft.planCatalogBundles;
  const bundlePrepareFn = options.prepareCatalogBundles || bundleDraft.prepareCatalogBundles;
  const bundleListFn = options.listCatalogBundles || bundleDraft.listCatalogBundles;
  const bundleReadFn = options.readCatalogBundle || bundleDraft.readCatalogBundle;
  const bundleReviewFn = options.reviewCatalogBundle || bundleDraft.reviewCatalogBundle;
  const bundleApplyFn = options.applyCatalogBundle || bundleDraft.applyCatalogBundle;
  const bundleDiscardFn = options.discardCatalogBundle || bundleDraft.discardCatalogBundle;

  function bundleOptions() {
    return { ...options, loadCatalog: () => snapshotOf(options), readPending: options.readPending, setIntakeOutcome: options.setIntakeOutcome, resolveBatchCandidates: options.resolveBatchCandidates, pendingOptions: options.pendingOptions, catalogAdapters: options.catalogAdapters, applyOptions: options.applyOptions };
  }
  function buildPlan() {
    const { pending, cards } = approvedCandidates(options);
    const catalog = snapshotOf(options);
    const seeds = [];
    const blocked = [];
    for (const card of cards) {
      try { seeds.push({ card, seed: pendingCandidateToSeed(card, {}) }); }
      catch (error) { blocked.push({ candidate_key: candidateKey(card), code: String(error?.message || 'PENDING_CANDIDATE_INVALID').split(':')[0] }); }
    }
    if (!cards.length) return { ok: false, code: 'PENDING_CANDIDATE_NOT_APPROVED', pending_revision: pending.revision, catalog_revision: catalog.revision, candidates: [], blocking_reasons: ['没有已批准的工具待补卡'] };
    const plans = [];
    for (const entry of seeds) {
      try {
        const result = planFn(entry.seed, generatorOptions);
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: result.ok, cost_plan: result.cost_plan || null, code: result.code || null });
      } catch (error) {
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: false, code: String(error?.message || 'PLAN_FAILED').split(':')[0] });
      }
    }
    const resolveOptions = { ...generatorOptions, ...(options.resolveOptions || {}) };
    const resolutionNeed = estimateResolutionNeed(cards, resolveOptions);
    const plan = { pending_revision: pending.revision, catalog_revision: catalog.revision, candidates: cards.map(card => candidateKey(card)), entries: plans, blocked, resolution: resolutionNeed };
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
        vendor_search_upper_bound: resolutionNeed.vendor_search_upper_bound,
        vendor_responses_upper_bound: resolutionNeed.vendor_responses_upper_bound,
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
  async function prepare(input = {}) {
    if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    if (prepareInFlight) return { ok: false, code: 'PREPARE_IN_PROGRESS', blocking_reasons: ['已有一轮 Catalog Draft 准备在执行中，请等待其完成后再试。'] };
    prepareInFlight = true;
    try {
      const planned = assertPlan(input);
      if (!planned.ok) return planned;
      const { pending, cards } = approvedCandidates(options);
      const reusableOf = () => listFn().filter(draft => isCatalogDraft(draft) && draft.base_revision === planned.catalog_revision && REUSABLE_DRAFT_STATES.includes(draft.state));
      const matchReusable = (reusable, key, card) => reusable.find(draft => !used.has(draft.draft_id)
        && (draft.seed?.candidate_key === key || (!draft.seed?.candidate_key && String(draft.seed?.name || '').trim().toLowerCase() === String(card.name || '').trim().toLowerCase())));
      const used = new Set();
      const drafts = [];
      const missingCards = [];
      const initialReusable = reusableOf();
      for (const card of cards) {
        const key = candidateKey(card);
        const existing = matchReusable(initialReusable, key, card);
        if (existing) { used.add(existing.draft_id); drafts.push(projectDraft(existing, { candidate_key: key, reused: true })); }
        else missingCards.push(card);
      }
      const resolveOptions = { ...generatorOptions, ...(options.resolveOptions || {}) };
      let resolved = { seeds: [], unresolved: [] };
      if (missingCards.length) {
        try { resolved = await (options.resolveBatchCandidates || resolveBatchCandidates)(missingCards, resolveOptions); }
        catch (error) { return { ok: false, code: 'DRAFT_BLOCKED', blocking_reasons: ['官方来源解析失败'] }; }
      }
      const byName = new Map((resolved.seeds || []).map(seed => [String(seed.name).trim().toLowerCase(), seed]));
      const blocked = [...(resolved.unresolved || []).map(item => ({ name: item.name, code: 'DRAFT_BLOCKED' })), ...(planned.blocked || [])];
      for (const card of missingCards) {
        const key = candidateKey(card);
        const again = matchReusable(reusableOf(), key, card);
        if (again) { used.add(again.draft_id); drafts.push(projectDraft(again, { candidate_key: key, reused: true })); continue; }
        const resolvedSeed = byName.get(String(card.name).trim().toLowerCase());
        if (!resolvedSeed) continue;
        const seed = { ...resolvedSeed, candidate_key: key };
        try {
          const result = await prepareFn(seed, { ...generatorOptions, confirmCost: true, catalogAdapters: options.catalogAdapters });
          if (result && result.draft) drafts.push(projectDraft(result.draft, { candidate_key: key, reused: false }));
          else blocked.push({ candidate_key: key, code: result?.code || 'DRAFT_BLOCKED' });
        } catch (error) { blocked.push({ candidate_key: key, code: String(error?.message || 'DRAFT_BLOCKED').split(':')[0] }); }
      }
      return { ok: drafts.length > 0, status: drafts.length ? 'drafts_ready' : 'drafts_blocked', pending_revision: pending.revision, catalog_revision: planned.catalog_revision, plan_hash: planned.plan_hash, drafts, reused: drafts.filter(draft => draft.reused).map(draft => draft.draft_id), blocked };
    } finally { prepareInFlight = false; }
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
        return projectDraft(draft, {
          cleanup_pending: isCleanup,
          cleanup_only: isCleanup,
          cleanup_action: isCleanup && batchToken ? { draft_ids: draftIds, expected_revision: String(checkpoint?.target_revision || catalogRevision).trim(), batch_token: batchToken, confirm: `APPLY CATALOG DRAFTS ${batchToken}` } : null,
        });
      }),
      count: drafts.length,
    };
  }
  function read(draftId) { return projectDraft(readFn(draftId)); }
  function review(draftId) { const result = reviewFn(draftId); return result.ok ? { ok: true, draft_id: draftId, current_revision: result.currentRevision, preview_hash: result.previewHash, status: 'review_ready' } : { ok: false, code: result.code || 'DRAFT_BLOCKED', draft_id: draftId, status: 'blocked' }; }
  function recoveryPlan(draftId, input = {}) {
    const expectedRevision = String(input.expected_revision || input.expectedRevision || snapshotOf(options).revision || '').trim();
    if (!expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const rawOptions = Object.prototype.hasOwnProperty.call(input, 'generator_options') ? input.generator_options : input.generatorOptions;
    const merged = normalizeRecoveryOptions(rawOptions, generatorOptions);
    const result = recoveryPlanFn(draftId, { expectedRevision, generatorOptions: merged });
    if (!result?.ok) return result;
    return { ...result, generator_options: { model: merged.model, provider: merged.provider, protocol: merged.protocol, retrieval_provider: merged.retrievalProvider, ...(merged.accessMode ? { access_mode: merged.accessMode } : {}) } };
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
  function batchPreview() {
    const { pending } = approvedCandidates(options);
    const allDrafts = listFn().filter(draft => isCatalogDraft(draft) && draft.state !== 'cleanup_pending');
    const blockedDrafts = allDrafts.filter(draft => draft.readiness?.status !== 'ready');
    const drafts = allDrafts.filter(draft => draft.readiness?.status === 'ready');
    const draftIds = drafts.map(draft => draft.draft_id).sort();
    const blockers = blockedDrafts.map(draft => projectDraft(draft));
    if (!draftIds.length) return { ok: false, code: 'DRAFTS_NOT_READY', status: 'blocked', draft_count: 0, source_pending_revision: pending.revision, blockers };
    const checked = batchReviewFn(draftIds, { sourcePendingRevision: pending.revision });
    if (!checked.ok) return { ok: false, code: checked.code || 'DRAFT_BATCH_STALE', status: 'blocked', draft_count: draftIds.length, source_pending_revision: pending.revision, blockers: [...blockers, { code: checked.code || 'DRAFT_BATCH_STALE' }] };
    return { ok: true, status: 'review_ready', expected_revision: checked.currentRevision, source_pending_revision: pending.revision, draft_count: checked.draft_ids.length, drafts: checked.reviews.map(review => projectDraft(review.draft, { change_preview: review.plan.changePreview })), change_preview: checked.plan.changePreview, batch_token: checked.batchToken, blockers };
  }
  function applyBatch(input = {}) {
    const draftIds = input.draft_ids;
    const expectedRevision = String(input.expected_revision || '').trim();
    const batchToken = String(input.batch_token || '').trim();
    if (!Array.isArray(draftIds) || !draftIds.length) return { ok: false, code: 'DRAFT_IDS_INVALID' };
    if (!expectedRevision || !batchToken) return { ok: false, code: 'DRAFT_BATCH_STALE' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFTS ${batchToken}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    const { pending } = approvedCandidates(options);
    const result = batchApplyFn({ draftIds, expectedRevision, batchToken }, { ...(options.applyOptions || {}), buildDist: false, sourcePendingRevision: pending.revision });
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'OPERATION_FAILED' };
    return { ok: true, status: result.status || 'completed', target_revision: result.targetRevision, applied_draft_ids: result.appliedDraftIds || draftIds, cleanup_pending: result.cleanupPending || [], cleanup_only: result.cleanupOnly === true, dist_built: false };
  }
  function bundlePlan() {
    const result = bundlePlanFn(bundleOptions());
    if (!result?.ok) return result;
    return { ...result, enrichment_cost_confirmation_required: true, enrichment_cost: { status: 'member_dependent', message: 'Series 成员官方资料研究与合成成本将在 prepare 阶段按成员上限计入。' } };
  }
  async function bundlePrepare(input = {}) {
    assertRequestFields(input, BUNDLE_PREPARE_FIELDS, 'BUNDLE_REQUEST_INVALID', 'Bundle prepare');
    return bundlePrepareFn(input, bundleOptions());
  }
  function bundleList() {
    const listed = bundleListFn(bundleOptions());
    const listedIds = new Set((listed?.items || []).map(item => item.draft_id));
    const inFlight = listFn().filter(draft => draft.schema_version === 4 && draft.draft_kind === 'series_bundle' && !listedIds.has(draft.draft_id)).map(draft => bundleDraft.projectBundleDraft(draft));
    const items = [...(listed?.items || []), ...inFlight].map(item => {
      const isCleanup = item?.state === 'cleanup_pending';
      const isOutcome = item?.state === 'outcome_pending';
      return {
        ...item,
        ...(item?.bundle_token ? { discard_confirmation: `DISCARD CATALOG BUNDLE ${item.bundle_token}` } : {}),
        cleanup_pending: isCleanup,
        outcome_pending: isOutcome,
        cleanup_only: isCleanup || isOutcome,
        cleanup_action: (isCleanup || isOutcome) && item?.bundle_token ? { draft_id: item.draft_id, expected_revision: snapshotOf(options).revision, bundle_token: item.bundle_token, confirm: `APPLY CATALOG BUNDLE ${item.bundle_token}` } : null,
      };
    });
    return { ...(listed || {}), items, count: items.length };
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
    return result && result.ok === true ? { ok: true, draft_id: draftId, status: 'discarded', outcome: result.outcome || null } : result;
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
    const result = batchApplyFn({ draftIds, expectedRevision, batchToken }, { ...(options.applyOptions || {}), buildDist: false });
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'OPERATION_FAILED' };
    return { ok: true, status: result.status || 'cleanup_only', target_revision: result.targetRevision || expectedRevision, applied_draft_ids: result.appliedDraftIds || draftIds, cleanup_pending: result.cleanupPending || [], cleanup_only: true };
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

module.exports = {
  createCatalogWorkbench,
  planHashOf,
  projectDraft,
  planCatalogPending,
  prepareCatalogPending,
  listCatalogDrafts,
  readCatalogDraft,
  reviewCatalogDraft,
  resumeCatalogDraft,
  recoveryPlanCatalogDraft,
  discardCatalogDraft,
  applyCatalogDraft,
  previewCatalogDraftBatch,
  applyCatalogDraftBatch,
};
