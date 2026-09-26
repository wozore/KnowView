'use strict';

const {
  spendOf, addSpend, spendDelta, effectiveLimitsOf, checkpointResearch,
  costExceeded, accountMemberCost, persistCheckpoint,
} = require('./series-bundle-enrichment');

async function saveResearchProgress(bundle, member, research, existingResearch, limits, input, errors, legacySpend) {
  const increment = spendDelta(spendOf(research?.cost), spendOf(existingResearch?.cost));
  const accounted = accountMemberCost(input.sharedLedger, { spent: increment });
  member.enrichment.cost = {
    total_spent: addSpend(member.enrichment.cost.total_spent, increment),
    last_attempt_spent: addSpend(member.enrichment.cost.last_attempt_spent, increment),
    uncertain_spent: member.enrichment.cost.uncertain_spent || {},
  };
  member.enrichment.research = checkpointResearch(research, null, limits, member.enrichment.cost.total_spent);
  member.enrichment.missing_fields = member.enrichment.research.missing_fields;
  if (!accounted.ok) throw Object.assign(new Error(accounted.code), { code: accounted.code });
  await persistCheckpoint(bundle, input, errors, legacySpend);
}

async function failMember(bundle, member, diagnostic, errors, input, legacySpend) {
  member.enrichment.status = 'failed';
  member.enrichment.last_error = diagnostic;
  errors.push(diagnostic);
  await persistCheckpoint(bundle, input, errors, legacySpend);
}

async function recordMemberResult(bundle, member, result, limits, input, errors, legacySpend) {
  const resultSpent = spendOf(result.cost || result.synthesis?.cost || result.research?.cost);
  const currentResearchSpent = spendOf(member.enrichment.research?.cost);
  const increment = result.cost_mode === 'cumulative'
    ? spendDelta(resultSpent, currentResearchSpent)
    : spendOf(result.cost_delta || result.cost);
  const totalSpent = addSpend(member.enrichment.cost.total_spent, increment);
  member.enrichment.cost = {
    total_spent: totalSpent,
    last_attempt_spent: addSpend(member.enrichment.cost.last_attempt_spent, increment),
    uncertain_spent: member.enrichment.cost.uncertain_spent || {},
  };
  if (result.research) {
    member.enrichment.research = checkpointResearch(result.research, result, limits, totalSpent);
    member.enrichment.missing_fields = member.enrichment.research.missing_fields;
  }
  if (!result?.ok) {
    const accounted = accountMemberCost(input.sharedLedger, { spent: increment });
    const diagnostic = { model_key: member.model_key, name: member.name, ...input.enrichmentDiagnostic(result) };
    if (!accounted.ok) diagnostic.cost_error = accounted.code;
    return failMember(bundle, member, diagnostic, errors, input, legacySpend);
  }
  const accounted = accountMemberCost(input.sharedLedger, { spent: increment });
  const overBudget = costExceeded(totalSpent, limits);
  if (overBudget || !accounted.ok) {
    return failMember(bundle, member, {
      model_key: member.model_key, name: member.name,
      code: overBudget ? 'BUNDLE_MEMBER_COST_LIMIT_EXCEEDED' : accounted.code,
    }, errors, input, legacySpend);
  }
  return applyMemberPatches(bundle, member, result, errors, input, legacySpend);
}

async function applyMemberPatches(bundle, member, result, errors, input, legacySpend) {
  const detailPatch = input.patchFor(result, 'tool-level3');
  const cardPatch = input.patchFor(result, 'tool-card');
  const plannedDetailPatch = (bundle.layer_patches || []).find(patch => patch.area === 'tool-level3' && patch.id === member.detail_id);
  const plannedCardPatch = (bundle.layer_patches || []).find(patch => patch.area === 'tool-card' && patch.id === member.tool_card_id);
  if (!detailPatch || detailPatch.id !== member.detail_id || !detailPatch.record
    || !cardPatch || cardPatch.id !== member.tool_card_id || !cardPatch.record
    || !plannedDetailPatch || !['create', 'replace'].includes(plannedDetailPatch.operation)
    || !plannedCardPatch || !['create', 'replace'].includes(plannedCardPatch.operation)) {
    return failMember(bundle, member, { model_key: member.model_key, name: member.name, code: 'BUNDLE_ENRICHMENT_PATCH_INVALID' }, errors, input, legacySpend);
  }
  const cardRef = cardPatch.record.detail_ref?.id;
  const shortDetailId = member.detail_id.slice('tool-level3:'.length);
  if (cardRef && cardRef !== member.detail_id && cardRef !== shortDetailId) {
    return failMember(bundle, member, { model_key: member.model_key, name: member.name, code: 'BUNDLE_ENRICHMENT_DETAIL_REF_INVALID' }, errors, input, legacySpend);
  }
  cardPatch.record = { ...cardPatch.record, detail_ref: { kind: 'tool-level3', id: member.detail_id } };
  input.replacePatch(bundle.layer_patches, { ...detailPatch, operation: plannedDetailPatch.operation });
  input.replacePatch(bundle.layer_patches, { ...cardPatch, operation: plannedCardPatch.operation });
  member.enrichment.status = 'ready';
  member.enrichment.last_error = null;
  await persistCheckpoint(bundle, input, errors, legacySpend);
}

async function runMemberAttempt(bundle, member, input, errors, legacySpend, budgets) {
  if (member.classification !== 'bundled' || member.enrichment?.status === 'ready') return;
  const key = `${bundle.bundle_id}:${member.model_key}`;
  const prior = member.enrichment || {};
  const limits = prior.limits || budgets.get(key) || input.enrichmentLimits;
  const previousSpent = prior.cost?.total_spent || {};
  const existingResearch = prior.research || null;
  const attemptLimits = effectiveLimitsOf(limits, prior.cost?.uncertain_spent || {});
  member.enrichment = {
    status: 'running', attempts: Number(prior.attempts || 0) + 1, limits,
    cost: { total_spent: previousSpent, last_attempt_spent: {}, uncertain_spent: prior.cost?.uncertain_spent || {} },
    research: existingResearch, missing_fields: prior.missing_fields || existingResearch?.missing_fields || [], last_error: null,
  };
  await persistCheckpoint(bundle, input, errors, legacySpend);
  let result;
  try {
    result = await input.enrichOne(bundle, member, {
      ...input, limits: attemptLimits, existingResearch, missingFields: member.enrichment.missing_fields,
      onResearchCheckpoint: research => saveResearchProgress(bundle, member, research, existingResearch, attemptLimits, input, errors, legacySpend),
    });
  } catch (error) {
    result = { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_FAILED', error: error?.message || String(error) };
  }
  return recordMemberResult(bundle, member, result, attemptLimits, input, errors, legacySpend);
}

async function finalizeBundleMembers(bundle, input, legacySpend, budgets) {
  const errors = [];
  for (const member of bundle.members || []) await runMemberAttempt(bundle, member, input, errors, legacySpend, budgets);
  return errors;
}

module.exports = { finalizeBundleMembers };
