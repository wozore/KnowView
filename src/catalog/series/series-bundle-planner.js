'use strict';

/**
 * series-bundle-planner.js —— SeriesBundle 确定性规划器（零网络零 AI）
 *
 * 依政策 + 当前快照 + 核验 verdict 重算一切：AI 只提供 verdict/成员清单建议，
 * 本模块决定目标系列、成员分类（already_complete/bundled/deferred）、容量与
 * hidden_history 转移、layer_patches、bridge_entries 与 base_revisions。
 * model_key 一律来自核验链路的程序重算值，绝不手工拼接。
 *
 * 新成员的 L3/卡 patch 为骨架记录（官方证据可填字段尽填）；在研究富化完成前
 * readiness 保持 blocked（BUNDLE_MEMBERS_NEED_ENRICHMENT），绝不带骨架提交事务。
 */

const {
  buildLevel1,
  buildLevel2,
  buildDetail,
  buildToolCard,
  slugify,
} = require('../core/catalog-record-builders');
const { revisionOf } = require('../core/catalog-revision');
const { catalogModelKeyIndex } = require('../intake/model-identity-verification');
const { planSeriesPlacement } = require('./catalog-series-policy');
const { readModelIdentityBridge } = require('../../shared/model-identity-bridge');
const { bundleTokenOf, bundlePreviewHashOf, validateSeriesBundle, hash12Of, BUNDLE_SCHEMA_VERSION } = require('./series-bundle-contract');

function detailKeyOf(value) {
  const text = String(value || '').trim();
  return text.startsWith('tool-level3:') ? text.slice('tool-level3:'.length) : text;
}

/**
 * 容量与历史转移计划：容量 visible_members，第 7 个起按 release_date 最旧转 hidden_history。
 * @param {object} policy schema v2 政策
 * @param {Array<{id: string}>} seriesList 目标系列定义（至少含 id）
 * @param {object} snapshot 五模块快照
 * @param {Date|string} [now]
 * @returns {{ ok: boolean, code?: string, transitions: Array, capacity: object }}
 */
function planHistoryTransitions(policy, seriesList, snapshot, now = new Date()) {
  const capacity = policy?.capacity || {};
  const visibleMembers = Number.isInteger(capacity.visible_members) ? capacity.visible_members : 6;
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const transitions = [];
  for (const series of seriesList || []) {
    const seriesId = typeof series === 'string' ? series : series?.id;
    if (!seriesId) continue;
    const l2 = (snapshot['vendor-level2'] || []).find(item => item.id === seriesId);
    if (!l2) continue;
    const l3ById = new Map((snapshot['tool-level3'] || []).map(detail => [detail.id, detail]));
    const visible = (l2.detail_refs || [])
      .map(ref => ref.id)
      .filter(id => {
        const detail = l3ById.get(id);
        return !detail || detail.visibility !== 'hidden_history';
      });
    const overflow = visible.length - visibleMembers;
    if (overflow <= 0) continue;
    const releaseOf = id => {
      const date = l3ById.get(id)?.release_date;
      const parsed = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
      return Number.isFinite(parsed) ? parsed : 0; // 缺日期视为最旧
    };
    const ordered = [...visible].sort((a, b) => releaseOf(a) - releaseOf(b) || String(a).localeCompare(String(b)));
    for (const id of ordered.slice(0, overflow)) {
      const detail = l3ById.get(id) || {};
      const card = (snapshot['tool-card'] || []).find(item => item.detail_ref?.id === id);
      transitions.push({
        series_id: seriesId,
        detail_id: id,
        tool_card_id: card ? card.id : null,
        model_key: detail.model_key || null,
        release_date: detail.release_date || null,
        historical_since: nowIso,
      });
    }
  }
  return { ok: true, transitions, capacity: { visible_members: visibleMembers, history_retention_months: capacity.history_retention_months ?? null } };
}

function memberReceipts(receipts, modelKeys) {
  return (receipts || []).filter(receipt => receipt && modelKeys.has(receipt.model_key));
}

