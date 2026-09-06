'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../../../src/pending/index');

function tempFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'pending.json');
}

test('pending store uses stable candidate keys and preserves reviewed decisions', async () => {
  const toolFile = tempFile('pending-store-');
  const first = await store.mergePending('tools', [{ name: ' Tool X ', description: 'first' }], { toolFile });
  assert.equal(first.cards.length, 1);
  assert.equal(first.cards[0].candidate_key, store.candidateKeyOf('tools', 'tool x'));
  assert.equal(first.cards[0].review_status, 'pending');
  const reviewed = await store.reviewPending('tools', first.cards[0].candidate_key, 'discarded', first.revision, { toolFile });
  const merged = await store.mergePending('tools', [{ name: 'Tool X', description: 'first' }], { toolFile });
  assert.equal(merged.cards[0].review_status, 'discarded');
  assert.equal(merged.cards[0].reviewed_at, reviewed.cards[0].reviewed_at);
  const changed = await store.mergePending('tools', [{ name: 'Tool X', description: 'changed' }], { toolFile });
  assert.equal(changed.cards[0].review_status, 'pending');
  assert.notEqual(changed.revision, merged.revision);
});

test('pending store review uses revision CAS and projection hides business fields', async () => {
  const conceptFile = tempFile('pending-concept-');
  const result = await store.mergePending('concepts', [{ term: 'RAG', definition: 'private evidence' }], { conceptFile });
  await assert.rejects(
    store.reviewPending('concepts', result.cards[0].candidate_key, 'approved', 'sha256:stale', { conceptFile }),
    error => error.code === 'REVISION_CONFLICT',
  );
  const publicView = store.projectPending('concepts', result);
  assert.deepEqual(Object.keys(publicView.items[0]).sort(), ['blocking_reasons', 'candidate_key', 'generated_at', 'intake_outcome', 'intake_outcome_at', 'mentioned_in_summaries', 'review_status', 'reviewed_at', 'source_hotspot', 'term', 'workflow_state']);
  assert.equal(Object.hasOwn(publicView.items[0], 'definition'), false);
  assert.equal(publicView.items[0].intake_outcome, 'pending', '缺省 intake_outcome 为 pending');
  assert.equal(publicView.items[0].intake_outcome_at, null);
});

// ── setIntakeOutcome：系统轴双字段（锁 + CAS，与人工轴正交） ────
test('setIntakeOutcome writes system axis with CAS and keeps review axis untouched', async () => {
  const toolFile = tempFile('pending-intake-');
  const merged = await store.mergePending('tools', [{ name: 'Kling 3.0', entity_type: 'model', detail_kind_hint: 'api_model' }], { toolFile });
  const key = merged.cards[0].candidate_key;
  const before = await store.readPending('tools', { toolFile });

  // 非法 outcome → INTAKE_OUTCOME_INVALID
  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'approved', before.revision, { toolFile }),
    error => error.code === 'INTAKE_OUTCOME_INVALID',
  );
  // 候选不存在 → PENDING_CANDIDATE_NOT_FOUND
  await assert.rejects(
    store.setIntakeOutcome('tools', 'no-such-key', 'verification_blocked', before.revision, { toolFile }),
    error => error.code === 'PENDING_CANDIDATE_NOT_FOUND',
  );
  // revision 漂移 → REVISION_CONFLICT
  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'verification_blocked', 'sha256:stale', { toolFile }),
    error => error.code === 'REVISION_CONFLICT',
  );

  // 合法写入：intake_outcome 变化 → revision 变化；人工轴不动
  const after = await store.setIntakeOutcome('tools', key, 'verification_blocked', before.revision, { toolFile });
  assert.equal(after.cards[0].intake_outcome, 'verification_blocked');
  assert.ok(after.cards[0].intake_outcome_at, 'intake_outcome_at 已写入');
  assert.notEqual(after.revision, before.revision, 'intake_outcome 变化必须体现在 revision 中');
  assert.equal(after.cards[0].review_status, 'pending', '系统轴写入不影响人工轴');

  // 人工 approve 后，系统轴字段保留（双轴正交）
  const reviewed = await store.reviewPending('tools', key, 'approved', after.revision, { toolFile });
  assert.equal(reviewed.cards[0].review_status, 'approved');
  assert.equal(reviewed.cards[0].intake_outcome, 'verification_blocked', '人工动作不改写 intake_outcome');
});

test('setIntakeOutcome 同值幂等且受状态迁移 gate 约束', async () => {
  const toolFile = tempFile('pending-intake-gate-');
  const first = await store.mergePending('tools', [{ name: 'Gate Model' }], { toolFile });
  const key = first.cards[0].candidate_key;

  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'committed', first.revision, { toolFile }),
    error => error.code === 'INTAKE_OUTCOME_TRANSITION_INVALID',
  );
  const blocked = await store.setIntakeOutcome('tools', key, 'verification_blocked', first.revision, { toolFile });
  const repeated = await store.setIntakeOutcome('tools', key, 'verification_blocked', blocked.revision, { toolFile });
  assert.equal(repeated.revision, blocked.revision, '同值写入不得改变 revision');
  assert.equal(repeated.generated_at, blocked.generated_at, '同值写入不得刷新 generated_at');
  assert.equal(repeated.cards[0].intake_outcome_at, blocked.cards[0].intake_outcome_at, '同值写入不得刷新 outcome 时间');

  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'pending', repeated.revision, { toolFile }),
    error => error.code === 'INTAKE_OUTCOME_TRANSITION_INVALID',
  );
  const complete = await store.setIntakeOutcome('tools', key, 'already_complete', repeated.revision, { toolFile });
  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'committed', complete.revision, { toolFile }),
    error => error.code === 'INTAKE_OUTCOME_TRANSITION_INVALID',
  );
  const terminalRepeat = await store.setIntakeOutcome('tools', key, 'already_complete', complete.revision, { toolFile });
  assert.equal(terminalRepeat.revision, complete.revision, '终态只允许同值幂等');
});

