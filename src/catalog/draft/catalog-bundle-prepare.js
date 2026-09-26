'use strict';

const { setIntakeOutcome } = require('../../pending');
const { loadSeriesPolicy, planSeriesBundle, validateSeriesBundle, bundlePreviewHashOf, bundleTokenOf, profileModalityForFamily, taskTypesForMember } = require('../series');
const { finalizeSeriesBundles } = require('../series/series-bundle-finalizer');
const { resolveBatchCandidates } = require('../intake');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { readDraft } = require('./catalog-draft-store');
const { fingerprint, hasSafeBundleEvidence, prepareRetryBundle, aggregateRetryBudgets, sumMaps } = require('./catalog-bundle-retry');

function reconcileBundlePatchOperations(bundle, snapshot) {
  const errors = [];
  for (const patch of bundle.layer_patches || []) {
    if (patch.operation === 'noop') continue;
    if (!['create', 'replace'].includes(patch.operation)) {
      errors.push({ area: patch.area, id: patch.id, code: 'BUNDLE_PATCH_OPERATION_INVALID' });
      continue;
    }
    const records = snapshot?.[patch.area];
    if (!Array.isArray(records) || !patch.record || patch.record.id !== patch.id) {
      errors.push({ area: patch.area, id: patch.id, code: 'BUNDLE_PATCH_RECORD_INVALID' });
      continue;
    }
    patch.operation = records.some(record => record.id === patch.id) ? 'replace' : 'create';
  }
  return errors.length ? { ok: false, code: 'BUNDLE_PATCH_RECONCILIATION_FAILED', errors } : { ok: true, errors: [] };
}

function reusedDraftsOf(work, view) {
  const drafts = [];
  for (const item of work.filter(entry => entry.kind === 'ready' || entry.kind === 'blocked')) {
    const stored = readDraft(item.draft_id);
    if (stored.bundle_token !== item.bundle_token || !hasSafeBundleEvidence(stored)) return { ok: false, code: 'BUNDLE_TOKEN_CHANGED', draft_id: item.draft_id };
    drafts.push(view.projectBundleDraft(stored));
  }
  return { ok: true, drafts };
}

function retryConfirmationResponse(input, plan, retryWork, drafts) {
  const required = retryWork.some(item => item.retry.budget.needs_confirmation);
  const token = input.enrichment_confirmation_token || input.enrichment_confirmation || input.confirmation_token;
  if (!required && (!retryWork.length || !token)) return null;
  if (!required && token) return { ok: false, code: 'ENRICHMENT_CONFIRMATION_INVALID', drafts };
  if (required && token === plan.retry_confirmation_token) return null;
  return {
    ok: false, code: token ? 'ENRICHMENT_CONFIRMATION_INVALID' : 'ENRICHMENT_COST_CONFIRMATION_REQUIRED',
    status: 'enrichment_cost_confirmation_required', pending_revision: plan.pending_revision,
    catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash,
    enrichment_confirmation_token: plan.retry_confirmation_token,
    retry_members: plan.retry_summary?.failed_members || [],
    retry_incremental_limits: plan.retry_summary?.incremental_limits || {},
    enrichment_hard_limits: aggregateRetryBudgets(retryWork.map(item => item.retry)).total_limits,
    drafts,
  };
}

