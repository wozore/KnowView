'use strict';

const crypto = require('crypto');
const { isModelKey, normalizeModelIdentity, parseModelKey, findModelKeyCollisions } = require('../../shared/model-key-contract');

/**
 * series-data-audit.js — 目录系列/模型键数据纯只读审计
 *
 * 对五模块快照做系列反哺健康检查：非法/重复/疑似点号丢失的 model_key、同名不同键、
 * 悬空引用、已知污染卡、厂商别名冲突、跨实体复制、系列可见成员超容、hidden_history
 * 残留引用与桥接失配。零写入、零网络、零真实 policy/文件读取——scenes/featured/
 * pendingTools/drafts/policy/bridge/catalogReleaseDates/comparisonInputs 全部纯对象注入
 * （comparison 侧数据仅以 comparisonInputs 纯对象进入，本模块零 comparison require）。
 * 每条 finding 给出建议动作（AUDIT_ACTIONS），交维护者/T3 管线裁决；本模块不改数据。
 */

const AUDIT_ACTIONS = Object.freeze(['remove_pollution', 'merge_entities', 'reverify', 'move_to_history', 'needs_manual']);

const AUDIT_FINDING_CODES = Object.freeze([
  'INVALID_MODEL_KEY',
  'DUPLICATE_MODEL_KEY',
  'SAME_NAME_DIFFERENT_KEY',
  'KEY_ENTITY_MISMATCH',
  'DANGLING_REF',
  'KNOWN_POLLUTED_CARD',
  'VENDOR_ALIAS_CONFLICT',
  'CROSS_ENTITY_COPY',
  'VISIBLE_MEMBERS_OVER_CAPACITY',
  'HISTORY_STILL_REFERENCED',
  'BRIDGE_MISMATCH',
  'LEGACY_DOT_LOSS_KEY',
]);

const FINDING_ACTION_BY_CODE = Object.freeze({
  INVALID_MODEL_KEY: 'remove_pollution',
  DUPLICATE_MODEL_KEY: 'merge_entities',
  SAME_NAME_DIFFERENT_KEY: 'merge_entities',
  KEY_ENTITY_MISMATCH: 'needs_manual',
  DANGLING_REF: 'remove_pollution',
  KNOWN_POLLUTED_CARD: 'remove_pollution',
  VENDOR_ALIAS_CONFLICT: 'needs_manual',
  CROSS_ENTITY_COPY: 'needs_manual',
  VISIBLE_MEMBERS_OVER_CAPACITY: 'move_to_history',
  HISTORY_STILL_REFERENCED: 'remove_pollution',
  BRIDGE_MISMATCH: 'reverify',
  LEGACY_DOT_LOSS_KEY: 'reverify',
});

function areaItems(snapshot, area) {
  const value = snapshot && snapshot[area];
  return Array.isArray(value) ? value : [];
}