test('setIntakeOutcome 仅显式 Bundle discard 可回退 bundled_for_review', async () => {
  const toolFile = tempFile('pending-intake-discard-');
  const first = await store.mergePending('tools', [{ name: 'Bundle Model' }], { toolFile });
  const key = first.cards[0].candidate_key;
  const bundled = await store.setIntakeOutcome('tools', key, 'bundled_for_review', first.revision, { toolFile });
  await assert.rejects(
    store.setIntakeOutcome('tools', key, 'pending', bundled.revision, { toolFile }),
    error => error.code === 'INTAKE_OUTCOME_TRANSITION_INVALID',
  );
  const discarded = await store.setIntakeOutcome('tools', key, 'pending', bundled.revision, { toolFile, allowBundleDiscard: true });
  assert.equal(discarded.cards[0].intake_outcome, 'pending');
  assert.notEqual(discarded.revision, bundled.revision);
});

test('setIntakeOutcome serializes concurrent writers via revision CAS', async () => {
  const toolFile = tempFile('pending-intake-race-');
  const merged = await store.mergePending('tools', [{ name: 'Racer Model' }], { toolFile });
  const key = merged.cards[0].candidate_key;
  const [first, second] = await Promise.allSettled([
    store.setIntakeOutcome('tools', key, 'already_complete', merged.revision, { toolFile }),
    store.setIntakeOutcome('tools', key, 'verification_blocked', merged.revision, { toolFile }),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'REVISION_CONFLICT');
});

test('mergePending never resets system axis fields and keeps entity business fields', async () => {
  const toolFile = tempFile('pending-intake-merge-');
  const first = await store.mergePending('tools', [{ name: 'GPT-5.6', entity_type: 'series', identity_key: 'gpt-5.6' }], { toolFile });
  const key = first.cards[0].candidate_key;
  await store.setIntakeOutcome('tools', key, 'bundled_for_review', first.revision, { toolFile });
  // 业务字段变化触发重新 merge：review_status 保持 pending，系统轴 intake_outcome 不被重置
  const changed = await store.mergePending('tools', [{ name: 'GPT-5.6', entity_type: 'series', identity_key: 'gpt-5.6', description: 'updated' }], { toolFile });
  assert.equal(changed.cards[0].intake_outcome, 'bundled_for_review', 'merge 合并不重置 intake_outcome');
  assert.ok(changed.cards[0].intake_outcome_at);
  assert.equal(changed.cards[0].entity_type, 'series', 'entity_type 业务字段持久保留');
  assert.equal(changed.cards[0].identity_key, 'gpt-5.6', 'identity_key 业务字段持久保留');
  // 投影层：entity_type 存在时展示
  const view = store.projectPending('tools', changed);
  assert.equal(view.items[0].entity_type, 'series');
  assert.equal(view.items[0].intake_outcome, 'bundled_for_review');
});

test('pending store review is async and serializes concurrent writes', async () => {
  const toolFile = tempFile('pending-race-');
  const first = await store.mergePending('tools', [{ name: 'Racer', description: 'v1' }], { toolFile });
  const [approved, rejected] = await Promise.allSettled([
    store.reviewPending('tools', first.cards[0].candidate_key, 'approved', first.revision, { toolFile }),
    store.reviewPending('tools', first.cards[0].candidate_key, 'discarded', first.revision, { toolFile }),
  ]);
  assert.equal(approved.status, 'fulfilled');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  const after = await store.mergePending('tools', [{ name: 'Racer', description: 'v1' }], { toolFile });
  assert.equal(after.cards[0].review_status, 'approved', '并发后人工结论仍在，业务字段未变前不重置');
});


test('pending facade exposes seed conversion and shared catalog duplicate rules', () => {
  assert.equal(store.isVagueName('ChatGPT'), true);
  assert.equal(store.toolExists('Cursor', [{ title: 'Cursor' }]), true);
  assert.equal(store.conceptExists('RAG', [{ term: 'RAG' }]), true);
  assert.equal(store.pendingCandidateToSeed({ name: 'Kling 2.6 Pro', detail_kind_hint: 'api_model' }).detail_kind, 'api_model');
  assert.deepEqual([...store.INTAKE_OUTCOMES], ['pending', 'verification_blocked', 'deferred_insufficient_evidence', 'already_complete', 'bundled_for_review', 'committed']);
});

test('pendingCandidateToSeed rejects series candidates (SeriesBundle pipeline owns series)', () => {
  assert.throws(() => store.pendingCandidateToSeed({ name: 'GPT-5.6', entity_type: 'series' }), /PENDING_CANDIDATE_SERIES/);
});
