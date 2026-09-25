'use strict';

const { readJson } = require('../../shared/json-store');
const { catalog } = require('../interface');
const { pendingCandidateToSeed } = require('../../pending');
const { readPending, setIntakeOutcome } = require('../../pending');
const { listDrafts } = require('../draft/catalog-draft-store');
const { planCatalogDraft, normalizeGeneratorOptions, loadGeneratorConfig } = require('../draft');
const { resolveOfficialSource } = require('./catalog-adapters');
const { resolveSeriesPlacement, applyPlacementToSeed, loadSeriesPolicy, normalizeVendorKey } = require('../series');
const { loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed } = require('../catalog-integrated-lookup');
const { loadCatalogSnapshot, createCostLedger, slugify } = require('../core');
const { lookupOfficialUrl } = require('../url-registry');
const {
  verifyModelIdentity,
  discoverSeriesMembers,
  catalogModelKeyIndex,
  readIdentityReceipts,
} = require('./model-identity-verification');
const { appendIdentityReceipts } = require('./identity-receipts');
const { searchAttemptMultiplier, identitySearchRequestBounds, estimateResolutionNeed: estimateResolutionNeedBy } = require('./resolution-cost');
const {
  createIdentityVerificationAdapters,
  createSeriesMembersSuggestAdapter,
  identityAdapterOptionsOf,
  identityContextOf,
} = require('./identity-adapters');
const { verifyModelCandidate, discoverSeriesMembersSafely } = require('./resolution-model-guards');
const MODEL_NAME_PATTERN = /(?:GPT|Claude|Gemini|Qwen|Llama|GLM|Mistral|DeepSeek|MiniMax|Grok|Kling)[\s-]?[A-Za-z]*\d/i;

function lookupRegistryForCard(card, options = {}) {
  const name = String(card?.name || card?.title || '').trim();
  const lookupOptions = {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.productRegistry !== undefined ? { productRegistry: options.productRegistry } : {}),
    ...(card?.detail_kind_hint ? { detailKind: card.detail_kind_hint } : {}),
  };
  const direct = lookupOfficialUrl(name, lookupOptions);
  if (direct.ok || card?.detail_kind_hint !== 'tool' || !MODEL_NAME_PATTERN.test(name)) return direct;
  const modelHit = lookupOfficialUrl(name, { ...lookupOptions, detailKind: 'api_model' });
  return modelHit.ok ? { ...modelHit, detail_kind_hint: 'api_model' } : direct;
}

/** 旧反馈数据可能把带版本号的模型标成 tool；模型登记表命中时按 api_model 继续处理。 */
function effectiveCardForResolution(card, resolution) {
  return resolution?.detail_kind_hint === 'api_model' && card?.detail_kind_hint !== 'api_model'
    ? { ...card, detail_kind_hint: 'api_model' }
    : card;
}


function estimateResolutionNeed(cards, options = {}) {
  return estimateResolutionNeedBy(cards, options, lookupRegistryForCard);
}

/** 浅深拷贝快照（供 placement 顺序投影，不改原始数据）。 */
function cloneSnapshot(snapshot) {
  const clone = {};
  for (const [area, items] of Object.entries(snapshot || {})) {
    clone[area] = (items || []).map(item => {
      const copy = { ...item };
      if (Array.isArray(item.level2_refs)) copy.level2_refs = [...item.level2_refs];
      if (Array.isArray(item.detail_refs)) copy.detail_refs = [...item.detail_refs];
      return copy;
    });
  }
  return clone;
}

