'use strict';

const crypto = require('crypto');
const { DEFAULT_LIMITS, createCostLedger, sourceUrlMatchesModelIdentity, officialRootsOf, isTrustedOfficialUrl } = require('../core');
const { revisionOf } = require('../core/catalog-revision');
const { estimateResolutionNeed } = require('../intake');
const { loadSeriesPolicy } = require('../series');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { listDrafts } = require('./catalog-draft-store');
const { candidateKeyOf, selectLatestCandidateDraft } = require('./catalog-bundle-selection');
const { planHashOf } = require('../catalog-workbench-view');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fingerprint(card) {
  const fields = ['candidate_key', 'name', 'identity_key', 'entity_type', 'detail_kind_hint', 'modality', 'description', 'definition'];
  const basis = Object.fromEntries(fields.filter(key => card?.[key] !== undefined).map(key => [key, card[key]]));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stable(basis))).digest('hex')}`;
}
function candidateMatches(draft, card) {
  const candidate = draft.bundle?.candidate || draft.seed || {};
  if (candidateKeyOf(draft) !== card.candidate_key || String(candidate.name || '') !== String(card.name || '')) return false;
  return !draft.bundle?.retry_source_fingerprint || draft.bundle.retry_source_fingerprint === fingerprint(card);
}
function hasSafeBundleEvidence(draft) {
  const members = draft.bundle?.members || [];
  const urls = members.flatMap(member => [member.evidence?.official_url, ...(member.evidence?.official_urls || [])].filter(Boolean));
  const authorized = new Set(urls.map(url => String(url).trim()));
  const patches = draft.bundle?.layer_patches || [];
  const social = patches.flatMap(patch => patch.record?.sources || []).map(source => String(source.url || '').trim()).filter(Boolean);
  const unauthorized = social.some(url => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return (host === 'x.com' || host === 'twitter.com') && !authorized.has(url);
    } catch { return false; }
  });
  return !members.some(member => [member.evidence?.official_url, ...(member.evidence?.official_urls || [])]
    .some(url => /\/model-map(?:[/?#]|$)/i.test(String(url || '')))) && !unauthorized;
}

function retryMembersOf(draft) {
  const bundle = draft.bundle || {};
  const members = (bundle.members || []).filter(member => member.classification === 'bundled');
  const errors = bundle.enrichment_errors || draft.enrichment_errors || [];
  const errorsByKey = new Map(errors.filter(error => error?.model_key).map(error => [error.model_key, error]));
  const failedKeys = [...errorsByKey.keys()];
  if (failedKeys.some(key => !members.some(member => member.model_key === key))) {
    return { ok: false, code: 'BUNDLE_ENRICHMENT_MEMBER_MISMATCH' };
  }
  const unknownFailure = errors.some(error => !error?.model_key);
  const projectionOnly = members.length > 0 && errors.length > 0
    && members.every(member => member.enrichment?.status === 'ready')
    && errors.every(error => error?.code === 'BUNDLE_BRIDGE_PROJECTION_MISSING');
  if (projectionOnly) return { ok: true, retry: [], ready: members, projection_repair: true };
  const retry = [];
  const ready = [];
  for (const member of members) {
    const status = member.enrichment?.status;
    const shouldRetry = ['failed', 'pending', 'running'].includes(status)
      || errorsByKey.has(member.model_key)
      || unknownFailure
      || (!status && !errors.length && (bundle.blockers || []).includes('BUNDLE_MEMBERS_NEED_ENRICHMENT'));
    (shouldRetry ? retry : ready).push(member);
  }
  return retry.length ? { ok: true, retry, ready } : { ok: false, code: 'BUNDLE_DRAFT_NOT_RETRYABLE' };
}
function safeEnrichmentError(error, missingFields = error?.missing_fields) {
  if (!error || typeof error !== 'object') return null;
  return {
    ...(error.model_key ? { model_key: String(error.model_key) } : {}),
    ...(error.name ? { name: String(error.name) } : {}),
    code: String(error.code || 'BUNDLE_ENRICHMENT_FAILED'),
    missing_fields: Array.isArray(missingFields) ? missingFields.map(String) : [],
    synthesis_errors: Array.isArray(error.synthesis_errors)
      ? error.synthesis_errors.map(item => ({ code: String(item?.code || 'SYNTHESIS_ERROR'), ...(item?.field ? { field: String(item.field) } : {}) }))
      : [],
    research_code: error.research_code ? String(error.research_code) : null,
    official_source_count: Math.max(0, Number(error.official_source_count || 0)),
  };
}
function add(left = {}, right = {}) {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
    .map(key => [key, Number(left[key] || 0) + Number(right[key] || 0)]));
}
function sumMaps(...values) {
  return values.reduce((total, value) => add(total, value), {});
}
function remaining(limits = {}, spent = {}, uncertain = {}) {
  return Object.fromEntries(Object.keys(limits).map(key => [key,
    Math.max(0, Number(limits[key] || 0) - Number(spent[key] || 0) - Number(uncertain[key] || 0))]));
}

function missingFieldsOf(state, fallbackError) {
  const fields = [
    ...(Array.isArray(state.missing_fields) ? state.missing_fields : []),
    ...(Array.isArray(state.research?.missing_fields) ? state.research.missing_fields : []),
    ...(Array.isArray(state.last_error?.missing_fields) ? state.last_error.missing_fields : []),
    ...(Array.isArray(fallbackError?.missing_fields) ? fallbackError.missing_fields : []),
  ];
  return [...new Set(fields.map(String).filter(field => !field.startsWith('group.')))];
}

function hasReusableModelDetailPage(member, vendorKey) {
  const research = member.enrichment?.research;
  const evidence = member.evidence || {};
  const urls = [evidence.official_url, ...(evidence.official_urls || []), ...(evidence.sources || []).map(source => source?.url)].filter(Boolean);
  const seed = { name: member.name, model_key: member.model_key, vendor_key: vendorKey, official_url: urls[0], discovery_sources: urls.slice(1).map(url => ({ url, kind: 'identity_verified' })) };
  const roots = officialRootsOf(seed);
  const attempted = new Set(research?.research_progress?.page_update_refetch_attempted_ids || []);
  return (research?.official_sources || []).some(source => !attempted.has(source.source_id)
    && isTrustedOfficialUrl(source.url, roots) && sourceUrlMatchesModelIdentity(source, seed));
}
function attemptNeed(member, isLegacy, missingFields, vendorKey) {
  const research = member.enrichment?.research;
  if (isLegacy || !research) return { ...DEFAULT_LIMITS };
  if (member.enrichment?.status === 'running' && !research.official_sources?.length) return { ...DEFAULT_LIMITS };
  if (missingFields.length === 1 && missingFields[0] === 'detail.release_date' && hasReusableModelDetailPage(member, vendorKey)) {
    return { search_queries: 0, pages: 1, responses_calls: 1, synthesis_calls: 1 };
  }
  if (missingFields.length) return { search_queries: 2, pages: 2, responses_calls: 1, synthesis_calls: 1 };
  if (research.ok === false) return { search_queries: 1, pages: 2, responses_calls: 1, synthesis_calls: 1 };
  return { search_queries: 0, pages: 0, responses_calls: 1, synthesis_calls: 1 };
}

function allocateShares(total, members) {
  const sorted = [...members].sort((a, b) => String(a.model_key).localeCompare(String(b.model_key)));
  const result = new Map(sorted.map(member => [member.model_key, {}]));
  for (const category of Object.keys(DEFAULT_LIMITS)) {
    const amount = Math.max(0, Number(total[category] || 0));
    const each = Math.floor(amount / Math.max(1, sorted.length));
    sorted.forEach((member, index) => result.get(member.model_key)[category] = each + (index < amount - each * sorted.length ? 1 : 0));
  }
  return result;
}

function uncertainSpendOf(member) {
  const state = member.enrichment || {};
  if (state.status !== 'running') return state.cost?.uncertain_spent || {};
  if (state.research?.official_sources?.length) return add(state.cost?.uncertain_spent, { responses_calls: 1, synthesis_calls: 1 });
  return add(state.cost?.uncertain_spent, remaining(state.limits || {}, state.cost?.total_spent || {}));
}

function retryBudgetOf(draft, members) {
  const bundle = draft.bundle || {};
  const count = Math.max(1, (bundle.members || []).filter(member => member.classification === 'bundled').length);
  const baseLimits = { ...Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, value * count])), ...(bundle.enrichment_hard_limits || bundle.cost?.enrichment?.limits || {}) };
  const baseSpent = bundle.cost?.enrichment?.spent || {};
  const allMembers = (bundle.members || []).filter(member => member.classification === 'bundled');
  const knownSpent = allMembers.reduce((total, member) => add(total, member.enrichment?.cost?.total_spent), {});
  const totalUncertain = allMembers.reduce((total, member) => add(total, uncertainSpendOf(member)), {});
  const knownRemaining = allMembers.filter(member => member.enrichment?.limits)
    .reduce((total, member) => add(total, remaining(member.enrichment.limits, member.enrichment.cost?.total_spent, uncertainSpendOf(member))), {});
  const globalRemaining = remaining(baseLimits, baseSpent, totalUncertain);
  const legacyPool = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(key => [key,
    Math.max(0, Number(globalRemaining[key] || 0) - Number(knownRemaining[key] || 0))]));
  const legacyMembers = members.retry.filter(member => !member.enrichment?.limits);
  const legacyShares = allocateShares(legacyPool, legacyMembers);
  const additional = {};
  const errorsByKey = new Map((bundle.enrichment_errors || []).filter(error => error?.model_key).map(error => [error.model_key, error]));
  const memberPlans = members.retry.map(member => {
    const state = member.enrichment || {};
    const fallbackError = errorsByKey.get(member.model_key);
    const missingFields = missingFieldsOf(state, fallbackError);
    const currentSpent = state.cost?.total_spent || {};
    const uncertain = state.limits ? uncertainSpendOf(member) : {};
    const available = state.limits
      ? remaining(state.limits, currentSpent, uncertain)
      : legacyShares.get(member.model_key) || {};
    const need = attemptNeed(member, !state.limits, missingFields, bundle.vendor_key);
    const increment = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(key => [key,
      Math.max(0, Number(need[key] || 0) - Number(available[key] || 0))]));
    for (const [key, value] of Object.entries(increment)) additional[key] = Number(additional[key] || 0) + value;
    return {
      model_key: member.model_key,
      name: member.name,
      status: state.status || 'legacy_failed',
      has_research: Boolean(state.research?.official_sources?.length),
      missing_fields: missingFields,
      error: safeEnrichmentError(state.last_error || fallbackError, missingFields),
      official_source_count: state.research?.official_sources?.length || fallbackError?.official_source_count || 0,
      uncertain_spend: uncertain,
      available_limits: available,
      incremental_limits: increment,
      effective_limits: add(state.limits || available, increment),
    };
  });
  return {
    base_limits: baseLimits,
    base_spent: baseSpent,
    incremental_limits: additional,
    total_limits: add(baseLimits, additional),
    member_plans: memberPlans,
    ready_member_keys: members.ready.map(member => member.model_key),
    retry_member_keys: members.retry.map(member => member.model_key),
    needs_confirmation: Object.values(additional).some(value => value > 0),
    legacy_unattributed_spent: Object.fromEntries(Object.keys(baseSpent).map(key => [key,
      Math.max(0, Number(baseSpent[key] || 0) - Number(knownSpent[key] || 0))])),
  };
}

function chooseCandidateDraft(card, drafts, revisions) {
  const selected = selectLatestCandidateDraft(drafts, card.candidate_key, revisions.catalog);
  if (!selected.ok) return selected;
  if (!selected.draft) return { ok: true, kind: 'fresh' };
  const draft = selected.draft;
  if (!candidateMatches(draft, card)) return { ok: false, code: 'BUNDLE_CANDIDATE_CHANGED', draft_id: draft.draft_id };
  const bases = draft.bundle?.base_revisions || {};
  if (bases.policy !== revisions.policy || bases.bridge !== revisions.bridge) {
    return { ok: false, code: 'BUNDLE_BASE_REVISION_DRIFT', draft_id: draft.draft_id };
  }
  const superseded_draft_ids = selected.superseded_draft_ids;
  if (draft.state === 'preview_ready' && draft.readiness?.status === 'ready') {
    return { ok: true, kind: 'ready', draft, superseded_draft_ids };
  }
  if (!['preview_blocked', 'enriching'].includes(draft.state)) {
    return { ok: false, code: 'BUNDLE_DRAFT_NOT_RETRYABLE', draft_id: draft.draft_id };
  }
  const members = retryMembersOf(draft);
  if (!members.ok && members.code === 'BUNDLE_DRAFT_NOT_RETRYABLE') return { ok: true, kind: 'blocked', draft, superseded_draft_ids };
  if (!members.ok) return { ok: false, code: members.code, draft_id: draft.draft_id };
  return { ok: true, kind: 'retry', draft, members, budget: retryBudgetOf(draft, members), superseded_draft_ids };
}

function retryConfirmationToken(planHash, retries) {
  const basis = {
    plan_hash: planHash,
    retries: retries.map(retry => ({
      draft_id: retry.draft_id,
      bundle_token: retry.bundle_token,
      draft_updated_at: retry.draft_updated_at,
      draft_state: retry.draft_state,
      retry_generation: retry.retry_generation,
      retry_member_keys: retry.retry_member_keys,
      incremental_limits: retry.incremental_limits,
      base_revisions: retry.base_revisions,
    })),
  };
  return `enrich-${crypto.createHash('sha256').update(JSON.stringify(stable(basis))).digest('hex').slice(-24)}`;
}

function prepareRetryBundle(draft, budget, confirmationToken) {
  const bundle = JSON.parse(JSON.stringify(draft.bundle));
  const retryKeys = new Set(budget.retry_member_keys);
  const readyKeys = new Set(budget.ready_member_keys);
  const plans = new Map(budget.member_plans.map(item => [item.model_key, item]));
  const errors = new Map((bundle.enrichment_errors || []).filter(item => item?.model_key).map(item => [item.model_key, item]));
  for (const member of bundle.members || []) {
    if (member.classification !== 'bundled') continue;
    if (readyKeys.has(member.model_key) && !member.enrichment) {
      member.enrichment = { status: 'ready', attempts: 0, limits: {}, cost: { total_spent: {}, last_attempt_spent: {}, uncertain_spent: {} }, research: null, missing_fields: [], last_error: null };
    }
    if (!retryKeys.has(member.model_key)) continue;
    const plan = plans.get(member.model_key);
    const state = member.enrichment || {
      status: 'failed', attempts: 0, limits: {}, cost: { total_spent: {}, last_attempt_spent: {}, uncertain_spent: {} }, research: null,
      missing_fields: errors.get(member.model_key)?.missing_fields || [], last_error: errors.get(member.model_key) || null,
    };
    state.cost ||= { total_spent: {}, last_attempt_spent: {}, uncertain_spent: {} };
    state.cost.total_spent ||= {};
    state.cost.last_attempt_spent ||= {};
    state.cost.uncertain_spent = add(state.cost.uncertain_spent, plan.uncertain_spend);
    state.limits = plan.effective_limits;
    state.status = 'failed';
    if (plan.status === 'running') state.last_error = { code: 'BUNDLE_ENRICHMENT_INTERRUPTED' };
    state.missing_fields ||= errors.get(member.model_key)?.missing_fields || [];
    member.enrichment = state;
  }
  bundle.retry_generation = Number(bundle.retry_generation || 0) + 1;
  bundle.enrichment_cost_unattributed = budget.legacy_unattributed_spent;
  bundle.enrichment_hard_limits = budget.total_limits;
  bundle.enrichment_confirmation_token = confirmationToken || null;
  const uncertain = (bundle.members || []).reduce((total, member) => add(total, member.enrichment?.cost?.uncertain_spent), {});
  const cost = createCostLedger(budget.total_limits, budget.base_spent).snapshot();
  cost.uncertain_spent = uncertain;
  cost.remaining = remaining(budget.total_limits, budget.base_spent, uncertain);
  bundle.enrichment_cost_uncertain = uncertain;
  bundle.cost = { ...(bundle.cost || {}), enrichment: cost };
  bundle.enrichment_errors = [];
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT'];
  bundle.readiness = 'blocked';
  return bundle;
}

function aggregateRetryBudgets(retries) {
  return (retries || []).reduce((total, retry) => ({
    base_limits: add(total.base_limits, retry.budget.base_limits),
    total_limits: add(total.total_limits, retry.budget.total_limits),
    spent: add(total.spent, retry.budget.base_spent),
    incremental_limits: add(total.incremental_limits, retry.budget.incremental_limits),
  }), { base_limits: {}, total_limits: {}, spent: {}, incremental_limits: {} });
}

function draftDecisionsOf(cards, revisions, pending, catalog) {
  const drafts = listDrafts({ schema_version: 4, draft_kind: 'series_bundle' });
  const decisions = cards.map(card => ({ card, choice: chooseCandidateDraft(card, drafts, revisions) }));
  const rejected = decisions.find(item => !item.choice.ok);
  if (rejected) return {
    ok: false, code: rejected.choice.code, draft_id: rejected.choice.draft_id || null,
    draft_ids: rejected.choice.draft_ids || [], pending_revision: pending.revision,
    catalog_revision: catalog.revision, candidates: [],
  };
  const unsafe = decisions.find(item => item.choice.kind !== 'fresh' && !hasSafeBundleEvidence(item.choice.draft));
  if (unsafe) return { ok: false, code: 'BUNDLE_EVIDENCE_UNSAFE', draft_id: unsafe.choice.draft.draft_id, candidates: [] };
  return { ok: true, decisions };
}

function workItemsOf(decisions) {
  const hasRetry = decisions.some(item => item.choice.kind === 'retry');
  const active = hasRetry ? decisions.filter(item => item.choice.kind !== 'fresh') : decisions;
  const work = active.map(({ card, choice }) => {
    if (choice.kind !== 'retry') return {
      candidate_key: card.candidate_key, name: card.name, kind: choice.kind,
      ...(choice.draft ? { draft_id: choice.draft.draft_id, bundle_token: choice.draft.bundle_token || choice.draft.bundle?.bundle_token } : {}),
      superseded_draft_ids: choice.superseded_draft_ids || [], candidate_fingerprint: fingerprint(card),
    };
    const draft = choice.draft;
    const retry = {
      draft_id: draft.draft_id,
      bundle_token: draft.bundle_token || draft.bundle?.bundle_token,
      draft_updated_at: draft.updated_at,
      draft_state: draft.state,
      retry_generation: Number(draft.bundle?.retry_generation || 0),
      base_revisions: draft.bundle?.base_revisions || {},
      retry_member_keys: choice.budget.retry_member_keys,
      projection_repair: choice.members.projection_repair === true,
      ready_member_keys: choice.budget.ready_member_keys,
      incremental_limits: choice.budget.incremental_limits,
      total_limits: choice.budget.total_limits,
      member_plans: choice.budget.member_plans,
      budget: choice.budget,
      superseded_draft_ids: choice.superseded_draft_ids || [],
    };
    return { candidate_key: card.candidate_key, name: card.name, kind: 'retry', candidate_fingerprint: fingerprint(card), retry };
  });
  return { work, active, deferred: hasRetry ? decisions.filter(item => item.choice.kind === 'fresh').map(({ card }) => ({ candidate_key: card.candidate_key, name: card.name })) : [] };
}

function planPayloadOf(pending, catalog, options, work, active, deferred) {
  const resolutionCards = active.filter(item => item.choice.kind === 'fresh').map(item => item.card);
  const resolution = estimateResolutionNeed(resolutionCards, options.resolveOptions || options);
  const retryWork = work.filter(item => item.kind === 'retry');
  const retryAggregate = aggregateRetryBudgets(retryWork.map(item => item.retry));
  const plan = {
    pending_revision: pending.revision,
    catalog_revision: catalog.revision,
    candidates: work.map(({ candidate_key, name, kind, draft_id, superseded_draft_ids }) => ({
      candidate_key, name, ...(kind !== 'fresh' ? { kind } : {}), ...(draft_id ? { draft_id } : {}), ...(superseded_draft_ids?.length ? { superseded_draft_ids } : {}),
    })),
    work,
    deferred_candidates: deferred,
    retry_summary: retryWork.length ? {
      draft_ids: retryWork.map(item => item.retry.draft_id),
      failed_members: retryWork.flatMap(item => item.retry.member_plans.map(member => ({ model_key: member.model_key, name: member.name, has_research: member.has_research, status: member.status, missing_fields: member.missing_fields, official_source_count: member.official_source_count, error: member.error }))),
      projection_repair: retryWork.some(item => item.retry.projection_repair),
      ready_member_keys: retryWork.flatMap(item => item.retry.ready_member_keys),
      incremental_limits: retryAggregate.incremental_limits,
      requires_confirmation: retryWork.some(item => Object.values(item.retry.incremental_limits).some(value => value > 0)),
    } : null,
    resolution,
  };
  return { plan, resolution, retryWork };
}

function planCatalogBundleWork({ pending, cards, catalog, options = {} }) {
  if (!cards.length) return {
    ok: false, code: 'SERIES_CANDIDATE_NOT_APPROVED', pending_revision: pending.revision,
    catalog_revision: catalog.revision, candidates: [], blocking_reasons: ['没有已批准的模型系列待补卡'],
  };
  const policy = options.policy || loadSeriesPolicy();
  const bridge = readModelIdentityBridge(options.bridgeFile);
  if (Array.isArray(bridge.validation_errors) && bridge.validation_errors.length) {
    return { ok: false, code: 'BRIDGE_INVALID', validation_errors: bridge.validation_errors, candidates: [] };
  }
  const revisions = { catalog: catalog.revision, policy: revisionOf(policy), bridge: bridge.revision };
  const selected = draftDecisionsOf(cards, revisions, pending, catalog);
  if (!selected.ok) return selected;
  const hasRetry = selected.decisions.some(item => item.choice.kind === 'retry');
  const { work, active, deferred } = workItemsOf(selected.decisions);
  const { plan, resolution, retryWork } = planPayloadOf(pending, catalog, options, work, active, deferred);
  const planHash = planHashOf(plan);
  const requiresRetryConfirmation = Boolean(plan.retry_summary?.requires_confirmation);
  const retry_confirmation_token = requiresRetryConfirmation
    ? retryConfirmationToken(planHash, retryWork.map(item => item.retry))
    : null;
  const projectionRepair = Boolean(plan.retry_summary?.projection_repair);
  return {
    ok: true,
    status: projectionRepair ? 'projection_reconciliation_ready' : requiresRetryConfirmation ? 'retry_cost_confirmation_required' : 'cost_confirmation_required',
    ...plan,
    plan_hash: planHash,
    ...(retry_confirmation_token ? { retry_confirmation_token } : {}),
    cost_plan: resolution,
  };
}

module.exports = { fingerprint, hasSafeBundleEvidence, safeEnrichmentError, chooseCandidateDraft, retryConfirmationToken, prepareRetryBundle, aggregateRetryBudgets, sumMaps, planCatalogBundleWork };
