'use strict';

/**
 * series-bundle-contract.js —— SeriesBundle 原子性契约（校验侧）
 *
 * 一个系列 = 一个 Bundle Draft = 一次 commitCatalogChange。本模块只做
 * 确定性校验（零网络零 AI）：Bundle manifest 的结构合法性 + Patch 覆盖集
 * 八条规则 + base_revisions 漂移拒绝 + 删除禁止。任一 blocker → 整包拒绝写入。
 *
 * Patch 覆盖集八条规则（T1 契约冻结）：
 *   1 新建 L2 ⇒ 父 L1 replace patch；
 *   2 L2 detail_refs 覆盖全部可见（bundled 且非 hidden_history）成员；
 *   3 每个 bundled 成员有 tool-level3 patch；
 *   4 每个非 subscription 系列成员有 tool-card patch，卡与 L3 的 model_key/visibility 一致；
 *   5 hidden_history 成员：L2 replace 移出 + L3/卡 replace（visibility=hidden_history 且带 historical_since）；
 *   6 每个新/更新 api_model 有 bridge entry；
 *   7 base_revisions 漂移 ⇒ 拒绝；
 *   8 不允许 noop 外的删除（layer_patches 禁止 remove 操作）。
 */

const crypto = require('crypto');
const { revisionOf, stableValue, previewHashOf } = require('../core/catalog-revision');
const { validateModelIdentityBridgeEntries } = require('../../shared/model-identity-bridge');

const MEMBER_CLASSIFICATIONS = Object.freeze(['already_complete', 'bundled', 'deferred']);
const BUNDLE_SCHEMA_VERSION = 1;
const ALLOWED_PATCH_OPERATIONS = Object.freeze(['create', 'replace', 'noop']);

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hash12Of(basis) {
  return crypto.createHash('sha256').update(Buffer.from(stableStringify(basis), 'utf8')).digest('hex').slice(0, 12);
}

function bundlePreviewHashOf(bundleOrPatches, bridgeEntries) {
  const bundle = bundleOrPatches && typeof bundleOrPatches === 'object' && !Array.isArray(bundleOrPatches)
    ? bundleOrPatches
    : { layer_patches: bundleOrPatches, bridge_entries: bridgeEntries };
  return previewHashOf({
    layer_patches: bundle.layer_patches || [],
    bridge_entries: bundle.bridge_entries || [],
  });
}

function catalogRecordId(kind, value) {
  return typeof value === 'string' && value.startsWith(`${kind}:`) && value.length > kind.length + 1;
}

/** Bundle token covers complete patch records and bridge entries, not only their IDs. */
function bundleTokenOf(bundle) {
  const basis = {
    bundle_id: bundle?.bundle_id,
    base_revisions: bundle?.base_revisions,
    preview_hash: bundle?.preview_hash,
    series: bundle?.series,
    members: bundle?.members,
    layer_patches: bundle?.layer_patches,
    bridge_entries: bundle?.bridge_entries,
  };
  return `btk-${crypto.createHash('sha256').update(Buffer.from(stableStringify(basis), 'utf8')).digest('hex').slice(0, 16)}`;
}

/** bundle_id 形状：bundle-<hash12>。 */
function isBundleId(value) {
  return typeof value === 'string' && /^bundle-[0-9a-f]{12}$/.test(value);
}

function memberVisible(member) {
  return member.classification === 'bundled' && member.visibility !== 'hidden_history';
}

/**
 * 校验 SeriesBundle（确定性，零网络零 AI）。
 * @param {object} bundle Bundle manifest（planner 产物 / 持久化 Draft）
 * @param {object} gates { snapshot, policy, bridgeRevision? }
 * @returns {{ ok: boolean, blockers: string[], readiness: 'ready'|'blocked' }}
 */