/** 把一次 decision 的成员数累加进投影快照，使同批后续同厂商候选看到最新成员数。 */
function bumpProjectedSeries(projected, decision, candidate) {
  if (!decision || !decision.target_mode) return;
  const targetId = decision.target_level2_id;
  if (!targetId) return;
  let l2 = (projected['vendor-level2'] || []).find(x => x.id === targetId);
  if (!l2) {
    l2 = {
      id: targetId,
      level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${decision.vendor}` },
      vendor_key: decision.vendor,
      title: decision.target_level2_title || '',
      official_url: '',
      summary: '',
      status: 'unknown',
      detail_refs: [],
    };
    projected['vendor-level2'].push(l2);
  }
  const key = candidate?.name ? slugify(candidate.name, 'batch_member') : '__batch_placeholder__';
  l2.detail_refs.push({ kind: 'tool-level3', id: `tool-level3:${key}` });
}

/**
 * 批量前置：顺序解析 api_model seed 的二级系列归属（阶段 5）。
 * 顺序维护投影快照（每 decision 累加成员数），使同批多个同厂商候选基于最新成员数判定；
 * migration_required（第 4 个触发拆分）与 fail_closed 收进 blocked，由调用方阻断对应 seed。
 * 已持久化 placement_decision 的 seed（from-preview/resume）短路复用，不重复调 AI。
 * @returns {Promise<{ blocked: Array<{name,kind,code,reason}> }>}
 */
async function resolveBatchPlacements(seeds, options = {}) {
  const policy = loadSeriesPolicy();
  const base = options.snapshotOf ? options.snapshotOf() : loadCatalogSnapshot().snapshot;
  const projected = cloneSnapshot(base);
  const resolve = options.resolveSeriesPlacement || resolveSeriesPlacement;
  const blocked = [];
  for (const seed of seeds || []) {
    if (!seed || seed.detail_kind !== 'api_model') continue;
    const placement = await resolve(policy, projected, seed, {
      allowAi: options.allowAiPlacement === true,
      ledger: options.placementLedger,
      suggestPlacement: options.suggestSeriesPlacement,
    });
    if (placement.kind === 'decision') {
      applyPlacementToSeed(seed, placement);
      bumpProjectedSeries(projected, placement, seed);
    } else if (placement.kind === 'migration_required' || placement.kind === 'fail_closed') {
      blocked.push({
        name: seed.name,
        kind: placement.kind,
        code: placement.code || 'PLACEMENT_MIGRATION_REQUIRED',
        reason: placement.reason || '',
      });
    }
  }
  return { blocked };
}

function generatorOptionsOf(options) {
  return options.generatorOptions || normalizeGeneratorOptions(loadGeneratorConfig());
}

/** 读取待补卡文件（tool-cards-pending.json），返回 cards 数组；容器/卡类型非法则 fail-closed。 */
function readPendingCards(filePath) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PENDING_CARDS_INVALID: 待补卡文件根节点必须是对象');
  }
  if (!Array.isArray(payload.cards)) {
    throw new Error('PENDING_CARDS_INVALID: 待补卡文件缺少 cards 数组');
  }
  for (const card of payload.cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('PENDING_CARD_INVALID: 某张待补卡不是对象');
    }
    if (typeof card.name !== 'string' || !card.name.trim()) {
      throw new Error('PENDING_CARD_NAME_REQUIRED: 某张待补卡缺少 name');
    }
    if (card.detail_kind_hint !== undefined && typeof card.detail_kind_hint !== 'string') {
      throw new Error(`PENDING_CARD_DETAIL_KIND_TYPE_INVALID:${card.name}`);
    }
  }
  return payload.cards;
}

// ═══════════════════════════════════════════════════════════════
// 1. 查重（正式目录 / 进行中 draft / 同批）
// ═══════════════════════════════════════════════════════════════

function listCatalogTools(options) {
  if (options.tools) return options.tools;
  const result = catalog({ area: 'tool-card', operation: 'list' });
  return result.ok ? result.data : [];
}

function listCatalogDrafts(options) {
  if (options.drafts) return options.drafts;
  try { return listDrafts(); } catch { return []; }
}

/**
 * 三层查重：同批去重 / 进行中 draft 跳过 / 目录已存在降级为 needs_verification 提示。
 * 目录 title/tool_key 精确相等不再跳过（由官方核验与 model_key 查重裁决），仍进 unique 全量核验。
 * @param {Array<object>} cards 待补卡
 * @param {object} [options] { tools, drafts }
 * @returns {{ unique: [], needsVerification: [], skippedDraft: [], duplicateInBatch: [] }}
 */
function dedupeBatchCandidates(cards, options = {}) {
  const tools = listCatalogTools(options);
  const drafts = listCatalogDrafts(options);
  const seenInBatch = new Set();
  const result = { unique: [], needsVerification: [], skippedDraft: [], duplicateInBatch: [] };
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    let key;
    try { key = slugify(name, 'tool_key'); } catch { key = name.toLowerCase(); }
    if (seenInBatch.has(key)) { result.duplicateInBatch.push({ name, reason: '同批重复' }); continue; }
    seenInBatch.add(key);
    // 精确匹配：title 或 tool_key 大小写不敏感相等（不用 toolExists 的双向子串，
    // 避免 "Command A+" 被 "Command A" 子串误判为已存在）
    const existsExact = (tools || []).some(tool =>
      (tool.title && String(tool.title).toLowerCase() === name.toLowerCase()) ||
      (tool.tool_key && String(tool.tool_key).toLowerCase() === name.toLowerCase())
    );
    if (existsExact) {
      result.needsVerification.push({ name, reason: '目录可能已存在（title/tool_key 相等，交官方核验与 model_key 查重裁决）' });
    }
    const draftHit = (drafts || []).find(draft => {
      const seedName = draft?.seed && (draft.seed.name || draft.seed.title);
      return seedName && String(seedName).trim().toLowerCase() === name.toLowerCase();
    });
    if (draftHit) {
      result.skippedDraft.push({ name, draft_id: draftHit.draft_id, reason: '进行中 draft 已存在' });
      continue;
    }
    result.unique.push(card);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 2. 厂商/官方源解析 + 官方身份核验分流
// ═══════════════════════════════════════════════════════════════

/** 按 verdict 分流写 intake_outcome（CAS 短重试；仅系统管线调用）。 */
async function writeIntakeOutcome(card, outcome, options = {}) {
  if (!card?.candidate_key || options.setIntakeOutcome === null) return null;
  const setFn = options.setIntakeOutcome || setIntakeOutcome;
  const pendingOptions = options.pendingToolFile ? { toolFile: options.pendingToolFile } : {};
  for (let attempt = 0; attempt < 3; attempt++) {
    let revision;
    try { revision = readPending('tools', pendingOptions).revision; } catch { return { candidate_key: card.candidate_key, outcome: null, code: 'PENDING_FILE_INVALID' }; }
    try {
      await setFn('tools', card.candidate_key, outcome, revision, pendingOptions);
      return { candidate_key: card.candidate_key, outcome };
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT' || attempt === 2) {
        return { candidate_key: card.candidate_key, outcome: null, code: error?.code || 'INTAKE_OUTCOME_WRITE_FAILED' };
      }
    }
  }
  return null;
}

async function resolveBatchCandidates(cards, options = {}) {
  const resolveFn = options.resolveOfficialSource || resolveOfficialSource;
  const verifyFn = options.verifyModelIdentity || verifyModelIdentity;
  const membersFn = options.discoverSeriesMembers || discoverSeriesMembers;
  const indexFn = options.catalogModelKeyIndex || catalogModelKeyIndex;
  const fallbackSearchMultiplier = searchAttemptMultiplier(options);
  const ledger = options.resolveLedger || createCostLedger({ search_queries: Math.max(1, (cards || []).length) * fallbackSearchMultiplier, responses_calls: Math.max(1, (cards || []).length) });
  // 核验预算按本批模型轴卡数下限放大（调用方显式 identityBudgetSize 取两者较大值）
  const modelAxisCount = (cards || []).filter(card => card.entity_type === 'series'
    || card.entity_type === 'model' || card.detail_kind_hint === 'api_model').length;
  const identitySearchRequests = identitySearchRequestBounds((cards || []).filter(card => card.entity_type === 'series'
    || card.entity_type === 'model' || card.detail_kind_hint === 'api_model'), options, lookupRegistryForCard);
  const identityOptions = modelAxisCount
    ? {
      ...options,
      identityBudgetSize: Math.max(modelAxisCount, Number(options.identityBudgetSize) || 0),
      identitySearchBudget: identitySearchRequests.primary + identitySearchRequests.fallback,
    }
    : options;
  const context = options.identityContext || identityContextOf(identityOptions);
  // 核验适配器默认按白名单 options 构造 Web Search + 正文读取适配器；options.identityAdapters 注入优先（测试/显式覆盖）。
  const identityAdapters = options.identityAdapters || createIdentityVerificationAdapters(identityAdapterOptionsOf(options));
  const modelKeyIndex = indexFn(context.snapshot);
  const seeds = [];
  const unresolved = [];
  const seriesCandidates = [];
  const blocked = [];
  const verdicts = [];
  const intakeOutcomes = [];
  const freshReceipts = [];
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    let registryHit;
    try { registryHit = lookupRegistryForCard(card, options); }
    catch (error) {
      unresolved.push({ name, reason: `${error?.code || 'OFFICIAL_REGISTRY_LOOKUP_FAILED'}: ${error?.message || String(error)}` });
      continue;
    }
    const isModelAxis = card.entity_type === 'series' || card.entity_type === 'model'
      || card.detail_kind_hint === 'api_model';
    if (isModelAxis) {
      const cardOfficialUrls = (Array.isArray(card.official_urls) ? card.official_urls : []).filter(Boolean);
      const officialUrls = cardOfficialUrls.length ? cardOfficialUrls : [
        ...(Array.isArray(registryHit?.official_urls) ? registryHit.official_urls : []),
        ...(registryHit?.ok && registryHit.official_url ? [registryHit.official_url] : []),
      ].filter(Boolean);
      const registryVendorHint = registryHit?.ok && context?.policy
        ? normalizeVendorKey(context.policy, registryHit.vendor_name)
        : null;
      const identityAliases = [...new Set([
        ...(Array.isArray(card.identity_aliases) ? card.identity_aliases : []),
        ...(Array.isArray(registryHit?.identity_aliases) ? registryHit.identity_aliases : []),
      ])];
      const result = await verifyModelCandidate(verifyFn, {
        name,
        entity_type: card.entity_type || 'model',
        vendor_hint: card.vendor_key || card.vendor_hint || registryVendorHint || registryHit.matched_key || registryHit.vendor_key,
        official_urls: officialUrls,
        ...(card.identity_key ? { identity_key: card.identity_key } : {}),
        ...(identityAliases.length ? { identity_aliases: identityAliases } : {}),
      }, context, identityAdapters);
      if (!result.ok) {
        blocked.push({ name, code: result.code, reason: result.error || '' });
        intakeOutcomes.push(await writeIntakeOutcome(card, 'verification_blocked', options));
        continue;
      }
      verdicts.push({ name, verdict: result.verdict, receipt: result.receipt, reused: result.reused === true });
      // 新鲜核验回执落盘（receipt 复用的唯一写点）；持久化失败不阻断主流程，只损失后续 24h 复用
      if (result.receipt && result.reused !== true) freshReceipts.push(result.receipt);
      if (result.verdict.entity_class === 'series') {
        let members = { ok: true, members: [] };
        if (options.discoverSeriesMembers !== null) {
          members = await discoverSeriesMembersSafely(membersFn, result.verdict, identityAdapters, context);
        }
        if (!members.ok || !Array.isArray(members.members) || !members.members.length) {
          blocked.push({ name, code: members.code || 'IDENTITY_MEMBERS_INSUFFICIENT', reason: members.error || '系列成员证据不足' });
          intakeOutcomes.push(await writeIntakeOutcome(card, 'deferred_insufficient_evidence', options));
          continue;
        }
        seriesCandidates.push({
          candidate_key: card.candidate_key || null,
          name,
          vendor_key: result.verdict.vendor_key,
          family: result.verdict.family || result.verdict.canonical_family || null,
          series_title: result.verdict.series_title || null,
          modality: result.verdict.modality || card.modality || null,
          series_kind: result.verdict.series_kind || null,
          verdict: result.verdict,
          members: members.members,
          receipt: result.receipt,
        });
        continue;
      }
      if (modelKeyIndex.has(result.verdict.model_key)) {
        intakeOutcomes.push(await writeIntakeOutcome(card, 'already_complete', options)
          || { candidate_key: card.candidate_key || null, outcome: 'already_complete' });
        continue;
      }
      // 普通 api_model seed：registry 命中仅作域提示，official_urls 全量注入
      try {
        const verifiedUrl = result.verdict.evidence?.official_url;
        const verifiedUrls = [...new Set([verifiedUrl, ...officialUrls].filter(Boolean))];
        const seed = pendingCandidateToSeed(effectiveCardForResolution(card, registryHit.ok ? registryHit : card), {
          ...(registryHit.ok ? registryHit : {}),
          vendor_key: result.verdict.vendor_key,
          official_urls: verifiedUrls,
        });
        seed.model_key = result.verdict.model_key;
        seeds.push(seed);
      } catch (error) {
        unresolved.push({ name: card.name, reason: error?.message || String(error) });
      }
      continue;
    }
    if (registryHit.ok) {
      // registry 命中零解析成本，但 seed 转换（vague/非法 kind）仍可能抛错，须收进 unresolved 而非中断整批。
      try {
        seeds.push(pendingCandidateToSeed(effectiveCardForResolution(card, registryHit), registryHit));
      } catch (error) {
        unresolved.push({ name: card.name, reason: error?.message || String(error) });
      }
      continue;
    }
    try {
      const ledgerLimits = typeof ledger.snapshot === 'function' ? ledger.snapshot().limits : null;
      if (ledgerLimits && Object.prototype.hasOwnProperty.call(ledgerLimits, 'search_queries') && !ledger.reserve('search_queries', 1).ok) {
        unresolved.push({ name, reason: 'COST_BUDGET_EXHAUSTED' });
        continue;
      }
      const resolved = await resolveFn(name, { ...options, ledger });
      if (resolved && resolved.ok) {
        seeds.push(pendingCandidateToSeed(card, resolved));
      } else {
        unresolved.push({ name, reason: (resolved && (resolved.error || resolved.code)) || 'VENDOR_RESOLUTION_FAILED' });
      }
    } catch (error) {
      unresolved.push({ name, reason: error?.message || String(error) });
    }
  }
  // 新鲜核验回执落盘（receipt 复用的唯一写点）；注入 identityContext（测试接缝）时不自动持久化，
  // 防止 mock 回执污染真实文件；持久化失败不阻断主流程，只损失后续 24h 复用
  if (freshReceipts.length && !options.identityContext) {
    try { appendIdentityReceipts(freshReceipts, options.identityReceiptsFile ? { file: options.identityReceiptsFile } : {}); }
    catch { /* 回执是复用缓存，写失败只损失下次 24h 复用，不阻断采集主流程 */ }
  }
  return {
    seeds,
    unresolved,
    series_candidates: seriesCandidates,
    verification_blocked: blocked,
    verdicts,
    intake_outcomes: intakeOutcomes.filter(Boolean),
    resolve_cost: ledger.snapshot(),
  };
}


module.exports = { lookupRegistryForCard, effectiveCardForResolution, estimateResolutionNeed, cloneSnapshot, bumpProjectedSeries, resolveBatchPlacements, generatorOptionsOf, readPendingCards, listCatalogTools, listCatalogDrafts, dedupeBatchCandidates, resolveBatchCandidates };
