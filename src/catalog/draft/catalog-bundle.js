'use strict';
const { readPending, setIntakeOutcome } = require('../../pending');
const { loadCatalogSnapshot } = require('../core');
const { loadSeriesPolicy, planSeriesBundle, validateSeriesBundle, bundlePreviewHashOf, bundleTokenOf } = require('../series');
const { finalizeSeriesBundles } = require('../series/series-bundle-finalizer');
const { resolveBatchCandidates, estimateResolutionNeed } = require('../intake');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { createDraft, readDraft, updateDraft, deleteDraft, listDrafts, acquireBundlePrepareLock, releaseBundlePrepareLock } = require('./catalog-draft-store');
const { commitCatalogChange } = require('../transaction');
const { planHashOf } = require('../catalog-workbench-view');
const BUNDLE_SCHEMA_VERSION = 4;
const BUNDLE_DRAFT_KIND = 'series_bundle';
const REUSABLE_STATES = new Set(['preview_ready', 'preview_blocked', 'failed_retryable']);
const LISTABLE_STATES = new Set([...REUSABLE_STATES, 'outcome_pending', 'cleanup_pending', 'enrichment_confirmation_required']);
const activeBundlePrepares = new Map();
function snapshotOf(options) {
  return typeof options.loadCatalog === 'function' ? options.loadCatalog() : loadCatalogSnapshot();
}
function pendingOf(options) {
  return typeof options.readPending === 'function' ? options.readPending(options) : readPending('tools', options);
}
function seriesCards(options) {
  const pending = pendingOf(options);
  return {
    pending,
    cards: pending.cards.filter(card => card.review_status === 'approved' && card.entity_type === 'series'),
  };
}
function projectBundleDraft(draft, extra = {}) {
  if (!draft) return null;
  const bundle = draft.bundle || {};
  return {
    draft_id: draft.draft_id,
    draft_kind: draft.draft_kind || BUNDLE_DRAFT_KIND,
    schema_version: draft.schema_version,
    state: draft.state,
    base_revision: draft.base_revision,
    bundle_id: draft.bundle_id || bundle.bundle_id || null,
    bundle_token: draft.bundle_token || bundle.bundle_token || null,
    candidate: bundle.candidate || draft.seed || null,
    vendor_key: bundle.vendor_key || null,
    series: bundle.series || null,
    members: (bundle.members || []).map(member => ({
      name: member.name,
      model_key: member.model_key || null,
      classification: member.classification,
      detail_id: member.detail_id || null,
      tool_card_id: member.tool_card_id || null,
      blocking_reasons: member.blocking_reasons || [],
    })),
    deferred_models: bundle.deferred_models || [],
    readiness: draft.readiness || { status: 'blocked', blocking_reasons: [] },
    cost: bundle.cost || draft.cost || null,
    enrichment_confirmation_token: bundle.enrichment_confirmation_token || null,
    enrichment_hard_limits: bundle.enrichment_hard_limits || null,
    preview_hash: bundle.preview_hash || draft.preview_hash || null,
    last_error: draft.last_error || null,
    updated_at: draft.updated_at || null,
    ...extra,
  };
}
function planCatalogBundles(options = {}) {
  const { pending, cards } = seriesCards(options);
  const catalog = snapshotOf(options);
  if (!cards.length) {
    return {
      ok: false,
      code: 'SERIES_CANDIDATE_NOT_APPROVED',
      pending_revision: pending.revision,
      catalog_revision: catalog.revision,
      candidates: [],
      blocking_reasons: ['没有已批准的模型系列待补卡'],
    };
  }
  const plan = {
    pending_revision: pending.revision,
    catalog_revision: catalog.revision,
    candidates: cards.map(card => ({ candidate_key: card.candidate_key, name: card.name })),
    resolution: estimateResolutionNeed(cards, options.resolveOptions || options),
  };
  return {
    ok: true,
    status: 'cost_confirmation_required',
    ...plan,
    plan_hash: planHashOf(plan),
    cost_plan: plan.resolution,
  };
}
function assertPlan(input, options) {
  const planned = planCatalogBundles(options);
  if (!planned.ok) return planned;
  if (String(input?.pending_revision || '') !== planned.pending_revision
    || String(input?.catalog_revision || '') !== planned.catalog_revision) {
    const error = new Error('REVISION_CONFLICT');
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  if (String(input?.plan_hash || '') !== planned.plan_hash) {
    const error = new Error('PLAN_CHANGED');
    error.code = 'PLAN_CHANGED';
    throw error;
  }
  return planned;
}
function bundleReadiness(bundle) {
  const blockers = Array.isArray(bundle?.blockers) ? bundle.blockers : [];
  return {
    status: bundle?.readiness === 'ready' && !blockers.length ? 'ready' : 'blocked',
    blocking_reasons: [...blockers],
    warnings: [],
  };
}
function createBundleDraft(bundle, card, stateOverride = null) {
  const readiness = bundleReadiness(bundle);
  return createDraft({
    schema_version: BUNDLE_SCHEMA_VERSION,
    draft_kind: BUNDLE_DRAFT_KIND,
    state: stateOverride || (readiness.status === 'ready' ? 'preview_ready' : 'preview_blocked'),
    base_revision: bundle.base_revisions.catalog,
    seed: { candidate_key: card.candidate_key, name: card.name, entity_type: 'series' },
    bundle,
    bundle_id: bundle.bundle_id,
    bundle_token: bundle.bundle_token,
    layer_patches: bundle.layer_patches,
    cost: bundle.cost,
    preview_hash: bundle.preview_hash,
    readiness,
    last_error: readiness.status === 'ready' ? null : { code: readiness.blocking_reasons[0] || 'BUNDLE_BLOCKED' },
  });
}
function enrichmentLimitsFor(memberCount, options) { return options.enrichmentLimits || options.costPlan?.hard_limits || { search_queries: memberCount * 3, pages: memberCount * 8, responses_calls: memberCount * 8, synthesis_calls: memberCount }; }
function bundledMembersOf(bundles) { return bundles.flatMap(bundle => (bundle.members || []).filter(member => member.classification === 'bundled')); }
function directEnrichmentAvailable(member, options) { const values = options.memberEnrichment || options.enrichmentResults; return Boolean(values && Object.prototype.hasOwnProperty.call(values, member.model_key || member.name)); }
function enrichmentConfirmationToken(plan, bundles, limits) { return `enrich-${planHashOf({ plan_hash: plan.plan_hash, limits, members: bundles.map(bundle => ({ candidate_key: bundle.candidate?.candidate_key, members: (bundle.members || []).filter(member => member.classification === 'bundled').map(member => member.model_key || member.name) })) }).slice(-24)}`; }
function hasEnrichmentConfirmation(input, token) { return input.enrichment_confirmation_token === token || input.enrichment_confirmation === token || input.confirmation_token === token || input.confirm_enrichment === token || (input.confirm_enrichment === true && input.enrichment_confirmation_token === token) || (input.confirm_enrichment_cost === true && input.enrichment_confirmation_token === token); }

async function prepareCatalogBundlesImpl(input = {}, options = {}, planned = null) {
  const plan = planned || assertPlan(input, options);
  if (!plan.ok) return plan;
  const { pending, cards } = seriesCards(options);
  const resolveOptions = { ...(options.resolveOptions || {}), ...(options.catalogAdapters ? { identityAdapters: options.catalogAdapters } : {}) };
  const existing = new Map(listDrafts({ schema_version: BUNDLE_SCHEMA_VERSION, draft_kind: BUNDLE_DRAFT_KIND })
    .filter(draft => REUSABLE_STATES.has(draft.state))
    .filter(draft => draft.base_revision === plan.catalog_revision)
    .map(draft => [draft.seed?.candidate_key || draft.bundle?.candidate?.candidate_key, draft]));
  const drafts = [];
  const blocked = [];
  for (const card of cards) {
    const reusable = existing.get(card.candidate_key);
    if (reusable) drafts.push(projectBundleDraft(reusable));
  }
  let resolved;
  const unresolvedCards = cards.filter(card => !existing.has(card.candidate_key));
  try {
    resolved = unresolvedCards.length
      ? await (options.resolveBatchCandidates || resolveBatchCandidates)(unresolvedCards, resolveOptions)
      : { series_candidates: [], verification_blocked: [], unresolved: [], intake_outcomes: [] };
  } catch (error) {
    return { ok: false, code: 'SERIES_RESOLUTION_FAILED', error: error.message, drafts };
  }
  blocked.push(...(resolved.verification_blocked || []), ...(resolved.unresolved || []));
  const snapshot = snapshotOf(options);
  const policy = options.policy || loadSeriesPolicy();
  const bridge = readModelIdentityBridge(options.bridgeFile);
  const byKey = new Map(cards.map(card => [card.candidate_key, card]));
  const plannedBundles = [];
  for (const item of resolved.series_candidates || []) {
    const card = byKey.get(item.candidate_key) || { candidate_key: item.candidate_key, name: item.name };
    const plannedBundle = planSeriesBundle({ candidate: { candidate_key: item.candidate_key, name: item.name, entity_type: 'series' }, verdict: item.verdict, subModelVerdicts: item.members, policy, snapshot: snapshot.snapshot, receipts: item.receipt ? [item.receipt] : [], bridgeRevision: bridge.revision, now: options.now || new Date() });
    if (!plannedBundle.ok) { blocked.push({ candidate_key: item.candidate_key, name: item.name, code: plannedBundle.code, blocking_reasons: plannedBundle.blockers }); continue; }
    plannedBundles.push({ item, card, bundle: plannedBundle.bundle });
  }
  const bundledMembers = bundledMembersOf(plannedBundles.map(entry => entry.bundle));
  const enrichmentLimits = enrichmentLimitsFor(bundledMembers.length, options);
  const enrichmentToken = enrichmentConfirmationToken(plan, plannedBundles.map(entry => entry.bundle), enrichmentLimits);
  const needsConfirmation = bundledMembers.length > 0 && bundledMembers.some(member => !directEnrichmentAvailable(member, options));
  if (needsConfirmation && !hasEnrichmentConfirmation(input, enrichmentToken)) {
    const hasToken = input.enrichment_confirmation_token || input.enrichment_confirmation || input.confirmation_token || input.confirm_enrichment || input.confirm_enrichment_cost;
    return { ok: false, code: hasToken ? 'ENRICHMENT_CONFIRMATION_INVALID' : 'ENRICHMENT_COST_CONFIRMATION_REQUIRED', status: 'enrichment_cost_confirmation_required', pending_revision: pending.revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, enrichment_confirmation_token: enrichmentToken, enrichment_hard_limits: enrichmentLimits, cost_plan: { ...(plan.cost_plan || {}), hard_limits: enrichmentLimits }, drafts, blocked, resolution: { series_candidates: (resolved.series_candidates || []).length, verification_blocked: resolved.verification_blocked || [], intake_outcomes: resolved.intake_outcomes || [] } };
  }
  const finalized = await finalizeSeriesBundles(plannedBundles, { snapshot: snapshot.snapshot, policy, bridgeRevision: bridge.revision, adapters: options.bundleAdapters || options.catalogAdapters, generatorOptions: options.generatorOptions || options, enrichmentLimits, enrichmentConfirmationToken: enrichmentToken, sharedLedger: options.sharedLedger, enrichmentSpent: options.enrichmentSpent || options.costSpent, memberEnrichment: options.memberEnrichment || options.enrichmentResults, enrichMember: options.enrichMember, requireInjectedAdapters: options.requireInjectedAdapters, validate: value => validateSeriesBundle(value, { snapshot: snapshot.snapshot, policy, bridgeRevision: bridge.revision }) });
  for (const { item, card, finalized: result } of finalized.results) {
    const draft = createBundleDraft(result.bundle, card);
    drafts.push(projectBundleDraft(draft));
    if (options.setIntakeOutcome !== null) {
      try { await (options.setIntakeOutcome || setIntakeOutcome)('tools', item.candidate_key, 'bundled_for_review', pending.revision, options.pendingOptions || {}); }
      catch (error) { blocked.push({ candidate_key: item.candidate_key, name: item.name, code: error.code || 'INTAKE_OUTCOME_WRITE_FAILED' }); }
    }
  }
  return { ok: drafts.length > 0, status: drafts.length ? 'bundles_ready' : 'bundles_blocked', pending_revision: pending.revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, drafts, blocked, resolution: { series_candidates: (resolved.series_candidates || []).length, verification_blocked: resolved.verification_blocked || [], intake_outcomes: resolved.intake_outcomes || [] } };
}
async function prepareCatalogBundles(input = {}, options = {}) {
  if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
  const planned = assertPlan(input, options);
  if (!planned.ok) return planned;
  const key = `${planned.pending_revision}:${planned.catalog_revision}:${planned.plan_hash}`;
  if (activeBundlePrepares.has(key)) return activeBundlePrepares.get(key);
  const task = (async () => {
    let lock;
    try { lock = acquireBundlePrepareLock(); }
    catch (error) {
      if (error?.code === 'EEXIST') return { ok: false, code: 'PREPARE_IN_PROGRESS' };
      throw error;
    }
    try { return await prepareCatalogBundlesImpl(input, options, planned); }
    finally {
      try { releaseBundlePrepareLock(lock); } catch {}
    }
  })();
  activeBundlePrepares.set(key, task);
  try { return await task; }
  finally { activeBundlePrepares.delete(key); }
}
function reviewCatalogBundle(draftId, options = {}) {
  const draft = readDraft(draftId);
  if (draft.schema_version !== BUNDLE_SCHEMA_VERSION || draft.draft_kind !== BUNDLE_DRAFT_KIND) return { ok: false, code: 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED', draft_id: draftId };
  const current = snapshotOf(options);
  if (draft.base_revision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId, currentRevision: current.revision, baseRevision: draft.base_revision };
  const policy = options.policy || loadSeriesPolicy();
  const bridge = readModelIdentityBridge(options.bridgeFile);
  if (Array.isArray(bridge.validation_errors) && bridge.validation_errors.length) {
    return { ok: false, code: 'BRIDGE_INVALID', draft_id: draftId, blockers: ['BRIDGE_INVALID'], validation_errors: bridge.validation_errors };
  }
  const checked = validateSeriesBundle(draft.bundle, { snapshot: current.snapshot, policy, bridgeRevision: bridge.revision });
  if (!checked.ok || draft.bundle.readiness !== 'ready') {
    return { ok: false, code: checked.blockers[0] || 'BUNDLE_BLOCKED', draft_id: draftId, draft: projectBundleDraft(draft), blockers: checked.blockers };
  }
  if (draft.bundle.preview_hash !== bundlePreviewHashOf(draft.bundle)) {
    return { ok: false, code: 'BUNDLE_PREVIEW_CHANGED', draft_id: draftId, draft: projectBundleDraft(draft) };
  }
  if (draft.bundle.bundle_token !== bundleTokenOf(draft.bundle)) {
    return { ok: false, code: 'BUNDLE_TOKEN_CHANGED', draft_id: draftId, draft: projectBundleDraft(draft) };
  }
  return {
    ok: true,
    draft_id: draftId,
    draft: projectBundleDraft(draft),
    bundle: draft.bundle,
    currentRevision: current.revision,
    previewHash: draft.bundle.preview_hash,
    bundleToken: draft.bundle.bundle_token,
  };
}
async function writeBundleOutcome(candidateKey, outcome, options = {}) {
  if (!candidateKey || options.setIntakeOutcome === null) return { ok: true, skipped: true };
  const setFn = options.setIntakeOutcome || setIntakeOutcome;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = pendingOf(options);
    try {
      await setFn('tools', candidateKey, outcome, pending.revision, options.pendingOptions || {});
      return { ok: true, outcome };
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT' || attempt === 2) {
        return { ok: false, code: error?.code || 'INTAKE_OUTCOME_WRITE_FAILED', error: error?.message };
      }
    }
  }
  return { ok: false, code: 'INTAKE_OUTCOME_WRITE_FAILED' };
}

