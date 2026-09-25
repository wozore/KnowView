'use strict';

const {
  resolveBatchCandidates,
  resolveBatchPlacements,
  catalogModelKeyIndex,
  alreadyCompleteInCatalog,
  lookupRegistryForCard,
  seriesReceiptNames,
} = require('./intake');
const { createCostLedger, inferModality } = require('./core');
const { blockedEntriesOf, projectDraft, sanitizeReason } = require('./catalog-workbench-view');

const REUSABLE_DRAFT_STATES = Object.freeze(['researching', 'preview_ready', 'preview_blocked', 'failed_retryable', 'rolled_back', 'resuming']);

function safeErrorCode(error, fallback) {
  const code = String(error?.code || '').split(':')[0];
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : fallback;
}

function approvedCatalogCandidates(pending, snapshot, options) {
  const modelIndex = catalogModelKeyIndex(snapshot.snapshot || {});
  const validSeriesNames = seriesReceiptNames(options, snapshot.revision, pending.cards);
  const completed = [];
  const cards = [];
  for (const card of pending.cards) {
    if (card.review_status !== 'approved' || card.entity_type === 'series'
      || card.intake_outcome === 'committed') continue;
    if (alreadyCompleteInCatalog(card, options, modelIndex, lookupRegistryForCard)) {
      completed.push({ candidate_key: card.candidate_key, name: card.name, outcome: 'already_complete' });
      continue;
    }
    if (card.intake_outcome === 'bundled_for_review' && validSeriesNames.has(String(card.name || '').trim().toLowerCase())) continue;
    cards.push(card);
  }
  return { pending, cards, completed };
}

function reusableDraftsOf(dependencies, revision) {
  return dependencies.listDrafts().filter(draft => dependencies.isCatalogDraft(draft)
    && draft.base_revision === revision && REUSABLE_DRAFT_STATES.includes(draft.state));
}

function normalizeResolutionResult(result) {
  if (!result || typeof result !== 'object') return { seeds: [], unresolved: [] };
  return {
    ...result,
    seeds: Array.isArray(result.seeds) ? result.seeds : [],
    unresolved: Array.isArray(result.unresolved) ? result.unresolved : [],
    verification_blocked: Array.isArray(result.verification_blocked) ? result.verification_blocked : [],
    series_candidates: Array.isArray(result.series_candidates) ? result.series_candidates : [],
  };
}

function reusableProfileMatches(draft, card) {
  if (card.detail_kind_hint !== 'api_model') return true;
  const expectedModality = inferModality({ detail_kind: 'api_model', name: card.name, modality: card.modality });
  return draft.research_plan?.profile?.modality === expectedModality;
}

function takeReusableDrafts(cards, dependencies, revision) {
  const used = new Set();
  const drafts = [];
  const missingCards = [];
  const match = (items, key, card) => items.find(draft => !used.has(draft.draft_id)
    && reusableProfileMatches(draft, card)
    && (draft.seed?.candidate_key === key || (!draft.seed?.candidate_key
      && String(draft.seed?.name || '').trim().toLowerCase() === String(card.name || '').trim().toLowerCase())));
  const initial = reusableDraftsOf(dependencies, revision);
  for (const card of cards) {
    const key = dependencies.candidateKey(card);
    const existing = match(initial, key, card);
    if (existing && reusableProfileMatches(existing, card)) {
      used.add(existing.draft_id);
      drafts.push(projectDraft(existing, { candidate_key: key, reused: true }));
    } else missingCards.push(card);
  }
  return { used, drafts, missingCards, matchReusable: match };
}

async function resolvePlacements(seeds, options, resolveOptions, loadCatalog) {
  const modelSeeds = seeds.filter(seed => seed?.detail_kind === 'api_model');
  if (!modelSeeds.length) return [];
  const placementOptions = {
    ...resolveOptions,
    snapshotOf: options.resolveOptions?.snapshotOf || (() => loadCatalog().snapshot),
  };
  if (placementOptions.allowAiPlacement === true && !placementOptions.placementLedger) {
    placementOptions.placementLedger = createCostLedger({ responses_calls: modelSeeds.length });
  }
  try {
    const result = await (options.resolveBatchPlacements || resolveBatchPlacements)(seeds, placementOptions);
    return Array.isArray(result?.blocked) ? result.blocked.map(item => ({
      ...item,
      phase: 'placement',
      reason: sanitizeReason(item.reason),
    })) : [];
  } catch (error) {
    return modelSeeds.map(seed => ({
      name: seed.name,
      phase: 'placement',
      code: safeErrorCode(error, 'PLACEMENT_RESOLUTION_FAILED'),
      reason: '模型系列放置解析失败',
    }));
  }
}

