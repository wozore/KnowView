'use strict';

/**
 * series-bundle-contract.test.js —— SeriesBundle 契约校验回归（全离线）
 *
 * 用 planSeriesBundle 生成合法基线 bundle，逐条变异触发 Patch 覆盖集
 * 八条规则与结构校验的 blocker；bundleTokenOf 稳定性。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planSeriesBundle,
  validateSeriesBundle,
  bundleTokenOf,
  MEMBER_CLASSIFICATIONS,
  isBundleId,
} = require('../../src/catalog/series/index');
const { loadSeriesPolicy } = require('../../src/catalog/series/index');
const { emptySnapshot, revisionOf } = require('../../src/catalog/core/index');

function baseSnapshot() {
  const snap = emptySnapshot();
  snap['vendor-level2'].push({
    id: 'vendor-level2:zhipu:glm', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:zhipu' },
    vendor_key: 'zhipu', title: 'GLM 5', official_url: 'https://docs.z.ai', summary: 'GLM 5 系列',
    status: 'active', series_kind: 'model_series', generation_state: 'newest',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:glm-5.1' }],
  });
  snap['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' }] });
  snap['tool-level3'].push({ id: 'tool-level3:glm-5.1', vendor_key: 'zhipu', detail_kind: 'api_model', title: 'GLM-5.1', vendor_label: 'zhipu', model_key: 'zhipu-glm-5.1', official_url: 'https://docs.z.ai/guides/llm/glm-5', release_date: '2026-04-01' });
  snap['tool-card'].push({ id: 'tool-card:glm-5-1', tool_key: 'glm-5-1', vendor_key: 'zhipu', title: 'GLM-5.1', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5.1' }, detail_kind: 'api_model', model_key: 'zhipu-glm-5.1', theme: 'general' });
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

function baseBundle(snapshotOverrides) {
  const snapshot = snapshotOverrides || baseSnapshot();
  const result = planSeriesBundle({
    candidate: { candidate_key: 'k1', name: 'GLM 5', entity_type: 'series' },
    verdict: verdict(),
    subModelVerdicts: [
      { name: 'GLM-5.1', model_key: 'zhipu-glm-5.1' },
      { name: 'GLM-5.3', model_key: 'zhipu-glm-5-3', evidence: { official_url: 'https://docs.z.ai/guides/llm/glm-5', content_hash: 'sha256:def' } },
    ],
    policy: loadSeriesPolicy(),
    snapshot,
    receipts: [],
    now: new Date('2026-09-05T00:00:00Z'),
  });
  assert.equal(result.ok, true);
  return result.bundle;
}

test('MEMBER_CLASSIFICATIONS 冻结枚举：already_complete/bundled/deferred', () => {
  assert.deepEqual([...MEMBER_CLASSIFICATIONS], ['already_complete', 'bundled', 'deferred']);
});

test('合法基线 bundle：校验通过（骨架富化门禁除外），token 稳定且 id 形状合法', () => {
  const bundle = baseBundle();
  assert.ok(isBundleId(bundle.bundle_id), 'bundle_id = bundle-<hash12>');
  const checked = validateSeriesBundle(bundle, { snapshot: baseSnapshot(), policy: loadSeriesPolicy() });
  assert.deepEqual(checked.blockers, ['BUNDLE_MEMBERS_NEED_ENRICHMENT'], '新成员骨架待富化是唯一 planner 门禁');
  assert.equal(checked.readiness, 'blocked');
  // 覆盖集层面 ok（无八条规则 blocker）
  const token = bundleTokenOf(bundle);
  assert.match(token, /^btk-[0-9a-f]{16}$/);
  assert.equal(bundleTokenOf({ ...bundle, candidate: { ...bundle.candidate, name: bundle.candidate.name } }), token, '等价内容 token 稳定');
  const mutated = JSON.parse(JSON.stringify(bundle));
  mutated.layer_patches[0].operation = 'noop';
  assert.notEqual(bundleTokenOf(mutated), token, 'patch 变化 → token 变化');
});

test('规则 1：新建 L2 必须携带父 L1 replace patch', () => {
  const bundle = baseBundle();
  bundle.series.mode = 'create';
  const result = validateSeriesBundle(bundle, {});
  assert.ok(result.blockers.includes('BUNDLE_L1_PATCH_MISSING'));
  // 补上 L1 replace → blocker 消失
  bundle.layer_patches.push({
    area: 'vendor-level1', id: 'vendor-level1:zhipu', operation: 'replace',
    record: { id: 'vendor-level1:zhipu', vendor_key: 'zhipu', title: '智谱', level2_refs: [{ kind: 'vendor-level2', id: bundle.series.level2_id }] },
  });
  assert.ok(!validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_L1_PATCH_MISSING'));
});

test('规则 2：L2 detail_refs 必须覆盖全部可见 bundled 成员', () => {
  const bundle = baseBundle();
  const l2Patch = bundle.layer_patches.find(patch => patch.area === 'vendor-level2');
  l2Patch.record.detail_refs = l2Patch.record.detail_refs.filter(ref => ref.id !== 'tool-level3:glm-5-3');
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_L2_MEMBERS_INCOMPLETE'));
});

test('规则 3：bundled 成员缺 L3 patch 拒绝', () => {
  const bundle = baseBundle();
  bundle.layer_patches = bundle.layer_patches.filter(patch => !(patch.area === 'tool-level3' && patch.id === 'tool-level3:glm-5-3'));
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_L3_PATCH_MISSING'));
});

test('规则 4：非 subscription 成员缺卡 patch 或 model_key/visibility 不一致拒绝', () => {
  const bundle = baseBundle();
  bundle.layer_patches = bundle.layer_patches.filter(patch => patch.id !== 'tool-card:glm-5-3');
  const result = validateSeriesBundle(bundle, {});
  assert.ok(result.blockers.includes('BUNDLE_CARD_PATCH_MISSING'));

  const mismatch = baseBundle();
  const cardPatch = mismatch.layer_patches.find(patch => patch.id === 'tool-card:glm-5-3');
  cardPatch.record.model_key = 'zhipu-other-key';
  assert.ok(validateSeriesBundle(mismatch, {}).blockers.includes('BUNDLE_CARD_MODEL_KEY_MISMATCH'));

  const visibility = baseBundle();
  const visPatch = visibility.layer_patches.find(patch => patch.id === 'tool-card:glm-5-3');
  visPatch.record.visibility = 'hidden_history';
  assert.ok(validateSeriesBundle(visibility, {}).blockers.includes('BUNDLE_CARD_VISIBILITY_MISMATCH'));
});

test('规则 5：hidden_history 成员不得留在 L2 detail_refs 且必须带 historical_since', () => {
  const bundle = baseBundle();
  const l3Patch = bundle.layer_patches.find(patch => patch.id === 'tool-level3:glm-5-3');
  l3Patch.record.visibility = 'hidden_history';
  l3Patch.record.historical_since = '2026-09-05';
  const stillInL2 = validateSeriesBundle(bundle, {});
  assert.ok(stillInL2.blockers.includes('BUNDLE_HISTORY_STILL_IN_L2'));
  const l2Patch = bundle.layer_patches.find(patch => patch.area === 'vendor-level2');
  l2Patch.record.detail_refs = l2Patch.record.detail_refs.filter(ref => ref.id !== 'tool-level3:glm-5-3');
  const noDate = validateSeriesBundle(bundle, {});
  assert.ok(!noDate.blockers.includes('BUNDLE_HISTORY_STILL_IN_L2'));
  assert.ok(!noDate.blockers.includes('BUNDLE_HISTORY_DATE_REQUIRED'));
  delete l3Patch.record.historical_since;
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_HISTORY_DATE_REQUIRED'));
});

test('规则 6：新/更新 api_model 必须有形状合法的 bridge entry', () => {
  const bundle = baseBundle();
  bundle.bridge_entries = [];
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_BRIDGE_ENTRY_MISSING'));
  bundle.bridge_entries.push({ model_key: 'zhipu-glm-5-3', title: 'GLM-5.3', vendor_key: 'zhipu' });
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_BRIDGE_ENTRY_INVALID'), '缺必需字段的 entry 拒绝');
});

test('规则 6：future L3 与 Bridge official_url 不一致时 fail-closed', () => {
  const bundle = baseBundle();
  const bridge = bundle.bridge_entries.find(entry => entry.model_key === 'zhipu-glm-5-3');
  bridge.official_url = 'https://other.example/model';
  const result = validateSeriesBundle(bundle, {});
  assert.ok(result.blockers.includes('BUNDLE_BRIDGE_PROJECTION_MISMATCH'));
  const bundle2 = baseBundle();
  const l3Patch = bundle2.layer_patches.find(patch => patch.id === 'tool-level3:glm-5-3');
  delete l3Patch.record.official_url;
  const result2 = validateSeriesBundle(bundle2, {});
  assert.ok(result2.blockers.includes('BUNDLE_BRIDGE_PROJECTION_MISMATCH'));
});

test('规则 7：base_revisions 漂移（catalog/policy/bridge）拒绝', () => {
  const snapshot = baseSnapshot();
  const policy = loadSeriesPolicy();
  const bundle = baseBundle();
  const drifted = JSON.parse(JSON.stringify(bundle));
  drifted.base_revisions.catalog = 'sha256:stale';
  const result = validateSeriesBundle(drifted, { snapshot, policy, bridgeRevision: bundle.base_revisions.bridge });
  assert.ok(result.blockers.some(code => code.startsWith('BUNDLE_BASE_REVISION_DRIFT:catalog')));
  const fresh = validateSeriesBundle(bundle, { snapshot, policy, bridgeRevision: bundle.base_revisions.bridge });
  assert.ok(!fresh.blockers.some(code => code.startsWith('BUNDLE_BASE_REVISION_DRIFT')));
  assert.equal(revisionOf(snapshot), bundle.base_revisions.catalog);
});

test('规则 8：不允许 noop 外的删除（remove 操作拒绝）', () => {
  const bundle = baseBundle();
  bundle.layer_patches.push({ area: 'tool-level3', id: 'tool-level3:some-old', operation: 'remove', record: { id: 'tool-level3:some-old' } });
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_DELETE_FORBIDDEN'));
});

test('结构校验：schema/id/candidate/vendor/series/members/classification 非法拒绝', () => {
  assert.deepEqual(validateSeriesBundle(null, {}), { ok: false, blockers: ['BUNDLE_SCHEMA_INVALID'], readiness: 'blocked' });
  const bundle = baseBundle();
  bundle.schema_version = 2;
  assert.ok(validateSeriesBundle(bundle, {}).blockers.includes('BUNDLE_SCHEMA_INVALID'));
  const badId = baseBundle();
  badId.bundle_id = 'bundle-xyz';
  assert.ok(validateSeriesBundle(badId, {}).blockers.includes('BUNDLE_ID_INVALID'));
  const badMember = baseBundle();
  badMember.members[1].classification = 'unknown';
  assert.ok(validateSeriesBundle(badMember, {}).blockers.includes('BUNDLE_MEMBER_CLASSIFICATION_INVALID'));
  const emptyMembers = baseBundle();
  emptyMembers.members = [];
  assert.ok(validateSeriesBundle(emptyMembers, {}).blockers.includes('BUNDLE_MEMBERS_EMPTY'));
});


test('完整 patch record 与 bridge entry 都参与 preview hash/token；裸 Catalog ID 拒绝', () => {
  const bundle = baseBundle();
  const token = bundleTokenOf(bundle);
  const patchMutation = JSON.parse(JSON.stringify(bundle));
  patchMutation.layer_patches.find(patch => patch.area === 'tool-level3' && patch.operation !== 'noop').record.summary = 'changed';
  assert.notEqual(bundleTokenOf(patchMutation), token, 'L3 record 字段变化必须改变 token');
  const bridgeMutation = JSON.parse(JSON.stringify(bundle));
  bridgeMutation.bridge_entries[0].content_hash = 'sha256:changed';
  assert.notEqual(bundleTokenOf(bridgeMutation), token, 'bridge 字段变化必须改变 token');

  const bare = JSON.parse(JSON.stringify(bundle));
  const member = bare.members.find(item => item.classification === 'bundled');
  member.detail_id = member.detail_id.replace('tool-level3:', '');
  member.tool_card_id = member.tool_card_id.replace('tool-card:', '');
  bare.series.level2_id = bare.series.level2_id.replace('vendor-level2:', '');
  assert.ok(validateSeriesBundle(bare, {}).blockers.includes('BUNDLE_DETAIL_ID_INVALID'));
  assert.ok(validateSeriesBundle(bare, {}).blockers.includes('BUNDLE_TOOL_CARD_ID_INVALID'));
  assert.ok(validateSeriesBundle(bare, {}).blockers.includes('BUNDLE_SERIES_ID_INVALID'));
});
