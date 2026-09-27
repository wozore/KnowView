'use strict';

const { createCostLedger, DEFAULT_LIMITS } = require('../core');
const { bundlePreviewHashOf, bundleTokenOf } = require('./series-bundle-contract');

function spendOf(cost) {
  return cost?.spent && typeof cost.spent === 'object' ? cost.spent : {};
}

function addSpend(left = {}, right = {}) {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
    .map(key => [key, Number(left[key] || 0) + Number(right[key] || 0)]));
}

function spendDelta(current = {}, previous = {}) {
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map(key => [key, Math.max(0, Number(current[key] || 0) - Number(previous[key] || 0))]));
}

function effectiveLimitsOf(limits = {}, uncertain = {}) {
  return Object.fromEntries(Object.keys(limits).map(key => [key,
    Math.max(0, Number(limits[key] || 0) - Number(uncertain[key] || 0))]));
}

function allocateMemberBudgets(entries, limits) {
  const members = entries.flatMap(entry => (entry.bundle.members || [])
    .filter(member => member.classification === 'bundled')
    .map(member => ({ bundle_id: entry.bundle.bundle_id, model_key: member.model_key })))
    .sort((a, b) => `${a.bundle_id}:${a.model_key}`.localeCompare(`${b.bundle_id}:${b.model_key}`));
  const allocations = new Map(members.map(member => [`${member.bundle_id}:${member.model_key}`, {}]));
  if (!members.length) return allocations;
  for (const [category, rawLimit] of Object.entries({ ...DEFAULT_LIMITS, ...(limits || {}) })) {
    const total = Math.max(0, Math.floor(Number(rawLimit) || 0));
    const each = Math.floor(total / members.length);
    const remainder = total - each * members.length;
    members.forEach((member, index) => {
      allocations.get(`${member.bundle_id}:${member.model_key}`)[category] = each + (index < remainder ? 1 : 0);
    });
  }
  return allocations;
}

function checkpointResearch(research, result, limits, spent) {
  if (!research) return null;
  const progress = research.research_progress || {};
  const synthesis = result?.synthesis || {};
  return {
    ok: research.ok === true,
    official_sources: research.official_sources || [],
    warnings: research.warnings || [],
    research_progress: progress,
    completed_scopes: progress.completed_scopes || [],
    missing_fields: synthesis.missing_fields || research.missing_fields || [],
    cost: createCostLedger(limits, spent).snapshot(),
    ...(research.code ? { code: research.code } : {}),
    ...(research.error ? { error: research.error } : {}),
  };
}

function legacySpendOf(bundle) {
  if (bundle.enrichment_cost_unattributed) return bundle.enrichment_cost_unattributed;
  const aggregate = spendOf(bundle.cost?.enrichment);
  const memberSpend = (bundle.members || []).reduce((total, member) => addSpend(total, member.enrichment?.cost?.total_spent), {});
  return Object.fromEntries(Object.keys(aggregate).map(key => [key, Math.max(0, Number(aggregate[key] || 0) - Number(memberSpend[key] || 0))]));
}

function bundleEnrichmentCost(bundle, limits, legacySpend) {
  const spent = (bundle.members || []).reduce((total, member) => addSpend(total, member.enrichment?.cost?.total_spent), legacySpend || {});
  const uncertain = (bundle.members || []).reduce((total, member) => addSpend(total, member.enrichment?.cost?.uncertain_spent), {});
  bundle.enrichment_cost_unattributed = legacySpend || {};
  bundle.enrichment_cost_uncertain = uncertain;
  const cost = createCostLedger(limits, spent).snapshot();
  cost.uncertain_spent = uncertain;
  cost.remaining = effectiveLimitsOf(cost.remaining, uncertain);
  bundle.cost = { ...(bundle.cost || {}), enrichment: cost };
}

function costExceeded(spent, limits) {
  return Object.entries(spent).find(([category, amount]) => Number(amount || 0) > Number(limits?.[category] ?? 0))?.[0] || null;
}

function accountMemberCost(ledger, cost) {
  const spent = cost?.spent || {};
  const snapshot = ledger.snapshot();
  for (const [category, amount] of Object.entries(spent)) {
    const count = Number(amount);
    if (!Object.hasOwn(snapshot.remaining, category)) return { ok: false, code: 'COST_CATEGORY_UNKNOWN', category };
    if (!Number.isFinite(count) || count < 0) return { ok: false, code: 'COST_AMOUNT_INVALID', category };
    if (count > snapshot.remaining[category]) return { ok: false, code: 'COST_BUDGET_EXHAUSTED', category, requested: count, remaining: snapshot.remaining[category] };
  }
  for (const [category, amount] of Object.entries(spent)) {
    const reservation = ledger.reserve(category, Number(amount));
    if (!reservation.ok) return reservation;
  }
  return { ok: true };
}

async function persistCheckpoint(bundle, input, errors, legacySpend) {
  bundle.enrichment_errors = errors;
  bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', ...(errors.length ? ['BUNDLE_MEMBER_ENRICHMENT_FAILED'] : [])];
  bundle.readiness = 'blocked';
  bundleEnrichmentCost(bundle, bundle.enrichment_hard_limits || input.sharedLedger.snapshot().limits, legacySpend);
  bundle.preview_hash = bundlePreviewHashOf(bundle);
  bundle.bundle_token = bundleTokenOf(bundle);
  if (typeof input.onCheckpoint === 'function') await input.onCheckpoint({ bundle });
}

module.exports = {
  spendOf,
  addSpend,
  spendDelta,
  effectiveLimitsOf,
  allocateMemberBudgets,
  checkpointResearch,
  legacySpendOf,
  bundleEnrichmentCost,
  costExceeded,
  accountMemberCost,
  persistCheckpoint,
};
