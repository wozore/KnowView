'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIT_ACTIONS,
  AUDIT_FINDING_CODES,
  FINDING_ACTION_BY_CODE,
  summaryFingerprint,
  auditCatalogSeriesData,
} = require('../../src/catalog/series/series-data-audit');

function level2(overrides = {}) {
  return {
    id: 'vendor-level2:openai:gpt',
    level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:openai' },
    vendor_key: 'openai',
    title: 'GPT',
    summary: 'GPT 系列。',
    status: 'active',
    series_kind: 'model_series',
    detail_refs: [],
    ...overrides,
  };
}

function level3(overrides = {}) {
  return {
    id: 'tool-level3:gpt-5-6-sol',
    vendor_key: 'openai',
    detail_kind: 'api_model',
    theme: 'general',
    title: 'GPT-5.6 Sol',
    vendor_label: 'OpenAI',
    icon: '🧩',
    official_url: 'https://openai.com',
    status: 'active',
    summary: '旗舰推理模型。',
    one_m_context: null,
    api_pricing: null,
    plan: null,
    applicable_scenarios: [],
    inapplicable_scenarios: [],
    sources: [],
    model_key: 'openai-gpt-5.6-sol',
    ...overrides,
  };
}

function card(overrides = {}) {
  return {
    id: 'tool-card:gpt-5-6-sol',
    tool_key: 'gpt-5-6-sol',
    vendor_key: 'openai',
    title: 'GPT-5.6 Sol',
    vendor_label: 'OpenAI',
    icon: '🧩',
    summary: '旗舰推理模型。',
    theme: 'general',
    scenes: [],
    best_for_preview: '',
    not_for_preview: '',
    price_badge: 'unknown',
    access_level: '未知',
    search_terms: [],
    detail_ref: { kind: 'tool-level3', id: 'tool-level3:gpt-5-6-sol' },
    detail_kind: 'api_model',
    model_key: 'openai-gpt-5.6-sol',
    ...overrides,
  };
}

function snapshotWith({ level2s = [], level3s = [], cards = [] }) {
  return { 'vendor-card': [], 'tool-card': cards, 'vendor-level1': [], 'vendor-level2': level2s, 'tool-level3': level3s };
}

function codesOf(result) {
  return result.findings.map(finding => finding.code);
}

test('action 枚举与 finding code 枚举按契约冻结', () => {
  assert.deepEqual([...AUDIT_ACTIONS], ['remove_pollution', 'merge_entities', 'reverify', 'move_to_history', 'needs_manual']);
  assert.deepEqual([...AUDIT_FINDING_CODES], [
    'INVALID_MODEL_KEY', 'DUPLICATE_MODEL_KEY', 'SAME_NAME_DIFFERENT_KEY', 'KEY_ENTITY_MISMATCH',
    'DANGLING_REF', 'KNOWN_POLLUTED_CARD', 'VENDOR_ALIAS_CONFLICT', 'CROSS_ENTITY_COPY',
    'VISIBLE_MEMBERS_OVER_CAPACITY', 'HISTORY_STILL_REFERENCED', 'BRIDGE_MISMATCH', 'LEGACY_DOT_LOSS_KEY',
  ]);
  assert.deepEqual(Object.keys(FINDING_ACTION_BY_CODE).sort(), [...AUDIT_FINDING_CODES].sort());
  for (const action of Object.values(FINDING_ACTION_BY_CODE)) assert.ok(AUDIT_ACTIONS.includes(action));
});