function summaryFingerprint(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text ?? '')).digest('hex')}`;
}

function normalizeTitle(title) {
  try {
    return normalizeModelIdentity(title);
  } catch {
    return '';
  }
}

function referencedToolKeysOf(scenes, featured) {
  const refs = [];
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const task of scene?.tasks || []) {
      for (const toolKey of task?.tools || []) refs.push({ kind: 'scene_tool', value: toolKey, source: scene?.name || 'scene' });
      for (const recommendation of task?.recommendations || []) {
        if (recommendation?.tool_id) refs.push({ kind: 'scene_tool', value: recommendation.tool_id, source: scene?.name || 'scene' });
        if (recommendation?.detail_ref) refs.push({ kind: 'detail', value: recommendation.detail_ref, source: scene?.name || 'scene' });
      }
    }
  }
  for (const pick of Array.isArray(featured) ? featured : []) {
    if (pick?.tool_id) refs.push({ kind: 'scene_tool', value: pick.tool_id, source: 'featured' });
    if (pick?.detail_ref) refs.push({ kind: 'detail', value: pick.detail_ref, source: 'featured' });
  }
  return refs;
}

function collectFindings(input, level2, level3, cards, vendorKeys) {
  const findings = [];
  const add = (code, area, id, message) => findings.push({ code, action: FINDING_ACTION_BY_CODE[code], area, id, message });
  const policy = input.policy || {};
  const comparisonInputs = input.comparisonInputs || {};
  const level3ById = new Map(level3.map(item => [item?.id, item]));
  const toolKeys = new Set(cards.map(item => item?.tool_key).filter(Boolean));
  const detailIds = new Set(level3.map(item => item?.id).filter(Boolean));
  const defaultCapacity = policy?.capacity?.split_when_member_count_exceeds;

  for (const item of level3) {
    if (item?.model_key != null && !isModelKey(String(item.model_key))) {
      add('INVALID_MODEL_KEY', 'tool-level3', item.id, `非法 model_key 语法: ${item.model_key}`);
    }
    const parsed = item?.model_key != null ? parseModelKey(String(item.model_key), vendorKeys) : null;
    if (parsed && parsed.vendor_key !== item.vendor_key) {
      add('KEY_ENTITY_MISMATCH', 'tool-level3', item.id, `model_key 厂商前缀 ${parsed.vendor_key} 与记录 vendor_key ${item.vendor_key} 不一致`);
    }
    const identity = normalizeTitle(item?.title);
    if (identity && identity.includes('.')) {
      const lossy = identity.replace(/\./g, '-');
      const key = typeof item.model_key === 'string' ? item.model_key : '';
      if ((parsed && key === `${parsed.vendor_key}-${lossy}`) || (item.tool_key && item.tool_key === lossy)) {
        add('LEGACY_DOT_LOSS_KEY', 'tool-level3', item.id, `疑似旧 slugify 点号丢失: 期望 ${item.vendor_key}-${identity}`);
      }
    }
  }

  for (const collision of findModelKeyCollisions(level3)) {
    add('DUPLICATE_MODEL_KEY', 'tool-level3', collision.model_key, `model_key 跨实体重复: ${collision.members.join(', ')}`);
  }

  const level3ByTitle = new Map();
  for (const item of level3) {
    const title = normalizeTitle(item?.title);
    if (title) {
      if (!level3ByTitle.has(title)) level3ByTitle.set(title, []);
      level3ByTitle.get(title).push(item);
    }
  }
  for (const group of level2) {
    const sameName = level3ByTitle.get(normalizeTitle(group?.title)) || [];
    for (const member of sameName) {
      if (member.vendor_key !== group.vendor_key) continue;
      add('SAME_NAME_DIFFERENT_KEY', 'vendor-level2', group.id, `二级系列与三级模型同名不同键: ${group.id} ↔ ${member.id}`);
    }
  }

  const hiddenIds = new Set(level3.filter(item => item?.visibility === 'hidden_history').map(item => item.id));
  for (const group of level2) {
    const refs = Array.isArray(group?.detail_refs) ? group.detail_refs : [];
    for (const detailRef of refs) {
      if (hiddenIds.has(detailRef?.id)) add('HISTORY_STILL_REFERENCED', 'vendor-level2', group.id, `hidden_history 详情仍被引用: ${detailRef.id}`);
    }
    const visibleMembers = refs.filter(detailRef => {
      const detail = level3ById.get(detailRef?.id);
      return detail && detail.visibility !== 'hidden_history';
    });
    if (defaultCapacity != null && visibleMembers.length > defaultCapacity) {
      add('VISIBLE_MEMBERS_OVER_CAPACITY', 'vendor-level2', group.id, `可见成员 ${visibleMembers.length} 超过政策容量 ${defaultCapacity}`);
    }
  }

  const aliases = policy?.vendor_aliases && typeof policy.vendor_aliases === 'object' ? policy.vendor_aliases : {};
  for (const [key, val] of Object.entries(aliases)) {
    if (Array.isArray(val)) {
      const canonical = key;
      for (const alias of val) {
        if (alias === canonical) continue;
        const conflicting = [...level2, ...level3].filter(item => item?.vendor_key === alias);
        for (const item of conflicting) {
          add('VENDOR_ALIAS_CONFLICT', item.id.startsWith('vendor-level2:') ? 'vendor-level2' : 'tool-level3', item.id, `vendor_key 使用别名 ${alias}，政策 canonical 为 ${canonical}`);
        }
      }
    } else if (typeof val === 'string') {
      const alias = key;
      const canonical = val;
      if (alias === canonical) continue;
      const conflicting = [...level2, ...level3].filter(item => item?.vendor_key === alias);
      for (const item of conflicting) {
        add('VENDOR_ALIAS_CONFLICT', item.id.startsWith('vendor-level2:') ? 'vendor-level2' : 'tool-level3', item.id, `vendor_key 使用别名 ${alias}，政策 canonical 为 ${canonical}`);
      }
    }
  }

  const summaryGroups = new Map();
  for (const item of level3) {
    const summary = typeof item?.summary === 'string' && item.summary.trim() ? item.summary : null;
    if (!summary) continue;
    const fingerprint = summaryFingerprint(summary);
    if (!summaryGroups.has(fingerprint)) summaryGroups.set(fingerprint, []);
    summaryGroups.get(fingerprint).push(item);
  }
  for (const group of summaryGroups.values()) {
    if (group.length > 1) add('CROSS_ENTITY_COPY', 'tool-level3', group[0].id, `多个实体共享同一 summary 疑似跨实体复制: ${group.map(item => item.id).join(', ')}`);
  }
  for (const foreign of Array.isArray(comparisonInputs.entity_summaries) ? comparisonInputs.entity_summaries : []) {
    const local = level3.find(item => summaryFingerprint(item?.summary) === foreign?.summary_hash && item?.model_key !== foreign?.model_key);
    if (local) add('CROSS_ENTITY_COPY', 'tool-level3', local.id, `summary 与 comparison 实体 ${foreign.model_key} 指纹相同`);
  }

  const pollutedIds = Array.isArray(comparisonInputs.known_polluted_card_ids) ? comparisonInputs.known_polluted_card_ids : [];
  for (const card of cards) {
    if (pollutedIds.includes(card?.id)) add('KNOWN_POLLUTED_CARD', 'tool-card', card.id, '命中已知污染卡名单');
  }

  const pendingSeeds = [...(Array.isArray(input.pendingTools) ? input.pendingTools : []), ...(Array.isArray(input.drafts) ? input.drafts : [])];
  for (const seed of pendingSeeds) {
    const modelKey = seed?.model_key ?? seed?.seed?.model_key;
    if (modelKey != null && !isModelKey(String(modelKey))) {
      add('INVALID_MODEL_KEY', 'pending', seed.tool_key || seed.id || seed.draft_id || 'unknown', `待补/草稿 model_key 非法: ${modelKey}`);
    }
    const name = normalizeTitle(seed?.name ?? seed?.seed?.name);
    const seedToolKey = seed?.tool_key ?? seed?.seed?.tool_key;
    const clash = name ? (level3ByTitle.get(name) || []).find(item => item.tool_key !== seedToolKey) : null;
    if (clash && seedToolKey && !toolKeys.has(seedToolKey)) {
      add('SAME_NAME_DIFFERENT_KEY', 'pending', seedToolKey, `待补/草稿与既有实体同名不同键: ${clash.id}`);
    }
  }

  for (const ref of referencedToolKeysOf(input.scenes, input.featured)) {
    const missing = ref.kind === 'scene_tool' ? !toolKeys.has(ref.value) : !detailIds.has(ref.value);
    if (missing) add('DANGLING_REF', ref.kind === 'scene_tool' ? 'tool-card' : 'tool-level3', ref.value, `场景/精选引用不存在: ${ref.value} (${ref.source})`);
  }

  const releaseEntries = Array.isArray(input.catalogReleaseDates?.entries) ? input.catalogReleaseDates.entries : [];
  for (const entry of releaseEntries) {
    if (entry?.detail_id && !detailIds.has(entry.detail_id)) {
      add('DANGLING_REF', 'tool-level3', entry.detail_id, `release_date 投影引用不存在: ${entry.detail_id}`);
    }
  }

  const bridgeEntries = Array.isArray(input.bridge?.entries) ? input.bridge.entries : [];
  for (const entry of bridgeEntries) {
    const detail = detailIds.has(entry?.detail_id) ? level3ById.get(entry.detail_id) : null;
    if (!detail) {
      add('BRIDGE_MISMATCH', 'tool-level3', entry?.detail_id || 'unknown', `桥接条目指向不存在的三级详情: ${entry?.detail_id}`);
      continue;
    }
    if (entry.model_key && detail.model_key && entry.model_key !== detail.model_key) {
      add('BRIDGE_MISMATCH', 'tool-level3', entry.detail_id, `桥接 model_key ${entry.model_key} 与快照 ${detail.model_key} 不一致`);
    }
    if (entry.catalog_revision && input.snapshot?.revision && entry.catalog_revision !== input.snapshot.revision) {
      add('BRIDGE_MISMATCH', 'tool-level3', entry.detail_id, '桥接 catalog_revision 落后于当前快照，建议重新核验');
    }
  }

  return findings;
}

/**
 * 纯只读审计入口：所有输入为注入对象，不读文件、不发网络、不修改任何输入。
 * @returns {{ok: boolean, findings: Array, counts: Record<string, number>}}
 */
function auditCatalogSeriesData(input = {}) {
  const snapshot = input.snapshot || {};
  const level2 = areaItems(snapshot, 'vendor-level2').filter(item => item && typeof item === 'object');
  const level3 = areaItems(snapshot, 'tool-level3').filter(item => item && typeof item === 'object');
  const cards = areaItems(snapshot, 'tool-card').filter(item => item && typeof item === 'object');
  const vendorKeys = Array.from(new Set([...level2, ...level3, ...cards].map(item => item?.vendor_key).filter(Boolean)));
  const findings = collectFindings(input, level2, level3, cards, vendorKeys);
  const counts = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] || 0) + 1;
  return { ok: findings.length === 0, findings, counts };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_FINDING_CODES,
  FINDING_ACTION_BY_CODE,
  summaryFingerprint,
  auditCatalogSeriesData,
};