async function cleanupCommittedBundle(stored, input, options = {}) {
  const checkpoint = stored.apply_checkpoint || {};
  const targetRevision = checkpoint.target_revision || checkpoint.targetRevision || null;
  const expectedRevision = String(input.expected_revision || '').trim();
  if (targetRevision && expectedRevision !== targetRevision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: targetRevision, target_revision: targetRevision };
  const current = snapshotOf(options);
  if (expectedRevision && current.revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, target_revision: targetRevision };
  const outcome = await writeBundleOutcome(stored.bundle?.candidate?.candidate_key, 'committed', options);
  if (!outcome.ok) {
    const nextCheckpoint = { ...checkpoint, target_revision: targetRevision, cleanup_attempted_at: new Date().toISOString() };
    updateDraft(stored.draft_id, { state: 'cleanup_pending', apply_checkpoint: nextCheckpoint, last_error: outcome }, 'catalog-bundle-cleanup-pending');
    return { ok: true, status: 'cleanup_pending', cleanup_pending: true, target_revision: targetRevision, outcome_warning: outcome };
  }
  try { deleteDraft(stored.draft_id); }
  catch (error) {
    const nextCheckpoint = { ...checkpoint, target_revision: targetRevision, committed_at: checkpoint.committed_at || new Date().toISOString(), cleanup_attempted_at: new Date().toISOString() };
    updateDraft(stored.draft_id, { state: 'cleanup_pending', apply_checkpoint: nextCheckpoint, last_error: { code: 'DRAFT_DELETE_FAILED', error: error.message } }, 'catalog-bundle-cleanup-pending');
    return { ok: true, status: 'cleanup_pending', cleanup_pending: true, target_revision: targetRevision, outcome_warning: null };
  }
  return { ok: true, status: 'cleanup_only', cleanup_only: true, target_revision: targetRevision, outcome_warning: null };
}
async function applyCatalogBundle(input = {}, options = {}) {
  const draftId = String(input.draft_id || '').trim();
  const expectedRevision = String(input.expected_revision || '').trim();
  const bundleToken = String(input.bundle_token || '').trim();
  if (!/^draft-[A-Za-z0-9-]+$/.test(draftId)) return { ok: false, code: 'DRAFT_ID_INVALID' };
  if (!expectedRevision || !bundleToken) return { ok: false, code: 'BUNDLE_BLOCKED' };
  if (String(input.confirm || '') !== `APPLY CATALOG BUNDLE ${bundleToken}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
  const stored = readDraft(draftId);
  if (stored.schema_version !== BUNDLE_SCHEMA_VERSION || stored.draft_kind !== BUNDLE_DRAFT_KIND) return { ok: false, code: 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED', draft_id: draftId };
  if (stored.state === 'outcome_pending' || stored.state === 'cleanup_pending') {
    if (stored.bundle_token !== bundleToken) return { ok: false, code: 'BUNDLE_TOKEN_CHANGED', draft_id: draftId };
    return cleanupCommittedBundle(stored, input, options);
  }
  const checked = reviewCatalogBundle(draftId, options);
  if (!checked.ok) return checked;
  if (checked.bundleToken !== bundleToken || checked.currentRevision !== expectedRevision) return { ok: false, code: checked.currentRevision !== expectedRevision ? 'REVISION_CONFLICT' : 'BUNDLE_TOKEN_CHANGED' };
  const bridge = readModelIdentityBridge(options.bridgeFile);
  const merged = new Map(bridge.entries.map(entry => [entry.model_key, entry]));
  for (const entry of checked.bundle.bridge_entries || []) merged.set(entry.model_key, entry);
  updateDraft(draftId, { state: 'applying', apply_checkpoint: { started_at: new Date().toISOString() } }, 'catalog-bundle-apply-start');
  const result = commitCatalogChange(null, {
    ...(options.applyOptions || {}),
    draftId,
    expectedRevision,
    expectedBridgeRevision: checked.bundle.base_revisions.bridge,
    layerPatches: checked.bundle.layer_patches,
    bridgeEntries: [...merged.values()],
    operation: 'catalog-bundle',
  });
  if (!result.ok) {
    updateDraft(draftId, { state: 'failed_retryable', last_error: result }, 'catalog-bundle-apply-failed');
    return result;
  }
  const candidateKey = checked.bundle.candidate?.candidate_key;
  const outcome = await writeBundleOutcome(candidateKey, 'committed', options);
  if (!outcome.ok) {
    const checkpoint = { ...(readDraft(draftId).apply_checkpoint || {}), committed_at: new Date().toISOString(), target_revision: result.targetRevision };
    updateDraft(draftId, { state: 'outcome_pending', apply_checkpoint: checkpoint, last_error: outcome }, 'catalog-bundle-outcome-pending');
    return { ok: true, status: 'committed', targetRevision: result.targetRevision, target_revision: result.targetRevision, outcome_pending: true, outcome_warning: outcome };
  }
  try { deleteDraft(draftId); }
  catch (error) {
    const checkpoint = { ...(readDraft(draftId).apply_checkpoint || {}), committed_at: new Date().toISOString(), target_revision: result.targetRevision };
    updateDraft(draftId, { state: 'cleanup_pending', apply_checkpoint: checkpoint, last_error: { code: 'DRAFT_DELETE_FAILED', error: error.message } }, 'catalog-bundle-cleanup-pending');
    return { ok: true, status: 'committed', cleanup_pending: true, targetRevision: result.targetRevision, target_revision: result.targetRevision, outcome_warning: null };
  }
  return { ok: true, status: 'committed', targetRevision: result.targetRevision, target_revision: result.targetRevision, outcome_warning: null };
}
function listCatalogBundles(options = {}) {
  const items = listDrafts({ schema_version: BUNDLE_SCHEMA_VERSION, draft_kind: BUNDLE_DRAFT_KIND }).filter(draft => LISTABLE_STATES.has(draft.state));
  return { catalog_revision: snapshotOf(options).revision, items: items.map(projectBundleDraft), count: items.length };
}
function readCatalogBundle(draftId) {
  const draft = readDraft(draftId);
  if (draft.schema_version !== BUNDLE_SCHEMA_VERSION || draft.draft_kind !== BUNDLE_DRAFT_KIND) {
    return { ok: false, code: 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED', draft_id: draftId };
  }
  return projectBundleDraft(draft);
}
async function discardCatalogBundle(draftId, input = {}, options = {}) {
  const expectedRevision = String(input.expected_revision || '').trim();
  const current = snapshotOf(options);
  if (!expectedRevision || current.revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId };
  const draft = readDraft(draftId);
  if (draft.schema_version !== BUNDLE_SCHEMA_VERSION || draft.draft_kind !== BUNDLE_DRAFT_KIND) return { ok: false, code: 'BUNDLE_DRAFT_SCHEMA_UNSUPPORTED', draft_id: draftId };
  if (draft.state === 'cleanup_pending') {
    if (input.allowBundleDiscard !== true && input.operation !== 'catalog-bundle-discard') return { ok: false, code: 'BUNDLE_DISCARD_CONFIRMATION_REQUIRED', draft_id: draftId };
    return cleanupCommittedBundle(draft, { expected_revision: expectedRevision }, options);
  }
  if (!REUSABLE_STATES.has(draft.state)) return { ok: false, code: 'BUNDLE_DISCARD_FORBIDDEN', draft_id: draftId };
  if (input.allowBundleDiscard !== true && input.operation !== 'catalog-bundle-discard') {
    return { ok: false, code: 'BUNDLE_DISCARD_CONFIRMATION_REQUIRED', draft_id: draftId };
  }
  const candidateKey = draft.bundle?.candidate?.candidate_key || draft.seed?.candidate_key;
  if (candidateKey && options.setIntakeOutcome !== null) {
    const setFn = options.setIntakeOutcome || setIntakeOutcome;
    let outcome;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = pendingOf(options);
      try {
        outcome = await setFn('tools', candidateKey, 'pending', pending.revision, {
          ...(options.pendingOptions || {}),
          allowBundleDiscard: true,
          operation: 'catalog-bundle-discard',
        });
        break;
      } catch (error) {
        if (error?.code !== 'REVISION_CONFLICT' || attempt === 2) {
          return { ok: false, code: error.code || 'INTAKE_OUTCOME_WRITE_FAILED', draft_id: draftId, error: error.message };
        }
      }
    }
    if (outcome === false) return { ok: false, code: 'INTAKE_OUTCOME_WRITE_FAILED', draft_id: draftId };
  }
  return { ok: deleteDraft(draftId), draft_id: draftId, outcome: candidateKey ? 'pending' : null };
}
module.exports = {
  BUNDLE_SCHEMA_VERSION,
  BUNDLE_DRAFT_KIND,
  projectBundleDraft,
  planCatalogBundles,
  prepareCatalogBundles,
  listCatalogBundles,
  readCatalogBundle,
  reviewCatalogBundle,
  applyCatalogBundle,
  discardCatalogBundle,
};