function retryBundleOf(item, card, plan, snapshot, policy, bridge, options, drafts) {
  const stored = readDraft(item.retry.draft_id);
  if (stored.bundle_token !== item.retry.bundle_token || stored.base_revision !== plan.catalog_revision
    || stored.updated_at !== item.retry.draft_updated_at || stored.state !== item.retry.draft_state
    || stored.bundle?.base_revisions?.policy !== item.retry.base_revisions.policy
    || stored.bundle?.base_revisions?.bridge !== item.retry.base_revisions.bridge) {
    return { ok: false, code: 'BUNDLE_DRAFT_CHANGED', draft_id: item.retry.draft_id, drafts };
  }
  if (snapshot.revision !== item.retry.base_revisions.catalog || bridge.revision !== item.retry.base_revisions.bridge) {
    return { ok: false, code: 'REVISION_CONFLICT', draft_id: item.retry.draft_id, drafts };
  }
  if (!card || fingerprint(card) !== item.candidate_fingerprint) return { ok: false, code: 'BUNDLE_CANDIDATE_CHANGED', draft_id: item.retry.draft_id, drafts };
  const bundle = prepareRetryBundle(stored, item.retry.budget, plan.retry_confirmation_token);
  bundle.retry_source_fingerprint ||= item.candidate_fingerprint;
  const vendor = (policy.vendors || []).find(value => value.vendor_key === bundle.vendor_key);
  const family = vendor?.families?.find(value => (value.series || []).some(series => series.id === bundle.series?.level2_id));
  if (!family) return { ok: false, code: 'BUNDLE_SERIES_FAMILY_UNRESOLVED', draft_id: stored.draft_id, drafts };
  for (const member of bundle.members || []) {
    if (member.classification !== 'bundled') continue;
    const taskTypes = taskTypesForMember(member.name, family.task_types, policy.task_type_registry, member.task_types);
    if (!taskTypes.length) return { ok: false, code: 'BUNDLE_MEMBER_TASK_TYPES_UNRESOLVED', draft_id: stored.draft_id, member: member.name, drafts };
    member.task_types = taskTypes;
    for (const patch of bundle.layer_patches || []) {
      if (patch.record && (patch.id === member.detail_id || patch.id === member.tool_card_id)) patch.record.task_types = [...taskTypes];
    }
  }
  const reconciled = reconcileBundlePatchOperations(bundle, snapshot.snapshot);
  if (!reconciled.ok) return { ok: false, code: reconciled.code, errors: reconciled.errors, draft_id: stored.draft_id, drafts };
  const modality = profileModalityForFamily(family, policy.task_type_registry, bundle.candidate?.modality);
  if (modality) {
    bundle.series.profile_modality ||= modality;
    for (const member of bundle.members || []) if (member.classification === 'bundled' && !member.profile_modality) member.profile_modality = modality;
  }
  bundle.preview_hash = bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  return { ok: true, entry: { item: { candidate_key: item.candidate_key, name: item.name, retry: true }, card, bundle, existingDraftId: stored.draft_id } };
}

async function freshBundlesOf(work, cards, options, policy, snapshot, bridge, plannedBundles, blocked) {
  const byKey = new Map(cards.map(card => [card.candidate_key, card]));
  const unresolvedCards = work.filter(entry => entry.kind === 'fresh').map(entry => byKey.get(entry.candidate_key)).filter(Boolean);
  let resolved;
  try {
    resolved = unresolvedCards.length
      ? await (options.resolveBatchCandidates || resolveBatchCandidates)(unresolvedCards, { ...(options.resolveOptions || {}) })
      : { series_candidates: [], verification_blocked: [], unresolved: [], intake_outcomes: [] };
  } catch (error) { return { ok: false, code: 'SERIES_RESOLUTION_FAILED', error: error.message, plannedBundles, blocked }; }
  blocked.push(...(resolved.verification_blocked || []), ...(resolved.unresolved || []));
  for (const item of resolved.series_candidates || []) {
    const card = byKey.get(item.candidate_key) || { candidate_key: item.candidate_key, name: item.name };
    const planned = planSeriesBundle({ candidate: { candidate_key: item.candidate_key, name: item.name, entity_type: 'series', modality: item.modality || card.modality }, verdict: item.verdict, subModelVerdicts: item.members, policy, snapshot: snapshot.snapshot, receipts: item.receipt ? [item.receipt] : [], bridgeRevision: bridge.revision, now: options.now || new Date() });
    if (!planned.ok) { blocked.push({ candidate_key: item.candidate_key, name: item.name, code: planned.code, blocking_reasons: planned.blockers }); continue; }
    planned.bundle.retry_source_fingerprint = fingerprint(card);
    planned.bundle.retry_generation = 0;
    plannedBundles.push({ item, card, bundle: planned.bundle });
  }
  return { ok: true, resolved, plannedBundles, blocked };
}

