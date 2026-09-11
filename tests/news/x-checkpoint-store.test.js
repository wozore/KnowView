/**
 * x-checkpoint-store.test.js —— X Checkpoint Store 持久层与 Fail-Closed 单元测试
 *
 * 运行：node --test tests/news/x-checkpoint-store.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  readXCheckpointStore,
  writeXCheckpointStore,
  applyCheckpointPatches,
  createDefaultCheckpointStore,
} = require('../../src/news/collectors/x-search/x-checkpoint-store');

function createTempFile(name, content = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-cp-test-'));
  const filePath = path.join(tmpDir, name);
  if (content !== null) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return {
    filePath,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('createDefaultCheckpointStore: 返回 schema_version: 1 默认初始结构', () => {
  const def = createDefaultCheckpointStore();
  assert.equal(def.schema_version, 1);
  assert.equal(def.updated_at, null);
  assert.deepEqual(def.checkpoints, {});
  assert.deepEqual(def.tail_recheck_observations, []);
});

test('readXCheckpointStore: 文件不存在时返回默认结构', () => {
  const { filePath, cleanup } = createTempFile('nonexistent.json');
  try {
    const store = readXCheckpointStore(filePath);
    assert.equal(store.schema_version, 1);
    assert.equal(store.updated_at, null);
    assert.deepEqual(store.checkpoints, {});
    assert.deepEqual(store.tail_recheck_observations, []);
  } finally {
    cleanup();
  }
});

test('readXCheckpointStore: 文件内容损坏时 fail-closed 抛错阻断（严禁静默回退）', () => {
  const { filePath, cleanup } = createTempFile('corrupt.json', '{ bad json ...');
  try {
    assert.throws(
      () => readXCheckpointStore(filePath),
      err => err instanceof SyntaxError
    );
  } finally {
    cleanup();
  }
});

test('readXCheckpointStore: 根结构非 object 时 fail-closed 抛错', () => {
  const { filePath, cleanup } = createTempFile('array-root.json', JSON.stringify([1, 2, 3]));
  try {
    assert.throws(
      () => readXCheckpointStore(filePath),
      /root must be an object/
    );
  } finally {
    cleanup();
  }
});

test('readXCheckpointStore: checkpoints 非 object 时 fail-closed 抛错', () => {
  const { filePath, cleanup } = createTempFile('bad-checkpoints.json', JSON.stringify({ checkpoints: 'invalid' }));
  try {
    assert.throws(
      () => readXCheckpointStore(filePath),
      /checkpoints must be an object/
    );
  } finally {
    cleanup();
  }
});

test('readXCheckpointStore: tail_recheck_observations 非 array 时 fail-closed 抛错', () => {
  const { filePath, cleanup } = createTempFile('bad-obs.json', JSON.stringify({ tail_recheck_observations: 'invalid' }));
  try {
    assert.throws(
      () => readXCheckpointStore(filePath),
      /tail_recheck_observations must be an array/
    );
  } finally {
    cleanup();
  }
});

test('writeXCheckpointStore: 正常原子写回并能正确读回', () => {
  const { filePath, cleanup } = createTempFile('roundtrip.json');
  try {
    const store = {
      schema_version: 1,
      updated_at: '2026-09-10T00:00:00.000Z',
      checkpoints: {
        'win1::account_group::g1::hash1': {
          schema_version: 1,
          window_id: 'win1',
          half: 'hot',
          query_kind: 'account_group',
          query_id: 'g1',
          group_id: 'g1',
          query_hash: 'hash1',
          status: 'partial',
          pages_completed: 1,
          next_cursor: 'cur1',
          reason_code: 'BUDGET_EXHAUSTED',
          credits_used: 300,
          retained_items: 2,
          updated_at: '2026-09-10T00:00:00.000Z',
        },
      },
      tail_recheck_observations: [],
    };
    writeXCheckpointStore(store, 'test-run', filePath);

    const readBack = readXCheckpointStore(filePath);
    assert.equal(readBack.schema_version, 1);
    assert.equal(readBack.updated_at, '2026-09-10T00:00:00.000Z');
    assert.ok(readBack.checkpoints['win1::account_group::g1::hash1']);
    assert.equal(readBack.checkpoints['win1::account_group::g1::hash1'].status, 'partial');
  } finally {
    cleanup();
  }
});

test('applyCheckpointPatches: 成功条目清理/压缩，未解决条目保留', () => {
  const now = '2026-09-10T12:00:00.000Z';
  const existingStore = {
    schema_version: 1,
    updated_at: '2026-09-10T00:00:00.000Z',
    checkpoints: {
      'win1::account_group::g1::hash1': {
        schema_version: 1,
        window_id: 'win1',
        half: 'hot',
        query_kind: 'account_group',
        query_id: 'g1',
        group_id: 'g1',
        query_hash: 'hash1',
        status: 'partial',
        pages_completed: 1,
        next_cursor: 'cur1',
        reason_code: 'BUDGET_EXHAUSTED',
        credits_used: 300,
        retained_items: 2,
        updated_at: '2026-09-10T00:00:00.000Z',
      },
    },
    tail_recheck_observations: [],
  };

  // 补丁 1：g1 在新一轮中已 complete → 应被移除（清理/压缩）
  // 补丁 2：g2 出现 partial → 应被记录保留
  const patches = [
    {
      window_id: 'win1',
      half: 'hot',
      query_kind: 'account_group',
      query_id: 'g1',
      group_id: 'g1',
      query_hash: 'hash1',
      status: 'complete',
      pages_completed: 2,
      next_cursor: null,
      reason_code: null,
      credits_used: 600,
      retained_items: 5,
    },
    {
      window_id: 'win1',
      half: 'hot',
      query_kind: 'account_group',
      query_id: 'g2',
      group_id: 'g2',
      query_hash: 'hash2',
      status: 'partial',
      pages_completed: 1,
      next_cursor: 'cur2',
      reason_code: 'BUDGET_EXHAUSTED',
      credits_used: 300,
      retained_items: 1,
    },
  ];

  const updated = applyCheckpointPatches(existingStore, patches, 'run-test', now);

  assert.equal(updated.updated_at, now);
  // g1 成功完成已从 checkpoints 中清理
  assert.equal(updated.checkpoints['win1::account_group::g1::hash1'], undefined);
  // g2 partial 已成功落入 checkpoints
  assert.ok(updated.checkpoints['win1::account_group::g2::hash2']);
  assert.equal(updated.checkpoints['win1::account_group::g2::hash2'].status, 'partial');
  assert.equal(updated.checkpoints['win1::account_group::g2::hash2'].next_cursor, 'cur2');
});

test('applyCheckpointPatches: 滚动修剪 30 天前的尾部重查观察记录', () => {
  const now = '2026-09-10T12:00:00.000Z';
  const existingStore = {
    schema_version: 1,
    updated_at: null,
    checkpoints: {},
    tail_recheck_observations: [
      { recorded_at: '2026-08-01T00:00:00.000Z', group_id: 'g1', recovered_new_count: 1, credits_used: 15 }, // > 30 天，修剪
      { recorded_at: '2026-09-09T00:00:00.000Z', group_id: 'g2', recovered_new_count: 2, credits_used: 30 }, // 1 天前，保留
    ],
  };

  const newObs = [
    { recorded_at: now, group_id: 'g3', recovered_new_count: 3, credits_used: 45 },
  ];

  const updated = applyCheckpointPatches(existingStore, newObs, 'run-test', now);

  assert.equal(updated.tail_recheck_observations.length, 2);
  assert.equal(updated.tail_recheck_observations[0].group_id, 'g2');
  assert.equal(updated.tail_recheck_observations[1].group_id, 'g3');
});