test('干净快照零 finding 且 ok', () => {
  const snapshot = snapshotWith({
    level2s: [level2({ detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:gpt-5-6-sol' }] })],
    level3s: [level3()],
    cards: [card()],
  });
  const result = auditCatalogSeriesData({ snapshot });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.counts, {});
});

test('非法与重复 model_key 以及厂商前缀失配', () => {
  const snapshot = snapshotWith({
    level3s: [
      level3({ id: 'tool-level3:a', model_key: 'OpenAI GPT' }),
      level3({ id: 'tool-level3:b', model_key: 'zhipu-glm-5', vendor_key: 'openai', title: 'GLM-5' }),
      level3({ id: 'tool-level3:zhipu-base', model_key: 'zhipu-glm-4', vendor_key: 'zhipu', title: 'GLM-4' }),
      level3({ id: 'tool-level3:c', model_key: 'openai-gpt-5.6-sol' }),
      level3({ id: 'tool-level3:d', model_key: 'openai-gpt-5.6-sol' }),
      level3({ id: 'tool-level3:e', model_key: null, title: '无键模型' }),
    ],
  });
  const result = auditCatalogSeriesData({ snapshot });
  assert.ok(codesOf(result).includes('INVALID_MODEL_KEY'));
  assert.ok(codesOf(result).includes('KEY_ENTITY_MISMATCH'));
  assert.ok(codesOf(result).includes('DUPLICATE_MODEL_KEY'));
  const duplicate = result.findings.find(finding => finding.code === 'DUPLICATE_MODEL_KEY');
  assert.equal(duplicate.action, 'merge_entities');
  assert.match(duplicate.message, /tool-level3:c, tool-level3:d/);
});

test('同名不同键与 legacy 点号丢失', () => {
  const snapshot = snapshotWith({
    level2s: [level2({ id: 'vendor-level2:openai:gpt-5-6-sol', title: 'GPT-5.6 Sol' })],
    level3s: [level3(), level3({ id: 'tool-level3:legacy', title: 'GPT 5.6', model_key: 'openai-gpt-5-6', tool_key: 'gpt-5-6' })],
  });
  const result = auditCatalogSeriesData({ snapshot });
  assert.ok(codesOf(result).includes('SAME_NAME_DIFFERENT_KEY'));
  assert.ok(codesOf(result).includes('LEGACY_DOT_LOSS_KEY'));
  const legacy = result.findings.find(finding => finding.code === 'LEGACY_DOT_LOSS_KEY');
  assert.equal(legacy.action, 'reverify');
  assert.match(legacy.message, /openai-gpt-5\.6/);
});

test('hidden_history 残留引用与可见成员超容', () => {
  const snapshot = snapshotWith({
    level2s: [level2({
      detail_refs: [
        { kind: 'tool-level3', id: 'tool-level3:visible-a' },
        { kind: 'tool-level3', id: 'tool-level3:visible-b' },
        { kind: 'tool-level3', id: 'tool-level3:visible-c' },
        { kind: 'tool-level3', id: 'tool-level3:visible-d' },
        { kind: 'tool-level3', id: 'tool-level3:hidden' },
      ],
    })],
    level3s: [
      level3({ id: 'tool-level3:visible-a', model_key: 'openai-a', tool_key: 'a' }),
      level3({ id: 'tool-level3:visible-b', model_key: 'openai-b', tool_key: 'b' }),
      level3({ id: 'tool-level3:visible-c', model_key: 'openai-c', tool_key: 'c' }),
      level3({ id: 'tool-level3:visible-d', model_key: 'openai-d', tool_key: 'd' }),
      level3({ id: 'tool-level3:hidden', model_key: 'openai-h', tool_key: 'h', visibility: 'hidden_history', historical_since: '2026-01-01' }),
    ],
  });
  const result = auditCatalogSeriesData({ snapshot, policy: { capacity: { split_when_member_count_exceeds: 3 } } });
  assert.ok(codesOf(result).includes('HISTORY_STILL_REFERENCED'));
  assert.ok(codesOf(result).includes('VISIBLE_MEMBERS_OVER_CAPACITY'));
  const over = result.findings.find(finding => finding.code === 'VISIBLE_MEMBERS_OVER_CAPACITY');
  assert.equal(over.action, 'move_to_history');
});

test('vendor 别名冲突、跨实体复制、已知污染卡', () => {
  const snapshot = snapshotWith({
    level2s: [level2({ vendor_key: 'openai_corp' })],
    level3s: [
      level3({ id: 'tool-level3:x', summary: '完全相同的总结。' }),
      level3({ id: 'tool-level3:y', summary: '完全相同的总结。', model_key: 'openai-y' }),
    ],
    cards: [card({ id: 'tool-card:polluted' })],
  });
  const result = auditCatalogSeriesData({
    snapshot,
    policy: { vendor_aliases: { openai_corp: 'openai' } },
    comparisonInputs: {
      known_polluted_card_ids: ['tool-card:polluted'],
      entity_summaries: [{ model_key: 'other-vendor-foreign', summary_hash: summaryFingerprint('完全相同的总结。') }],
    },
  });
  assert.ok(codesOf(result).includes('VENDOR_ALIAS_CONFLICT'));
  assert.ok(codesOf(result).includes('CROSS_ENTITY_COPY'));
  assert.ok(codesOf(result).includes('KNOWN_POLLUTED_CARD'));
  assert.equal(result.findings.find(finding => finding.code === 'VENDOR_ALIAS_CONFLICT').action, 'needs_manual');
});

test('场景/精选/投影悬空引用', () => {
  const snapshot = snapshotWith({ level3s: [level3()], cards: [card()] });
  const result = auditCatalogSeriesData({
    snapshot,
    scenes: [{ name: '写作', tasks: [{ tools: ['missing-tool'], recommendations: [{ tool_id: card().tool_key, detail_ref: 'tool-level3:missing-detail' }] }] }],
    featured: [{ tool_id: 'gone-tool', detail_ref: null }],
    catalogReleaseDates: { entries: [{ detail_id: 'tool-level3:ghost', release_date: '2026-01-01' }] },
  });
  const dangling = result.findings.filter(finding => finding.code === 'DANGLING_REF');
  assert.equal(dangling.length, 4);
  assert.ok(dangling.every(finding => finding.action === 'remove_pollution'));
});

test('桥接失配：指向缺失实体、model_key 漂移、revision 落后', () => {
  const snapshot = snapshotWith({ level3s: [level3()], cards: [card()] });
  snapshot.revision = 'sha256:current';
  const result = auditCatalogSeriesData({
    snapshot,
    bridge: {
      entries: [
        { model_key: 'openai-gpt-5.6-sol', detail_id: 'tool-level3:gone' },
        { model_key: 'openai-old-key', detail_id: 'tool-level3:gpt-5-6-sol' },
        { model_key: 'openai-gpt-5.6-sol', detail_id: 'tool-level3:gpt-5-6-sol', catalog_revision: 'sha256:stale', verified_at: '2026-01-01T00:00:00Z' },
      ],
    },
  });
  const withCurrentRevision = auditCatalogSeriesData({ snapshot, bridge: { entries: [{ model_key: 'openai-gpt-5.6-sol', detail_id: 'tool-level3:gpt-5-6-sol', catalog_revision: 'sha256:current' }] } });
  const bridgeFindings = result.findings.filter(finding => finding.code === 'BRIDGE_MISMATCH');
  assert.equal(bridgeFindings.length, 3);
  assert.ok(bridgeFindings.every(finding => finding.action === 'reverify'));
  assert.equal(withCurrentRevision.findings.filter(finding => finding.code === 'BRIDGE_MISMATCH').length, 0);
});

test('待补卡/草稿：model_key 非法与同名不同键', () => {
  const snapshot = snapshotWith({ level3s: [level3()], cards: [card()] });
  const result = auditCatalogSeriesData({
    snapshot,
    pendingTools: [{ name: 'GPT-5.6 Sol', tool_key: 'gpt-5-6-sol-clone', model_key: 'bad key' }],
    drafts: [{ seed: { name: 'GPT-5.6 Sol', tool_key: 'another-clone' } }],
  });
  assert.ok(codesOf(result).includes('INVALID_MODEL_KEY'));
  assert.ok(codesOf(result).includes('SAME_NAME_DIFFERENT_KEY'));
});

test('审计纯只读：不改任何输入', () => {
  const snapshot = snapshotWith({ level2s: [level2()], level3s: [level3()], cards: [card()] });
  const frozen = JSON.parse(JSON.stringify(snapshot));
  const policy = { vendor_aliases: {}, capacity: { split_when_member_count_exceeds: 3 } };
  const policyCopy = JSON.parse(JSON.stringify(policy));
  auditCatalogSeriesData({ snapshot, policy, scenes: [], featured: [], pendingTools: [], drafts: [] });
  assert.deepEqual(snapshot, frozen);
  assert.deepEqual(policy, policyCopy);
});

test('空输入与缺字段鲁棒（全部回退空集合，不抛）', () => {
  const result = auditCatalogSeriesData({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(auditCatalogSeriesData({ snapshot: null }).ok, true);
  assert.equal(auditCatalogSeriesData({ snapshot: { 'vendor-level2': 'bad', 'tool-level3': 42 } }).ok, true);
});