async function finalizePreparedBundles(input, options, plan, view, pending, snapshot, policy, bridge, retryWork, resolved, plannedBundles, drafts, blocked) {
  const newBundles = plannedBundles.filter(entry => !entry.existingDraftId);
  const bundledMembers = view.bundledMembersOf(newBundles.map(entry => entry.bundle));
  const newLimits = bundledMembers.length ? view.enrichmentLimitsFor(bundledMembers.length, options) : {};
  const retryAggregate = aggregateRetryBudgets(retryWork.map(item => item.retry));
  const enrichmentLimits = sumMaps(retryAggregate.total_limits, newLimits);
  const enrichmentToken = view.enrichmentConfirmationToken(plan, plannedBundles.map(entry => entry.bundle), enrichmentLimits);
  const needsConfirmation = newBundles.length > 0 && bundledMembers.length > 0 && bundledMembers.some(member => !view.directEnrichmentAvailable(member, options));
  if (needsConfirmation && !view.hasEnrichmentConfirmation(input, enrichmentToken)) {
    const provided = input.enrichment_confirmation_token || input.enrichment_confirmation || input.confirmation_token || input.confirm_enrichment || input.confirm_enrichment_cost;
    return { ok: false, code: provided ? 'ENRICHMENT_CONFIRMATION_INVALID' : 'ENRICHMENT_COST_CONFIRMATION_REQUIRED', status: 'enrichment_cost_confirmation_required', pending_revision: pending.revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, enrichment_confirmation_token: enrichmentToken, enrichment_hard_limits: enrichmentLimits, cost_plan: { ...(plan.cost_plan || {}), hard_limits: enrichmentLimits }, drafts, blocked, resolution: { series_candidates: (resolved.series_candidates || []).length, verification_blocked: resolved.verification_blocked || [], intake_outcomes: resolved.intake_outcomes || [] } };
  }
  const spent = retryWork.length ? retryAggregate.spent : (options.enrichmentSpent || options.costSpent || {});
  const checkpointDrafts = new Map(plannedBundles.map(entry => { entry.bundle.enrichment_hard_limits = entry.bundle.enrichment_hard_limits || enrichmentLimits; entry.bundle.enrichment_confirmation_token = retryWork.length ? plan.retry_confirmation_token : enrichmentToken; return [entry.bundle.bundle_id, view.createBundleDraft(entry.bundle, entry.card, 'enriching', entry.existingDraftId || null)]; }));
  const finalized = await finalizeSeriesBundles(plannedBundles, { snapshot: snapshot.snapshot, policy, bridgeRevision: bridge.revision, adapters: options.bundleAdapters || options.catalogAdapters, generatorOptions: options.generatorOptions || options, enrichmentLimits, enrichmentConfirmationToken: retryWork.length ? plan.retry_confirmation_token : enrichmentToken, enrichmentSpent: spent, memberEnrichment: options.memberEnrichment || options.enrichmentResults, enrichMember: options.enrichMember, requireInjectedAdapters: options.requireInjectedAdapters, onCheckpoint: async ({ entry, bundle }) => checkpointDrafts.set(bundle.bundle_id, view.createBundleDraft(bundle, entry.card, 'enriching', checkpointDrafts.get(bundle.bundle_id).draft_id)), validate: value => validateSeriesBundle(value, { snapshot: snapshot.snapshot, policy, bridgeRevision: bridge.revision }) });
  const warnings = [];
  for (const { item, card, finalized: result } of finalized.results) {
    const draft = view.createBundleDraft(result.bundle, card, null, checkpointDrafts.get(result.bundle.bundle_id).draft_id);
    drafts.push(view.projectBundleDraft(draft));
    if (!item.retry && options.setIntakeOutcome !== null) {
      try { await (options.setIntakeOutcome || setIntakeOutcome)('tools', item.candidate_key, 'bundled_for_review', pending.revision, options.pendingOptions || {}); }
      catch (error) { warnings.push({ candidate_key: item.candidate_key, name: item.name, code: error.code || 'INTAKE_OUTCOME_WRITE_FAILED' }); }
    }
  }
  const readyCount = drafts.filter(draft => draft.state === 'preview_ready' && draft.readiness?.status === 'ready').length;
  const blockedDrafts = drafts.filter(draft => draft.state === 'preview_blocked' || draft.readiness?.status !== 'ready');
  const materializedCandidateKeys = new Set(drafts.map(draft => draft.candidate?.candidate_key).filter(Boolean));
  const blockedCandidates = blocked.filter(item => !item.draft_id
    && (!item.candidate_key || !materializedCandidateKeys.has(item.candidate_key)));
  const blockedCandidateCount = blockedCandidates.length;
  blocked.splice(0, blocked.length, ...blockedCandidates);
  blocked.push(...blockedDrafts.map(draft => ({
    draft_id: draft.draft_id,
    candidate_key: draft.candidate?.candidate_key || null,
    candidate_name: draft.candidate?.name || null,
    code: draft.last_error?.code || draft.readiness?.blocking_reasons?.[0] || 'BUNDLE_BLOCKED',
    blocking_reasons: draft.readiness?.blocking_reasons || [],
    enrichment_errors: draft.enrichment_errors || [],
  })));
  const blockedCount = blocked.length;
  const status = blockedCount ? (readyCount ? 'bundles_mixed' : 'bundles_blocked') : (readyCount ? 'bundles_ready' : 'bundles_blocked');
  const retry_members = retryWork.flatMap(item => item.retry.retry_member_keys);
  const reusable_research_members = retryWork.flatMap(item => item.retry.member_plans.filter(member => member.has_research).map(member => member.model_key));
  return {
    ok: readyCount > 0,
    status,
    ...(readyCount ? {} : { code: blockedCount ? 'BUNDLE_MEMBER_ENRICHMENT_FAILED' : 'BUNDLE_PREPARATION_BLOCKED' }),
    counts: { ready: readyCount, blocked: blockedCount, blocked_drafts: blockedDrafts.length, blocked_candidates: blockedCandidateCount },
    warnings,
    retry: retryWork.length ? { draft_ids: retryWork.map(item => item.retry.draft_id), member_keys: retry_members, reused_research_member_keys: reusable_research_members } : null,
    pending_revision: pending.revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash,
    drafts, blocked,
    resolution: { series_candidates: (resolved.series_candidates || []).length, verification_blocked: resolved.verification_blocked || [], intake_outcomes: resolved.intake_outcomes || [] },
  };
}