/**
 * 规划 SeriesBundle（确定性重算）。
 * @param {object} input { candidate, verdict, subModelVerdicts, policy, snapshot, receipts?, bridgeRevision?, now? }
 * @returns {{ ok:true, bundle } | { ok:false, code, blockers }}
 */
function planSeriesBundle({ candidate, verdict, subModelVerdicts, policy, snapshot, receipts = [], bridgeRevision, now = new Date() }) {
  if (!candidate?.name || !verdict?.model_key || !policy || !snapshot) {
    return { ok: false, code: 'BUNDLE_INPUT_INVALID', blockers: ['BUNDLE_INPUT_INVALID'] };
  }
  if (verdict.entity_class !== 'series') {
    return { ok: false, code: 'BUNDLE_VERDICT_NOT_SERIES', blockers: ['BUNDLE_VERDICT_NOT_SERIES'] };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  // 1. 政策定位：目标系列/家族/代际全部由政策重算
  const placement = planSeriesPlacement(policy, snapshot, {
    name: verdict.series_title || candidate.name,
    detail_kind: 'api_model',
    vendor_key: verdict.vendor_key,
  }, null);
  if (placement.kind !== 'decision') {
    return { ok: false, code: `BUNDLE_PLACEMENT_${placement.kind.toUpperCase()}`, blockers: [placement.code || placement.reason || 'BUNDLE_PLACEMENT_NOT_DECIDED'] };
  }
  const vendorPolicy = policy.vendors.find(v => v.vendor_key === placement.vendor);
  const familyDef = vendorPolicy.families.find(f => f.family === placement.family);
  const target = (familyDef.series || []).find(s => s.id === placement.target_level2_id);
  const existingL2 = (snapshot['vendor-level2'] || []).find(l2 => l2.id === placement.target_level2_id);
  const l3ById = new Map((snapshot['tool-level3'] || []).map(detail => [detail.id, detail]));
  const cardByDetail = new Map((snapshot['tool-card'] || []).map(card => [card.detail_ref?.id, card]));
  const modelKeyIndex = catalogModelKeyIndex(snapshot);

  // 2. 成员分类（确定性）：已存在 → already_complete；核验通过的新成员 → bundled；其余 → deferred
  const members = [];
  const deferredModels = [];
  for (const sub of subModelVerdicts || []) {
    const name = String(sub?.name || '').trim();
    if (!name) continue;
    const modelKey = sub.model_key || null;
    const existing = modelKey ? modelKeyIndex.get(modelKey) : null;
    if (existing && existing.length) {
      const hit = existing.find(entry => entry.kind === 'tool-level3') || existing[0];
      members.push({
        name,
        model_key: modelKey,
        detail_id: hit.detail_id || hit.id,
        tool_card_id: cardByDetail.get(hit.detail_id || hit.id)?.id || hit.tool_card_id || null,
        classification: 'already_complete',
      });
      continue;
    }
    if (!modelKey) {
      deferredModels.push({ name, model_key: null, blocking_reasons: ['IDENTITY_MODEL_KEY_MISSING'] });
      members.push({ name, model_key: null, detail_id: null, tool_card_id: null, classification: 'deferred', blocking_reasons: ['IDENTITY_MODEL_KEY_MISSING'] });
      continue;
    }
    const identityKey = slugify(name, 'member_name');
    members.push({
      name,
      model_key: modelKey,
      detail_id: `tool-level3:${identityKey}`,
      tool_card_id: `tool-card:${identityKey}`,
      classification: 'bundled',
      evidence: sub.evidence || null,
    });
  }
  if (!members.length) {
    return { ok: false, code: 'BUNDLE_MEMBERS_EMPTY', blockers: ['BUNDLE_MEMBERS_EMPTY'] };
  }

  // 3. 容量与历史转移：可见超容量时，现有成员按 release_date 最旧转 hidden_history
  const existingVisibleRefs = (existingL2?.detail_refs || [])
    .map(ref => ref.id)
    .filter(id => (l3ById.get(id) || {}).visibility !== 'hidden_history');
  const newBundled = members.filter(member => member.classification === 'bundled');
  const capacityVisible = Number.isInteger(policy.capacity?.visible_members) ? policy.capacity.visible_members : 6;
  const history = planHistoryTransitions(policy, [target], snapshot, nowDate);
  const slotsLeft = capacityVisible - existingVisibleRefs.length - newBundled.length;
  const forcedTransitions = [];
  if (slotsLeft < 0) {
    // 新成员挤占容量：对“现有可见 + 新成员”整体重算转移（最旧优先，新成员视为最新不转历史）
    const overflow = -slotsLeft;
    const releaseOf = id => {
      const date = l3ById.get(id)?.release_date;
      const parsed = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const ordered = [...existingVisibleRefs].sort((a, b) => releaseOf(a) - releaseOf(b) || String(a).localeCompare(String(b)));
    for (const id of ordered.slice(0, overflow)) {
      const card = cardByDetail.get(id);
      forcedTransitions.push({
        series_id: target.id,
        detail_id: id,
        tool_card_id: card ? card.id : null,
        model_key: l3ById.get(id)?.model_key || null,
        release_date: l3ById.get(id)?.release_date || null,
        historical_since: nowDate.toISOString().slice(0, 10),
      });
    }
  }
  const transitions = [...history.transitions, ...forcedTransitions]
    .filter((item, index, list) => list.findIndex(other => other.detail_id === item.detail_id) === index);
  const transitionIds = new Set(transitions.map(item => item.detail_id));

  // 4. layer_patches
  const patches = [];
  const baseCatalogRevision = revisionOf(snapshot);
  const visibleDetailRefs = [];
  for (const id of existingVisibleRefs) {
    if (!transitionIds.has(id)) visibleDetailRefs.push({ kind: 'tool-level3', id });
  }
  for (const member of newBundled) {
    if (member.classification === 'bundled' && !transitionIds.has(member.detail_id)) {
      visibleDetailRefs.push({ kind: 'tool-level3', id: member.detail_id });
    }
  }
  const level2Record = existingL2
    ? { ...existingL2, title: target.title, detail_refs: visibleDetailRefs, series_kind: familyDef.series_kind, generation_state: target.generation_state }
    : buildLevel2({
      vendorKey: placement.vendor,
      level1Id: `vendor-level1:${placement.vendor}`,
      groupKey: placement.group_key,
      title: target.title,
      officialUrl: verdict.evidence?.official_url || '',
      summary: `官方核验系列：${verdict.reasons?.[0] || verdict.series_title || target.title}`,
      status: 'active',
      detailRefs: visibleDetailRefs,
      seriesKind: familyDef.series_kind,
      generationState: target.generation_state,
    });
  patches.push({ area: 'vendor-level2', id: level2Record.id, operation: existingL2 ? 'replace' : 'create', record: level2Record });

  if (placement.target_mode === 'create') {
    // 规则 1：新建 L2 ⇒ 父 L1 replace（level2_refs 追加新系列引用）
    const l1 = (snapshot['vendor-level1'] || []).find(item => item.id === `vendor-level1:${placement.vendor}`);
    const l1Record = l1
      ? { ...l1, level2_refs: [...(l1.level2_refs || []), { kind: 'vendor-level2', id: level2Record.id }] }
      : buildLevel1({ vendorKey: placement.vendor, title: placement.vendor, level2Refs: [{ kind: 'vendor-level2', id: level2Record.id }] });
    patches.push({ area: 'vendor-level1', id: l1Record.id, operation: 'replace', record: l1Record });
  }

  const bridgeEntries = [];
  for (const member of newBundled) {
    const existingDetail = l3ById.get(member.detail_id);
    const detailRecord = buildDetail({
      vendorKey: placement.vendor,
      detailKind: 'api_model',
      theme: 'general',
      title: member.name,
      vendorLabel: placement.vendor,
      officialUrl: member.evidence?.official_url || verdict.evidence?.official_url || '',
      status: 'active',
      summary: `官方核验收录：${verdict.reasons?.[0] || member.name}`,
      releaseDate: null,
      modelKey: member.model_key,
    });
    detailRecord.id = member.detail_id;
    patches.push({ area: 'tool-level3', id: member.detail_id, operation: existingDetail ? 'replace' : 'create', record: detailRecord });
    if (member.tool_card_id) {
      const existingCard = (snapshot['tool-card'] || []).find(card => card.id === member.tool_card_id);
      const cardRecord = buildToolCard({
        toolKey: member.tool_card_id.replace(/^tool-card:/, ''),
        vendorKey: placement.vendor,
        title: member.name,
        vendorLabel: placement.vendor,
        summary: `官方核验收录：${verdict.reasons?.[0] || member.name}`,
        theme: 'general',
        searchTerms: [member.name],
        detailId: detailKeyOf(member.detail_id),
        detailKind: 'api_model',
        modelKey: member.model_key,
      });
      cardRecord.detail_ref = { kind: 'tool-level3', id: member.detail_id };
      patches.push({ area: 'tool-card', id: cardRecord.id, operation: existingCard ? 'replace' : 'create', record: cardRecord });
    }
    bridgeEntries.push({
      model_key: member.model_key,
      title: member.name,
      vendor_key: placement.vendor,
      detail_id: member.detail_id,
      tool_card_id: member.tool_card_id,
      series_id: target.id,
      official_url: member.evidence?.official_url || verdict.evidence?.official_url || '',
      content_hash: member.evidence?.content_hash || verdict.evidence?.content_hash || '',
      verified_at: nowDate.toISOString(),
      catalog_revision: baseCatalogRevision,
    });
  }

  // 历史转移成员：L3/卡 replace（hidden_history + historical_since），绝不删除记录
  for (const transition of transitions) {
    const detail = l3ById.get(transition.detail_id);
    if (!detail) continue;
    patches.push({
      area: 'tool-level3',
      id: detail.id,
      operation: 'replace',
      record: { ...detail, visibility: 'hidden_history', historical_since: transition.historical_since },
    });
    const card = cardByDetail.get(transition.detail_id);
    if (card) {
      patches.push({
        area: 'tool-card',
        id: card.id,
        operation: 'replace',
        record: { ...card, visibility: 'hidden_history', historical_since: transition.historical_since },
      });
    }
  }

  const baseRevisions = {
    catalog: baseCatalogRevision,
    policy: revisionOf(policy),
    bridge: bridgeRevision ?? readModelIdentityBridge().revision,
  };
  const bundle = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    bundle_id: `bundle-${hash12Of({ vendor: placement.vendor, series_id: target.id, members: members.map(member => member.model_key || member.name) })}`,
    candidate: { candidate_key: candidate.candidate_key || null, name: candidate.name, entity_type: candidate.entity_type || 'series' },
    vendor_key: placement.vendor,
    series: {
      level2_id: target.id,
      title: target.title,
      series_kind: familyDef.series_kind,
      generation_state: target.generation_state,
      mode: existingL2 ? 'existing' : 'create',
    },
    members,
    base_revisions: baseRevisions,
    receipts: memberReceipts(receipts, new Set(members.map(member => member.model_key).filter(Boolean))),
    layer_patches: patches,
    bridge_entries: bridgeEntries,
    deferred_models: deferredModels,
    future_snapshot: null,
    cost: {
      search_queries: members.length + 1,
      pages: members.length + 1,
      responses_calls: members.length + 1,
      scope: 'verification_upper_bound',
    },
    blockers: [],
    readiness: 'blocked',
    preview_hash: bundlePreviewHashOf({ layer_patches: patches, bridge_entries: bridgeEntries }),
    bundle_token: null,
  };

  // 5. 确定性校验收口：八条覆盖规则 + planner 侧富化门禁
  const verdict4 = validateSeriesBundle(bundle, { snapshot, policy, bridgeRevision: baseRevisions.bridge });
  bundle.blockers = [...verdict4.blockers];
  if (!newBundled.length && !transitionIds.size && !deferredModels.length && verdict4.ok) {
    bundle.readiness = 'ready';
  } else if (verdict4.ok) {
    bundle.blockers = ['BUNDLE_MEMBERS_NEED_ENRICHMENT'];
    bundle.readiness = 'blocked';
  } else {
    bundle.readiness = 'blocked';
  }
  bundle.bundle_token = bundleTokenOf(bundle);
  return { ok: true, bundle };
}

module.exports = { planSeriesBundle, planHistoryTransitions };
