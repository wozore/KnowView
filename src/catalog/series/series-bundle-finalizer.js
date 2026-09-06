'use strict';

const {
  planCatalogResearch,
  researchCatalog,
  synthesizeCatalog,
  createCostLedger,
} = require('../core');
const { createCatalogAiAdapters } = require('../intake/catalog-adapters');
const { bundlePreviewHashOf, bundleTokenOf } = require('./series-bundle-contract');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memberSeed(bundle, member) {
  const detailId = member.detail_id.slice('tool-level3:'.length);
  const cardId = member.tool_card_id.slice('tool-card:'.length);
  const evidence = member.evidence || {};
  const officialUrl = evidence.official_url || '';
  return {
    detail_kind: 'api_model',
    modality: bundle.series.modality || 'text',
    repair_layers: ['tool-level3', 'tool-card'],
    name: member.name,
    vendor_name: bundle.vendor_key,
    vendor_key: bundle.vendor_key,
    tool_key: cardId,
    detail_key: detailId,
    model_key: member.model_key,
    series_kind: bundle.series.series_kind,
    official_url: officialUrl,
    placement: {
      existing_level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${bundle.vendor_key}` },
      existing_level2_ref: { kind: 'vendor-level2', id: bundle.series.level2_id },
    },
    known_fields: { theme: 'general' },
    discovery_sources: officialUrl ? [{ url: officialUrl, kind: 'official_hint' }] : [],
  };
}

function patchFor(result, area) {
  return (result?.layer_patches || []).find(patch => patch.area === area && patch.operation !== 'noop') || null;
}

async function enrichOne(bundle, member, input) {
  const seed = memberSeed(bundle, member);
  const direct = typeof input.enrichMember === 'function'
    ? await input.enrichMember({ bundle, member, seed })
    : input.memberEnrichment?.[member.model_key] || input.memberEnrichment?.[member.name];
  if (direct?.ok === false) return direct;
  if (direct?.layer_patches) return { ok: true, layer_patches: direct.layer_patches, research: direct.research || null, cost: direct.cost || null };

  const adapters = input.adapters || input.catalogAdapters;
  if (!adapters?.discover || !adapters?.acquire || !adapters?.synthesize) {
    if (input.requireInjectedAdapters) return { ok: false, code: 'BUNDLE_ENRICHMENT_ADAPTERS_REQUIRED' };
  }
  const effectiveAdapters = adapters || createCatalogAiAdapters(input.generatorOptions || input);
  let plan;
  try { plan = planCatalogResearch(seed, input.snapshot); }
  catch (error) { return { ok: false, code: 'BUNDLE_ENRICHMENT_PLAN_FAILED', error: error.message }; }

  let research = direct?.research || null;
  if (!research) {
    try {
      research = await researchCatalog(plan, effectiveAdapters, {
        limits: input.limits || input.enrichmentLimits || input.costPlan?.hard_limits,
        existingResearch: direct?.existingResearch,
      });
    } catch (error) {
      return { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_RESEARCH_FAILED', error: error?.message || String(error) };
    }
  }
  if (!research?.ok) return { ok: false, code: research?.code || 'BUNDLE_ENRICHMENT_RESEARCH_FAILED', error: research?.error, cost: research?.cost || null };
  let synthesis;
  try { synthesis = await synthesizeCatalog(research, plan, effectiveAdapters); }
  catch (error) { return { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_SYNTHESIS_FAILED', error: error?.message || String(error) }; }
  if (!synthesis?.ok) return { ok: false, code: synthesis?.code || 'BUNDLE_ENRICHMENT_SYNTHESIS_FAILED', error: synthesis?.error, synthesis, cost: synthesis?.cost || research?.cost || null };
  return { ok: true, layer_patches: synthesis.layer_patches, research, synthesis, cost: synthesis.cost || research.cost || null };
}

function accountMemberCost(ledger, cost) {
  const spent = cost?.spent || {};
  for (const [category, amount] of Object.entries(spent)) {
    const reservation = ledger.reserve(category, Number(amount || 0));
    if (!reservation.ok) return reservation;
  }
  return { ok: true };
}

function replacePatch(patches, replacement) {
  const index = patches.findIndex(patch => patch.area === replacement.area && patch.id === replacement.id);
  if (index < 0) patches.push(replacement);
  else patches[index] = replacement;
}

function futureSnapshotOf(snapshot, patches) {
  const future = clone(snapshot);
  for (const patch of patches) {
    if (patch.operation === 'noop') continue;
    const list = future[patch.area];
    if (!Array.isArray(list)) continue;
    const index = list.findIndex(record => record.id === patch.id);
    if (patch.operation === 'create' && index < 0) list.push(clone(patch.record));
    if (patch.operation === 'replace' && index >= 0) list[index] = clone(patch.record);
  }
  return future;
}

function rebuildBridgeEntries(bundle, futureSnapshot) {
  const details = new Map((futureSnapshot['tool-level3'] || []).map(record => [record.id, record]));
  const cards = new Map((futureSnapshot['tool-card'] || []).map(record => [record.id, record]));
  const errors = [];
  const entries = (bundle.bridge_entries || []).map(entry => {
    const detail = details.get(entry.detail_id);
    const card = cards.get(entry.tool_card_id);
    if (!detail || !card || detail.id !== entry.detail_id || card.id !== entry.tool_card_id) {
      errors.push({ model_key: entry.model_key, code: 'BUNDLE_BRIDGE_PROJECTION_MISSING' });
      return entry;
    }
    const modelKey = detail.model_key || card.model_key;
    if (!modelKey || modelKey !== card.model_key) {
      errors.push({ model_key: entry.model_key, code: 'BUNDLE_BRIDGE_PROJECTION_MODEL_KEY_MISMATCH' });
    }
    const officialUrl = detail.official_url || card.official_url || entry.official_url || '';
    if (detail.official_url && card.official_url && detail.official_url !== card.official_url) {
      errors.push({ model_key: entry.model_key, code: 'BUNDLE_BRIDGE_PROJECTION_OFFICIAL_URL_MISMATCH' });
    }
    detail.official_url = officialUrl;
    if (card.official_url !== undefined) card.official_url = officialUrl;
    const l3Patch = (bundle.layer_patches || []).find(p => p.area === 'tool-level3' && p.id === entry.detail_id);
    if (l3Patch && l3Patch.record && !l3Patch.record.official_url) l3Patch.record.official_url = officialUrl;
    return {
      ...entry,
      model_key: modelKey,
      title: detail.title,
      vendor_key: detail.vendor_key,
      detail_id: detail.id,
      tool_card_id: card.id,
      series_id: bundle.series.level2_id,
      official_url: officialUrl,
    };
  });
  return { entries, errors };
}

/** Enriches all new members in memory; never creates or applies a v3 Draft. */
async function finalizeSeriesBundle(bundle, input = {}) {
  const working = clone(bundle);
  const snapshot = input.snapshot || {};
  const errors = [];
  const sharedLedger = input.sharedLedger || createCostLedger(input.enrichmentLimits || input.costPlan?.hard_limits);
  for (const member of working.members || []) {
    if (member.classification !== 'bundled') continue;
    let result;
    try { result = await enrichOne(working, member, { ...input, limits: sharedLedger.snapshot().remaining }); }
    catch (error) { result = { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_FAILED', error: error?.message || String(error) }; }
    if (!result?.ok) {
      if (result?.cost) accountMemberCost(sharedLedger, result.cost);
      errors.push({ model_key: member.model_key, name: member.name, code: result?.code || 'BUNDLE_ENRICHMENT_FAILED', error: result?.error || null });
      continue;
    }
    const detailPatch = patchFor(result, 'tool-level3');
    const cardPatch = patchFor(result, 'tool-card');
    if (!detailPatch || detailPatch.id !== member.detail_id || !detailPatch.record
      || !cardPatch || cardPatch.id !== member.tool_card_id || !cardPatch.record) {
      errors.push({ model_key: member.model_key, name: member.name, code: 'BUNDLE_ENRICHMENT_PATCH_INVALID' });
      continue;
    }
    const accounted = accountMemberCost(sharedLedger, result.cost);
    if (!accounted.ok) {
      errors.push({ model_key: member.model_key, name: member.name, code: accounted.code || 'BUNDLE_ENRICHMENT_COST_EXHAUSTED' });
      continue;
    }
    const cardRef = cardPatch.record.detail_ref?.id;
    const shortDetailId = member.detail_id.slice('tool-level3:'.length);
    if (cardRef && cardRef !== member.detail_id && cardRef !== shortDetailId) {
      errors.push({ model_key: member.model_key, name: member.name, code: 'BUNDLE_ENRICHMENT_DETAIL_REF_INVALID' });
      continue;
    }
    cardPatch.record = { ...cardPatch.record, detail_ref: { kind: 'tool-level3', id: member.detail_id } };
    replacePatch(working.layer_patches, detailPatch);
    replacePatch(working.layer_patches, cardPatch);
  }

  working.cost = { ...(working.cost || {}), enrichment: sharedLedger.snapshot() };
  working.future_snapshot = futureSnapshotOf(snapshot, working.layer_patches);
  const rebuiltBridge = rebuildBridgeEntries(working, working.future_snapshot);
  working.bridge_entries = rebuiltBridge.entries;
  errors.push(...rebuiltBridge.errors);
  working.preview_hash = bundlePreviewHashOf(working);
  working.bundle_token = bundleTokenOf(working);
  if (errors.length) {
    working.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
    working.enrichment_errors = errors;
    working.readiness = 'blocked';
    working.bundle_token = bundleTokenOf(working);
    return { ok: false, code: 'BUNDLE_MEMBER_ENRICHMENT_FAILED', bundle: working, errors };
  }

  working.blockers = [];
  const checked = input.validate
    ? input.validate(working)
    : { ok: true, blockers: [] };
  if (!checked.ok) {
    working.blockers = [...checked.blockers];
    working.readiness = 'blocked';
    working.bundle_token = bundleTokenOf(working);
    return { ok: false, code: checked.blockers[0] || 'BUNDLE_BLOCKED', bundle: working, errors: checked.blockers };
  }
  working.readiness = 'ready';
  working.bundle_token = bundleTokenOf(working);
  return { ok: true, bundle: working };
}

async function finalizeSeriesBundles(entries, input = {}) {
  const members = entries.flatMap(entry => (entry.bundle.members || []).filter(member => member.classification === 'bundled'));
  const limits = input.enrichmentLimits || {};
  const sharedLedger = input.sharedLedger || createCostLedger(limits, input.enrichmentSpent || {});
  const results = [];
  for (const entry of entries) {
    entry.bundle.enrichment_hard_limits = limits;
    entry.bundle.enrichment_confirmation_token = input.enrichmentConfirmationToken || null;
    const finalized = await finalizeSeriesBundle(entry.bundle, { ...input, sharedLedger, enrichmentLimits: limits });
    results.push({ ...entry, finalized });
  }
  return { results, sharedLedger, memberCount: members.length };
}

module.exports = { finalizeSeriesBundle, finalizeSeriesBundles, futureSnapshotOf };