async function prepareCatalogBundlesImpl(input = {}, options = {}, plan, view) {
  const { pending, cards } = view.seriesCards(options);
  const drafts = [];
  const blocked = [];
  const work = plan.work || [];
  const reused = reusedDraftsOf(work, view);
  if (!reused.ok) return { ...reused, drafts };
  drafts.push(...reused.drafts);
  const retryWork = work.filter(item => item.kind === 'retry');
  const confirmation = retryConfirmationResponse(input, plan, retryWork, drafts);
  if (confirmation) return confirmation;
  const snapshot = view.snapshotOf(options);
  const policy = options.policy || loadSeriesPolicy();
  const bridge = readModelIdentityBridge(options.bridgeFile);
  const cardsByKey = new Map(cards.map(card => [card.candidate_key, card]));
  const plannedBundles = [];
  for (const item of retryWork) {
    const result = retryBundleOf(item, cardsByKey.get(item.candidate_key), plan, snapshot, policy, bridge, options, drafts);
    if (!result.ok) return result;
    plannedBundles.push(result.entry);
  }
  const fresh = await freshBundlesOf(work, cards, options, policy, snapshot, bridge, plannedBundles, blocked);
  if (!fresh.ok) return fresh;
  return finalizePreparedBundles(input, options, plan, view, pending, snapshot, policy, bridge, retryWork, fresh.resolved, fresh.plannedBundles, drafts, fresh.blocked);
}

module.exports = { prepareCatalogBundlesImpl, reconcileBundlePatchOperations };