async function prepareResolvedCards(input, dependencies) {
  const { resolved, missingCards, planned, reuse, blocked, placementBlocked } = input;
  const byName = new Map((resolved.seeds || []).map(seed => [String(seed.name).trim().toLowerCase(), seed]));
  const placementBlockedNames = new Set(placementBlocked.map(item => String(item.name || '').trim().toLowerCase()));
  const seriesNames = new Set((resolved.series_candidates || []).map(item => String(item.name || '').trim().toLowerCase()));
  const completedKeys = new Set((resolved.intake_outcomes || [])
    .filter(item => item?.outcome === 'already_complete')
    .map(item => item.candidate_key));
  for (const card of missingCards) {
    const key = dependencies.candidateKey(card);
    if (completedKeys.has(key)) continue;
    const existing = reuse.matchReusable(reusableDraftsOf(dependencies, planned.catalog_revision), key, card);
    if (existing) {
      reuse.used.add(existing.draft_id);
      reuse.drafts.push(projectDraft(existing, { candidate_key: key, reused: true }));
      continue;
    }
    const resolvedSeed = byName.get(String(card.name).trim().toLowerCase());
    if (!resolvedSeed) {
      const alreadyBlocked = seriesNames.has(String(card.name).trim().toLowerCase())
        || blocked.some(item => (item.candidate_key && item.candidate_key === key) || item.name === card.name);
      if (!alreadyBlocked) blocked.push({ candidate_key: key, name: card.name, phase: 'source_resolution', code: 'SEED_NOT_RESOLVED', reason: '未得到可用于 Draft 的解析结果。' });
      continue;
    }
    const seed = { ...resolvedSeed, candidate_key: key };
    if (seed.detail_kind === 'api_model' && !seed.modality) {
      seed.modality = inferModality({ detail_kind: 'api_model', name: seed.name, identity_key: card.identity_key, known_fields: seed.known_fields });
    }
    if (placementBlockedNames.has(String(seed.name || '').trim().toLowerCase())) continue;
    try {
      const draftPlan = dependencies.planCatalogDraft(seed, dependencies.generatorOptions);
      if (!draftPlan?.ok) {
        const code = draftPlan?.code || 'DRAFT_BLOCKED';
        blocked.push({ candidate_key: key, name: card.name, phase: String(code).startsWith('PLACEMENT_') ? 'placement' : 'draft_plan', code, reason: sanitizeReason(draftPlan?.error || code) });
        continue;
      }
      const result = await dependencies.prepareCatalogDraft(seed, {
        ...dependencies.generatorOptions,
        confirmCost: true,
        catalogAdapters: dependencies.options.catalogAdapters,
      });
      if (result && result.draft) reuse.drafts.push(projectDraft(result.draft, { candidate_key: key, reused: false }));
      else blocked.push({ candidate_key: key, name: card.name, phase: 'draft_generation', code: result?.code || 'DRAFT_BLOCKED', reason: sanitizeReason(result?.error) });
    } catch (error) {
      blocked.push({ candidate_key: key, name: card.name, phase: 'draft_generation', code: safeErrorCode(error, 'DRAFT_GENERATION_FAILED'), reason: sanitizeReason(error?.message) });
    }
  }
}

async function runPreparation(input, dependencies) {
  const planned = dependencies.assertPlan(input);
  if (!planned.ok) return planned;
  const { pending, cards, completed: catalogCompleted = [] } = dependencies.approvedCandidates();
  const reuse = takeReusableDrafts(cards, dependencies, planned.catalog_revision);
  const resolveOptions = { ...dependencies.generatorOptions, ...(dependencies.options.resolveOptions || {}) };
  let resolved = { seeds: [], unresolved: [] };
  if (reuse.missingCards.length) {
    try {
      const result = await (dependencies.options.resolveBatchCandidates || resolveBatchCandidates)(reuse.missingCards, resolveOptions);
      resolved = normalizeResolutionResult(result);
    } catch (error) {
      const blocked = reuse.missingCards.map(card => ({
        candidate_key: dependencies.candidateKey(card),
        name: card.name,
        phase: 'source_resolution',
        code: safeErrorCode(error, 'SOURCE_RESOLUTION_FAILED'),
        reason: '官方来源解析批次失败。',
      }));
      const ok = reuse.drafts.length > 0 || catalogCompleted.length > 0;
      return {
        ok,
        ...(!ok ? { code: blocked[0]?.code || 'SOURCE_RESOLUTION_FAILED' } : {}),
        status: reuse.drafts.length ? 'drafts_ready' : catalogCompleted.length ? 'candidates_complete' : 'drafts_blocked',
        pending_revision: pending.revision,
        catalog_revision: planned.catalog_revision,
        plan_hash: planned.plan_hash,
        drafts: reuse.drafts,
        completed: catalogCompleted,
        reused: reuse.drafts.filter(draft => draft.reused).map(draft => draft.draft_id),
        blocked,
      };
    }
  }
  const placementBlocked = await resolvePlacements(Array.isArray(resolved.seeds) ? resolved.seeds : [], dependencies.options, resolveOptions, dependencies.loadCatalog);
  const blocked = [...blockedEntriesOf(resolved, planned), ...placementBlocked];
  await prepareResolvedCards({ resolved, missingCards: reuse.missingCards, planned, reuse, blocked, placementBlocked }, dependencies);
  const resolvedCompleted = (resolved.intake_outcomes || [])
    .filter(item => item?.outcome === 'already_complete')
    .map(item => ({ ...item, name: reuse.missingCards.find(card => dependencies.candidateKey(card) === item.candidate_key)?.name || null }));
  const completed = [...catalogCompleted, ...resolvedCompleted];
  const ok = reuse.drafts.length > 0 || completed.length > 0;
  return {
    ok,
    ...(!ok ? { code: blocked[0]?.code || 'DRAFT_BLOCKED' } : {}),
    status: reuse.drafts.length ? 'drafts_ready' : completed.length ? 'candidates_complete' : 'drafts_blocked',
    pending_revision: pending.revision,
    catalog_revision: planned.catalog_revision,
    plan_hash: planned.plan_hash,
    drafts: reuse.drafts,
    completed,
    reused: reuse.drafts.filter(draft => draft.reused).map(draft => draft.draft_id),
    blocked,
  };
}

function createCatalogPrepareHandler(dependencies) {
  return input => runPreparation(input, dependencies);
}

module.exports = { approvedCatalogCandidates, createCatalogPrepareHandler };
