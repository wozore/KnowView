'use strict';

const {
  planCatalogResearch,
  researchCatalog,
  synthesizeCatalog,
  createCostLedger,
  DEFAULT_LIMITS,
} = require('../core');
const { createCatalogAiAdapters } = require('../intake/catalog-adapters');
const { bundlePreviewHashOf, bundleTokenOf } = require('./series-bundle-contract');
const {
  allocateMemberBudgets,
  legacySpendOf,
  bundleEnrichmentCost,
} = require('./series-bundle-enrichment');
const { finalizeBundleMembers } = require('./series-bundle-finalizer-members');
const { loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed } = require('../catalog-integrated-lookup');

let cachedLookup = null;
function getIntegratedLookup() {
  if (!cachedLookup) {
    try { cachedLookup = buildIntegratedLookup(loadSharedReleaseIndex()); } catch { cachedLookup = new Map(); }
  }
  return cachedLookup;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memberSeed(bundle, member) {
  const detailId = member.detail_id.slice('tool-level3:'.length);
  const cardId = member.tool_card_id.slice('tool-card:'.length);
  const evidence = member.evidence || {};
  const officialUrl = evidence.official_url || '';
  // 已核验来源全量下传：identity receipt 的 sources[]/official_urls 都是身份核验通过的证据，
  // 必须进入 member seed 让 research 信任根与 X 公告等来源一致，而不是只传首条。
  const authorizedSources = (Array.isArray(evidence.sources) ? evidence.sources : [])
    .filter(source => source?.url)
    .map(source => ({
      url: source.url,
      kind: 'identity_verified',
      ...(source.content_hash ? { content_hash: source.content_hash } : {}),
    }));
  const evidenceUrls = Array.isArray(evidence.official_urls) ? evidence.official_urls : [];
  const urlOrder = [...new Set([officialUrl, ...evidenceUrls, ...authorizedSources.map(source => source.url)].filter(Boolean))];
  const seenUrls = new Set(authorizedSources.map(source => source.url));
  const hintSources = urlOrder
    .filter(url => !seenUrls.has(url))
    .map(url => ({ url, kind: 'official_hint' }));
  const knownFields = { theme: 'general' };
  const hit = lookupReleaseDateForSeed({ name: member.name, tool_key: cardId, detail_kind: 'api_model' }, getIntegratedLookup());
  if (hit && hit.date) knownFields.integrated_release_date = hit.date;
  const modality = member.profile_modality || bundle.series.profile_modality
    || bundle.candidate?.modality || bundle.series.modality;
  return {
    detail_kind: 'api_model',
    ...(modality ? { modality } : {}),
    repair_layers: ['tool-level3', 'tool-card'],
    name: member.name,
    vendor_name: bundle.vendor_key,
    vendor_key: bundle.vendor_key,
    tool_key: cardId,
    detail_key: detailId,
    model_key: member.model_key,
    task_types: member.task_types || [],
    series_kind: bundle.series.series_kind,
    official_url: officialUrl || urlOrder[0] || '',
    placement: {
      existing_level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${bundle.vendor_key}` },
      existing_level2_ref: { kind: 'vendor-level2', id: bundle.series.level2_id },
    },
    known_fields: knownFields,
    discovery_sources: [...authorizedSources, ...hintSources],
  };
}

function patchFor(result, area) {
  return (result?.layer_patches || []).find(patch => patch.area === area && patch.operation !== 'noop') || null;
}

function memberResearchSnapshot(bundle, member, snapshot) {
  const targets = [
    ['vendor-level2', bundle.series?.level2_id],
    ['tool-level3', member.detail_id],
    ['tool-card', member.tool_card_id],
  ];
  const patches = bundle.layer_patches || [];
  const targetsPlanned = targets.every(([area, id]) => patches.some(patch =>
    patch.area === area && patch.id === id && patch.record?.id === id && ['create', 'replace'].includes(patch.operation)));
  if (!targetsPlanned) return null;
  // ResearchPlan sees Bundle-owned layers as staged; the final Bundle still validates against its base snapshot.
  const projected = futureSnapshotOf(snapshot, patches);
  return targets.every(([area, id]) => (projected[area] || []).some(record => record.id === id)) ? projected : null;
}

async function enrichOne(bundle, member, input) {
  const seed = memberSeed(bundle, member);
  try { planCatalogResearch(seed, input.snapshot); }
  catch (error) { return { ok: false, code: 'BUNDLE_ENRICHMENT_PLAN_FAILED', error: error.message }; }
  const preset = input.memberEnrichment?.[member.model_key] || input.memberEnrichment?.[member.name];
  if (preset?.ok === false) return preset;
  const researchSnapshot = memberResearchSnapshot(bundle, member, input.snapshot);
  if (!researchSnapshot) return { ok: false, code: 'BUNDLE_MEMBER_PATCH_MISSING' };
  const direct = typeof input.enrichMember === 'function'
    ? await input.enrichMember({ bundle, member, seed, existingResearch: input.existingResearch, missingFields: input.missingFields, limits: input.limits })
    : preset;
  if (direct?.ok === false) return direct;
  if (direct?.layer_patches) return { ok: true, layer_patches: direct.layer_patches, research: direct.research || null, cost: direct.cost || null, cost_mode: direct.cost_mode || 'incremental' };
  if (!Array.isArray(member.task_types) || !member.task_types.length) {
    return { ok: false, code: 'BUNDLE_MEMBER_TASK_TYPES_UNRESOLVED' };
  }

  const adapters = input.adapters || input.catalogAdapters;
  if (!adapters?.discover || !adapters?.acquire || !adapters?.synthesize) {
    if (input.requireInjectedAdapters) return { ok: false, code: 'BUNDLE_ENRICHMENT_ADAPTERS_REQUIRED' };
  }
  const effectiveAdapters = adapters || createCatalogAiAdapters(input.generatorOptions || input);
  let plan;
  try { plan = planCatalogResearch(seed, researchSnapshot); }
  catch (error) { return { ok: false, code: 'BUNDLE_ENRICHMENT_PLAN_FAILED', error: error.message }; }
  if (plan.research_scopes.some(scope => scope.kind === 'group')) return { ok: false, code: 'BUNDLE_MEMBER_PLAN_INVALID' };

  let research = direct?.research || null;
  if (!research) {
    try {
      research = await researchCatalog(plan, effectiveAdapters, {
        limits: input.limits || input.enrichmentLimits || input.costPlan?.hard_limits,
        existingResearch: direct?.existingResearch || input.existingResearch,
        missingFields: input.missingFields,
      });
    } catch (error) {
      return { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_RESEARCH_FAILED', error: error?.message || String(error) };
    }
  }
  if (typeof input.onResearchCheckpoint === 'function') await input.onResearchCheckpoint(research);
  if (!research?.ok) return { ok: false, code: research?.code || 'BUNDLE_ENRICHMENT_RESEARCH_FAILED', error: research?.error, research, cost: research?.cost || null, cost_mode: 'cumulative' };
  let synthesis;
  try { synthesis = await synthesizeCatalog(research, plan, effectiveAdapters); }
  catch (error) { return { ok: false, code: error?.code || 'BUNDLE_ENRICHMENT_SYNTHESIS_FAILED', error: error?.message || String(error), research, cost: research._cost_ledger?.snapshot?.() || research.cost || null, cost_mode: 'cumulative' }; }
  if (!synthesis?.ok) return { ok: false, code: synthesis?.code || 'BUNDLE_ENRICHMENT_SYNTHESIS_FAILED', error: synthesis?.error, synthesis, research, cost: synthesis?.cost || research?.cost || null, cost_mode: 'cumulative' };
  return { ok: true, layer_patches: synthesis.layer_patches, research, synthesis, cost: synthesis.cost || research.cost || null, cost_mode: 'cumulative' };
}

function enrichmentDiagnostic(result) {
  const synthesis = result?.synthesis || {};
  const research = result?.research || {};
  return {
    code: result?.code || 'BUNDLE_ENRICHMENT_FAILED',
    error: result?.error || null,
    missing_fields: synthesis.missing_fields || [],
    synthesis_errors: synthesis.errors || [],
    research_code: research.code || null,
    research_error: research.error || null,
    official_source_count: Array.isArray(research.official_sources) ? research.official_sources.length : 0,
  };
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
function finalizeBundleReadiness(working, snapshot, input, sharedLedger, legacySpend, errors) {
  bundleEnrichmentCost(working, working.enrichment_hard_limits || sharedLedger.snapshot().limits, legacySpend);
  working.future_snapshot = futureSnapshotOf(snapshot, working.layer_patches);
  const rebuilt = rebuildBridgeEntries(working, working.future_snapshot);
  working.bridge_entries = rebuilt.entries;
  errors.push(...rebuilt.errors);
  working.preview_hash = bundlePreviewHashOf(working);
  if (errors.length) {
    working.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT', 'BUNDLE_MEMBER_ENRICHMENT_FAILED'];
    working.enrichment_errors = errors;
    working.readiness = 'blocked';
    working.bundle_token = bundleTokenOf(working);
    return { ok: false, code: 'BUNDLE_MEMBER_ENRICHMENT_FAILED', bundle: working, errors };
  }
  working.blockers = [];
  const checked = input.validate ? input.validate(working) : { ok: true, blockers: [] };
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

async function finalizeSeriesBundle(bundle, input = {}) {
  const working = clone(bundle);
  const limits = input.enrichmentLimits || input.costPlan?.hard_limits || DEFAULT_LIMITS;
  const budgets = input.memberBudgets || allocateMemberBudgets([{ bundle: working }], limits);
  const sharedLedger = input.sharedLedger || createCostLedger(limits, input.enrichmentSpent || {});
  const legacySpend = legacySpendOf(working);
  const memberInput = { ...input, sharedLedger, enrichmentLimits: limits, enrichOne, enrichmentDiagnostic, patchFor, replacePatch };
  const errors = await finalizeBundleMembers(working, memberInput, legacySpend, budgets);
  return finalizeBundleReadiness(working, input.snapshot || {}, input, sharedLedger, legacySpend, errors);
}
async function finalizeSeriesBundles(entries, input = {}) {
  const members = entries.flatMap(entry => (entry.bundle.members || []).filter(member => member.classification === 'bundled'));
  const limits = input.enrichmentLimits || DEFAULT_LIMITS;
  const sharedLedger = input.sharedLedger || createCostLedger(limits, input.enrichmentSpent || {});
  const memberBudgets = allocateMemberBudgets(entries, limits);
  const results = [];
  for (const entry of entries) {
    entry.bundle.enrichment_hard_limits ||= limits;
    entry.bundle.enrichment_confirmation_token = input.enrichmentConfirmationToken || null;
    const onCheckpoint = typeof input.onCheckpoint === 'function'
      ? checkpoint => input.onCheckpoint({ ...checkpoint, entry })
      : null;
    const finalized = await finalizeSeriesBundle(entry.bundle, { ...input, sharedLedger, memberBudgets, onCheckpoint, enrichmentLimits: limits });
    results.push({ ...entry, finalized });
  }
  return { results, sharedLedger, memberCount: members.length };
}

module.exports = { allocateMemberBudgets, finalizeSeriesBundle, finalizeSeriesBundles, futureSnapshotOf };
