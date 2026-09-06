'use strict';

/**
 * series-bundle-planner.test.js —— SeriesBundle 确定性规划器回归（零网络零 AI）
 *
 * 覆盖：成员三分类（already_complete/bundled/deferred）、政策重算目标系列、
 * 容量 6 与第 7 个起按 release_date 最旧转 hidden_history、新建 L2 的 L1 补丁、
 * bridge entries、base_revisions、非系列 verdict 拒绝。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planSeriesBundle,
  planHistoryTransitions,
  loadSeriesPolicy,
} = require('../../src/catalog/series/index');
const { emptySnapshot } = require('../../src/catalog/core/index');

const POLICY = loadSeriesPolicy();

function glmSnapshot(memberCount = 2, withReleaseDates = true) {
  const snap = emptySnapshot();
  const members = [];
  for (let i = 1; i <= memberCount; i += 1) {
    const key = `glm-5-${i}`;
    members.push({ kind: 'tool-level3', id: `tool-level3:${key}` });
    snap['tool-level3'].push({
      id: `tool-level3:${key}`, vendor_key: 'zhipu', detail_kind: 'api_model', title: `GLM 5.${i}`,
      vendor_label: 'zhipu', model_key: `zhipu-glm-5-${i}`,
      ...(withReleaseDates ? { release_date: `2026-0${Math.min(i, 9)}-15` } : {}),
    });
    snap['tool-card'].push({ id: `tool-card:${key}`, tool_key: key, vendor_key: 'zhipu', title: `GLM 5.${i}`, detail_ref: { kind: 'tool-level3', id: `tool-level3:${key}` }, detail_kind: 'api_model', model_key: `zhipu-glm-5-${i}`, theme: 'general' });
  }
  snap['vendor-level2'].push({
    id: 'vendor-level2:zhipu:glm', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:zhipu' },
    vendor_key: 'zhipu', title: 'GLM 5', official_url: 'https://docs.z.ai', summary: 'GLM 5 系列',
    status: 'active', series_kind: 'model_series', generation_state: 'newest', detail_refs: members,
  });
  snap['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' }] });
  return snap;
}

function verdict() {
  return {
    entity_class: 'series', vendor_key: 'zhipu', model_key: 'zhipu-glm-5', series_title: 'GLM 5',
    family: 'glm', confidence: 0.9,
    evidence: { official_url: 'https://docs.z.ai/guides/llm/glm-5', content_hash: 'sha256:abc' },
    reasons: ['官方模型列表含 GLM 系列'],
  };
}

function plan(snapshot, subModelVerdicts, extras = {}) {
  return planSeriesBundle({
    candidate: { candidate_key: 'k1', name: 'GLM 5', entity_type: 'series' },
    verdict: verdict(),
    subModelVerdicts,
    policy: POLICY,
    snapshot,
    receipts: [],
    now: new Date('2026-09-05T00:00:00Z'),
    ...extras,
  });
}

test('成员三分类：已存在 already_complete、新成员 bundled、缺 model_key deferred', () => {
  const result = plan(glmSnapshot(2), [
    { name: 'GLM 5.1', model_key: 'zhipu-glm-5-1' },
    { name: 'GLM-5.3', model_key: 'zhipu-glm-5-3' },
    { name: 'Mystery Member' },
  ]);
  assert.equal(result.ok, true);
  const byName = new Map(result.bundle.members.map(member => [member.name, member]));
  assert.equal(byName.get('GLM 5.1').classification, 'already_complete');
  assert.equal(byName.get('GLM 5.1').detail_id, 'tool-level3:glm-5-1', '已存在成员沿用现有 detail id');
  assert.equal(byName.get('GLM-5.3').classification, 'bundled');
  assert.equal(byName.get('GLM-5.3').detail_id, 'tool-level3:glm-5-3');
  assert.equal(byName.get('Mystery Member').classification, 'deferred');
  assert.deepEqual(result.bundle.deferred_models.map(item => item.name), ['Mystery Member']);
  assert.ok(result.bundle.blockers.includes('BUNDLE_MEMBERS_NEED_ENRICHMENT'), '有新成员骨架 → 富化门禁 blocked');
});

test('政策重算目标系列与代际；existing 模式不改 L1', () => {
  const result = plan(glmSnapshot(1), [{ name: 'GLM-5.2', model_key: 'zhipu-glm-5-2' }]);
  assert.equal(result.bundle.series.level2_id, 'vendor-level2:zhipu:glm');
  assert.equal(result.bundle.series.mode, 'existing');
  assert.equal(result.bundle.series.generation_state, 'newest');
  assert.equal(result.bundle.series.series_kind, 'model_series');
  assert.ok(!result.bundle.layer_patches.some(patch => patch.area === 'vendor-level1'), 'existing 模式不需要 L1 patch');
});

test('新建 L2 → mode=create 且携带父 L1 replace patch（规则 1）', () => {
  const snap = glmSnapshot(0, false);
  snap['vendor-level2'] = snap['vendor-level2'].filter(l2 => l2.id !== 'vendor-level2:zhipu:glm');
  const result = plan(snap, [{ name: 'GLM-5.3', model_key: 'zhipu-glm-5-3' }]);
  assert.equal(result.ok, true);
  assert.equal(result.bundle.series.mode, 'create');
  assert.ok(result.bundle.layer_patches.some(patch => patch.area === 'vendor-level1' && patch.operation === 'replace'), '新建 L2 必须有父 L1 replace');
});

test('容量 6：第 7 个起按 release_date 最旧转 hidden_history，新成员不转', () => {
  // 现有 6 个可见成员 + 1 个新核验成员 → 最旧（缺 release_date 视为最旧）转历史
  const snap = glmSnapshot(6);
  // 给第 1 个成员最早日期，第 6 个最晚
  snap['tool-level3'][0].release_date = '2026-01-01';
  snap['tool-level3'][5].release_date = '2026-08-01';
  const result = plan(snap, [{ name: 'GLM-5.7', model_key: 'zhipu-glm-5-7' }]);
  assert.equal(result.ok, true);
  const bundle = result.bundle;
  const l2Patch = bundle.layer_patches.find(patch => patch.area === 'vendor-level2');
  assert.equal(l2Patch.record.detail_refs.length, 6, '可见成员保持容量 6');
  assert.deepEqual(l2Patch.record.detail_refs.map(ref => ref.id).sort(),
    ['tool-level3:glm-5-2', 'tool-level3:glm-5-3', 'tool-level3:glm-5-4', 'tool-level3:glm-5-5', 'tool-level3:glm-5-6', 'tool-level3:glm-5-7'].sort());
  const historyPatch = bundle.layer_patches.find(patch => patch.area === 'tool-level3' && patch.id === 'tool-level3:glm-5-1');
  assert.ok(historyPatch, '最旧成员（2026-01-01）被转历史');
  assert.equal(historyPatch.record.visibility, 'hidden_history');
  assert.equal(historyPatch.record.historical_since, '2026-09-05');
  const cardPatch = bundle.layer_patches.find(patch => patch.area === 'tool-card' && patch.id === 'tool-card:glm-5-1');
  assert.ok(cardPatch, '历史转移同步卡 replace（规则 5）');
  assert.equal(cardPatch.record.visibility, 'hidden_history');
  assert.equal(historyPatch.operation, 'replace', 'hidden_history 只标不改不删（replace 保留记录）');
});

test('planHistoryTransitions：容量内零转移，超容按 release_date 最旧出队', () => {
  const snap = glmSnapshot(3);
  const within = planHistoryTransitions(POLICY, [{ id: 'vendor-level2:zhipu:glm' }], snap);
  assert.deepEqual(within.transitions, []);
  const seven = glmSnapshot(7);
  seven['tool-level3'][2].release_date = null; // 缺日期视为最旧
  const over = planHistoryTransitions(POLICY, [{ id: 'vendor-level2:zhipu:glm' }], seven, new Date('2026-09-05T00:00:00Z'));
  assert.equal(over.transitions.length, 1);
  assert.equal(over.transitions[0].detail_id, 'tool-level3:glm-5-3', '缺 release_date 视为最旧先转');
  assert.equal(over.transitions[0].historical_since, '2026-09-05');
  assert.equal(over.capacity.visible_members, 6);
  assert.equal(over.capacity.history_retention_months, 14);
});

test('非系列 verdict / 缺输入 fail-closed 拒绝', () => {
  const modelVerdict = { ...verdict(), entity_class: 'model' };
  const rejected = planSeriesBundle({
    candidate: { name: 'X' }, verdict: modelVerdict, subModelVerdicts: [],
    policy: POLICY, snapshot: glmSnapshot(1),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'BUNDLE_VERDICT_NOT_SERIES');
  const noInput = planSeriesBundle({ candidate: null, verdict: null, policy: POLICY, snapshot: null });
  assert.equal(noInput.code, 'BUNDLE_INPUT_INVALID');
});

test('bundle 携带 base_revisions 与 bridge entries（每个新 api_model 一条）', () => {
  const result = plan(glmSnapshot(1), [
    { name: 'GLM-5.2', model_key: 'zhipu-glm-5-2', evidence: { official_url: 'https://docs.z.ai/m', content_hash: 'sha256:h2' } },
    { name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', evidence: { official_url: 'https://docs.z.ai/m', content_hash: 'sha256:h3' } },
  ]);
  const bundle = result.bundle;
  assert.equal(bundle.base_revisions.catalog.length > 0, true);
  assert.ok(bundle.base_revisions.policy.startsWith('sha256:'));
  assert.equal(bundle.bridge_entries.length, 2, '每个新 api_model 一条 bridge entry');
  for (const entry of bundle.bridge_entries) {
    assert.equal(entry.series_id, 'vendor-level2:zhipu:glm');
    assert.equal(entry.vendor_key, 'zhipu');
    assert.ok(entry.model_key && entry.detail_id && entry.tool_card_id);
  }
  assert.equal(bundle.candidate.entity_type, 'series');
  assert.equal(bundle.schema_version, 1);
  assert.match(bundle.bundle_id, /^bundle-[0-9a-f]{12}$/);
  assert.match(bundle.bundle_token, /^btk-[0-9a-f]{16}$/);
});