function validateSeriesBundle(bundle, gates = {}) {
  const blockers = [];
  const add = code => blockers.push(code);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { ok: false, blockers: ['BUNDLE_SCHEMA_INVALID'], readiness: 'blocked' };
  }
  if (bundle.schema_version !== BUNDLE_SCHEMA_VERSION) add('BUNDLE_SCHEMA_INVALID');
  if (!isBundleId(bundle.bundle_id)) add('BUNDLE_ID_INVALID');
  if (!bundle.candidate || typeof bundle.candidate.name !== 'string' || !bundle.candidate.name.trim()) add('BUNDLE_CANDIDATE_INVALID');
  if (typeof bundle.vendor_key !== 'string' || !bundle.vendor_key) add('BUNDLE_VENDOR_INVALID');
  const series = bundle.series;
  if (!series || typeof series.level2_id !== 'string' || !series.level2_id
    || typeof series.title !== 'string' || !series.title
    || !['create', 'existing', 'noop'].includes(series.mode)) {
    add('BUNDLE_SERIES_INVALID');
  }
  if (!Array.isArray(bundle.members) || !bundle.members.length) add('BUNDLE_MEMBERS_EMPTY');
  for (const member of bundle.members || []) {
    if (!MEMBER_CLASSIFICATIONS.includes(member?.classification)) add('BUNDLE_MEMBER_CLASSIFICATION_INVALID');
    if (member?.classification !== 'deferred') {
      if (!catalogRecordId('tool-level3', member?.detail_id)) add('BUNDLE_DETAIL_ID_INVALID');
      if (bundle.series?.series_kind !== 'subscription_series' && !catalogRecordId('tool-card', member?.tool_card_id)) add('BUNDLE_TOOL_CARD_ID_INVALID');
    }
  }
  if (bundle.series && !catalogRecordId('vendor-level2', bundle.series.level2_id)) add('BUNDLE_SERIES_ID_INVALID');
  if (!Array.isArray(bundle.layer_patches)) add('BUNDLE_PATCHES_INVALID');
  if (!Array.isArray(bundle.bridge_entries)) add('BUNDLE_BRIDGE_ENTRIES_INVALID');
  if (!bundle.base_revisions || typeof bundle.base_revisions.catalog !== 'string') add('BUNDLE_BASE_REVISIONS_INVALID');
  if (blockers.length) return { ok: false, blockers, readiness: 'blocked' };

  const patches = bundle.layer_patches;
  for (const entry of bundle.bridge_entries || []) {
    if (!catalogRecordId('tool-level3', entry?.detail_id)
      || !catalogRecordId('tool-card', entry?.tool_card_id)
      || !catalogRecordId('vendor-level2', entry?.series_id)) add('BUNDLE_BRIDGE_ENTRY_INVALID');
  }
  // 规则 8：不允许 noop 外的删除
  if (patches.some(patch => patch.operation === 'remove')) add('BUNDLE_DELETE_FORBIDDEN');
  for (const patch of patches) {
    if (!ALLOWED_PATCH_OPERATIONS.includes(patch.operation)) add('BUNDLE_PATCH_OPERATION_INVALID');
  }

  const l3PatchById = new Map(patches.filter(patch => patch.area === 'tool-level3').map(patch => [patch.id, patch]));
  const cardPatchById = new Map(patches.filter(patch => patch.area === 'tool-card').map(patch => [patch.id, patch]));
  for (const patch of patches) {
    if (patch.area === 'tool-level3' && !catalogRecordId('tool-level3', patch.id)) add('BUNDLE_DETAIL_ID_INVALID');
    if (patch.area === 'tool-card' && !catalogRecordId('tool-card', patch.id)) add('BUNDLE_TOOL_CARD_ID_INVALID');
  }
  const l2Patch = patches.find(patch => patch.area === 'vendor-level2' && patch.id === series.level2_id && patch.operation !== 'noop');

  // 规则 1：新建 L2 ⇒ 父 L1 replace patch
  if (series.mode === 'create') {
    const l1Patch = patches.find(patch => patch.area === 'vendor-level1' && patch.operation === 'replace'
      && patch.record?.id === `vendor-level1:${bundle.vendor_key}`);
    if (!l1Patch) add('BUNDLE_L1_PATCH_MISSING');
  }

  const bundledMembers = bundle.members.filter(member => member.classification === 'bundled');
  const visibleMembers = bundle.members.filter(memberVisible);

  if (series.mode !== 'noop') {
    // 规则 2：L2 detail_refs 覆盖全部可见成员
    if (!l2Patch) {
      add('BUNDLE_L2_PATCH_MISSING');
    } else {
      const refIds = new Set((l2Patch.record?.detail_refs || []).map(ref => ref.id));
      for (const member of visibleMembers) {
        if (member.detail_id && !refIds.has(member.detail_id)) {
          add('BUNDLE_L2_MEMBERS_INCOMPLETE');
          break;
        }
      }
    }
  }

  // 规则 3/4/5/6：逐成员覆盖
  const bridgeByModelKey = new Map((bundle.bridge_entries || []).map(entry => [entry.model_key, entry]));
  for (const member of bundledMembers) {
    const detailId = member.detail_id;
    const l3Patch = l3PatchById.get(detailId);
    // 规则 3：bundled 成员必须有 L3 patch
    if (!l3Patch || l3Patch.operation === 'noop') {
      add('BUNDLE_L3_PATCH_MISSING');
      continue;
    }
    const l3Record = l3Patch.record || {};
    const cardPatch = member.tool_card_id ? cardPatchById.get(member.tool_card_id) : null;
    if (series.series_kind !== 'subscription_series') {
      // 规则 4：非 subscription 成员必须有卡 patch，且 model_key/visibility 与 L3 一致
      if (!cardPatch || cardPatch.operation === 'noop') add('BUNDLE_CARD_PATCH_MISSING');
      else {
        if ((cardPatch.record?.model_key || null) !== (l3Record.model_key || null)) add('BUNDLE_CARD_MODEL_KEY_MISMATCH');
        if ((cardPatch.record?.visibility || 'visible') !== (l3Record.visibility || 'visible')) add('BUNDLE_CARD_VISIBILITY_MISMATCH');
      }
    }
    // 规则 5：hidden_history 成员不得留在 L2 detail_refs，且 L3/卡必须 replace 携带 historical_since
    if (l3Record.visibility === 'hidden_history') {
      if (l2Patch && (l2Patch.record?.detail_refs || []).some(ref => ref.id === detailId)) add('BUNDLE_HISTORY_STILL_IN_L2');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l3Record.historical_since || ''))) add('BUNDLE_HISTORY_DATE_REQUIRED');
      if (cardPatch && cardPatch.record && cardPatch.record.visibility !== 'hidden_history') add('BUNDLE_CARD_VISIBILITY_MISMATCH');
    }
    // 规则 6：每个新/更新 api_model 必须有 bridge entry（形状合法）
    if (l3Record.detail_kind === 'api_model' || member.model_key) {
      const entry = bridgeByModelKey.get(member.model_key);
      if (!entry) add('BUNDLE_BRIDGE_ENTRY_MISSING');
      else if (!catalogRecordId('tool-level3', entry.detail_id)
        || !catalogRecordId('tool-card', entry.tool_card_id)
        || !catalogRecordId('vendor-level2', entry.series_id)
        || entry.series_id !== series.level2_id) add('BUNDLE_BRIDGE_ENTRY_INVALID');
      else if (validateModelIdentityBridgeEntries([entry]).length) add('BUNDLE_BRIDGE_ENTRY_INVALID');
      else if (entry.detail_id !== detailId || entry.tool_card_id !== member.tool_card_id
        || entry.model_key !== l3Record.model_key || entry.model_key !== cardPatch?.record?.model_key
        || entry.title !== l3Record.title || entry.title !== cardPatch?.record?.title
        || l3Record.id !== detailId || l3Record.detail_kind !== cardPatch?.record?.detail_kind
        || cardPatch?.record?.detail_ref?.id !== detailId
        || entry.vendor_key !== l3Record.vendor_key || entry.vendor_key !== cardPatch?.record?.vendor_key
        || entry.vendor_key !== l2Patch?.record?.vendor_key
        || !l3Record.official_url || entry.official_url !== l3Record.official_url
        || (cardPatch?.record?.official_url !== undefined && cardPatch.record.official_url !== l3Record.official_url)) {
        add('BUNDLE_BRIDGE_PROJECTION_MISMATCH');
      }
    }
  }

  // 规则 7：base_revisions 漂移拒绝
  const drift = [];
  if (gates.snapshot && bundle.base_revisions.catalog !== revisionOf(gates.snapshot)) drift.push('catalog');
  if (gates.policy && bundle.base_revisions.policy !== revisionOf(gates.policy)) drift.push('policy');
  if (gates.bridgeRevision !== undefined && bundle.base_revisions.bridge !== gates.bridgeRevision) drift.push('bridge');
  if (drift.length) add(`BUNDLE_BASE_REVISION_DRIFT:${drift.join(',')}`);

  if (Array.isArray(bundle.blockers) && bundle.blockers.includes('BUNDLE_MEMBERS_NEED_ENRICHMENT')) {
    add('BUNDLE_MEMBERS_NEED_ENRICHMENT');
  }
  return { ok: blockers.length === 0, blockers, readiness: blockers.length === 0 ? 'ready' : 'blocked' };
}

module.exports = {
  MEMBER_CLASSIFICATIONS,
  BUNDLE_SCHEMA_VERSION,
  bundleTokenOf,
  bundlePreviewHashOf,
  catalogRecordId,
  validateSeriesBundle,
  isBundleId,
  hash12Of,
};
