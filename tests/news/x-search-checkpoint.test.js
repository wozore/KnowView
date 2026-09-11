/**
 * x-search-checkpoint.test.js —— Checkpoint Schema 与 14 天尾部重查指标纯领域单元测试
 *
 * 运行：node --test tests/news/x-search-checkpoint.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkpointKeyOf,
  buildCheckpointRecord,
  pruneTailRecheckObservations,
  computeTailRecheckMetrics,
} = require('../../src/news/collectors/x-search/checkpoint-contract');

test('checkpointKeyOf: 生成 ${window_id}::${query_kind}::${query_id}::${query_hash} 唯一键', () => {
  const key = checkpointKeyOf({
    window_id: 'win_123',
    query_kind: 'account_group',
    query_id: 'g1',
    query_hash: 'hash_abc',
  });
  assert.equal(key, 'win_123::account_group::g1::hash_abc');
});

test('buildCheckpointRecord: 账号组与 discovery 查询 schema 契约', () => {
  // 账号组：query_id 与 group_id 均为组 ID
  const groupRec = buildCheckpointRecord({
    window_id: 'win_hot',
    half: 'hot',
    query_kind: 'account_group',
    query_id: 'g1',
    query_hash: 'hash1',
    status: 'partial',
    pages_completed: 1,
    next_cursor: 'cur1',
    reason_code: 'NEWS_BUDGET_EXHAUSTED',
    credits_used: 300,
    retained_items: 2,
  });

  assert.equal(groupRec.schema_version, 1);
  assert.equal(groupRec.group_id, 'g1');
  assert.equal(groupRec.status, 'partial');
  assert.equal(groupRec.credits_used, 300);

  // discovery：group_id 为 null
  const discRec = buildCheckpointRecord({
    window_id: 'win_hot',
    half: 'hot',
    query_kind: 'discovery',
    query_id: 'd_ai_news',
    query_hash: 'hash2',
    status: 'complete',
    pages_completed: 1,
  });

  assert.equal(discRec.group_id, null);
  assert.equal(discRec.status, 'complete');
});

test('pruneTailRecheckObservations: 滚动修剪 30 天以前的记录', () => {
  const now = '2026-09-10T12:00:00.000Z';
  const obs = [
    { recorded_at: '2026-09-09T12:00:00.000Z', recovered_new_count: 1 }, // 1 天前，保留
    { recorded_at: '2026-08-20T12:00:00.000Z', recovered_new_count: 2 }, // 21 天前，保留
    { recorded_at: '2026-08-01T12:00:00.000Z', recovered_new_count: 3 }, // 40 天前，应修剪
  ];

  const pruned = pruneTailRecheckObservations(obs, now, 30);
  assert.equal(pruned.length, 2);
  assert.equal(pruned[0].recovered_new_count, 1);
  assert.equal(pruned[1].recovered_new_count, 2);
});

test('computeTailRecheckMetrics: 计算 14 天滚动汇总指标', () => {
  const now = '2026-09-10T12:00:00.000Z';
  const obs = [
    {
      recorded_at: '2026-09-09T10:00:00.000Z',
      half: 'hot',
      group_id: 'g1',
      recovered_new_count: 3,
      credits_used: 45,
      recovered_approved_count: 2,
    },
    {
      recorded_at: '2026-09-08T10:00:00.000Z',
      half: 'cold',
      group_id: 'g2',
      recovered_new_count: 0,
      credits_used: 15,
      recovered_approved_count: 0,
    },
    // 超出 14 天范围，不计入汇总
    {
      recorded_at: '2026-08-10T10:00:00.000Z',
      half: 'hot',
      group_id: 'g1',
      recovered_new_count: 10,
      credits_used: 150,
      recovered_approved_count: 5,
    },
  ];

  const metrics = computeTailRecheckMetrics(obs, now, 14);

  assert.equal(metrics.total_queries, 2);
  assert.equal(metrics.recovered_new_count, 3);
  assert.equal(metrics.recheck_credits, 60);
  // credits_per_recovered = 60 / 3 = 20
  assert.equal(metrics.credits_per_recovered, 20);
  // hit rate = 1 hit / 2 queries = 0.5
  assert.equal(metrics.recheck_hit_rate, 0.5);
  // approved rate = 2 / 3 = 0.6667
  assert.equal(metrics.recovered_approved_rate, 0.6667);

  // half 分组统计
  assert.equal(metrics.by_half.hot.queries, 1);
  assert.equal(metrics.by_half.hot.recovered, 3);
  assert.equal(metrics.by_half.cold.queries, 1);
  assert.equal(metrics.by_half.cold.recovered, 0);

  // group 分组统计
  assert.equal(metrics.by_group.g1.recovered, 3);
  assert.equal(metrics.by_group.g2.recovered, 0);
});

test('computeTailRecheckMetrics: 无补回数据时 credits_per_recovered 为 null', () => {
  const now = '2026-09-10T12:00:00.000Z';
  const obs = [
    {
      recorded_at: '2026-09-09T10:00:00.000Z',
      recovered_new_count: 0,
      credits_used: 30,
    },
  ];

  const metrics = computeTailRecheckMetrics(obs, now, 14);
  assert.equal(metrics.recovered_new_count, 0);
  assert.equal(metrics.credits_per_recovered, null);
  assert.equal(metrics.recovered_approved_rate, null);
});

test('checkpointContract: index.js 统一门面导出收口且导出数量 <= 15', () => {
  const xSearchIndex = require('../../src/news/collectors/x-search/index');
  const exportKeys = Object.keys(xSearchIndex);

  assert.ok(exportKeys.length <= 15, `index.js 导出总数 (${exportKeys.length}) 必须 <= 15`);
  assert.ok(xSearchIndex.checkpointContract, 'index.js 必须导出 checkpointContract 对象');

  const {
    checkpointKeyOf: keyFn,
    buildCheckpointRecord: recFn,
    pruneTailRecheckObservations: pruneFn,
    computeTailRecheckMetrics: metricsFn,
  } = xSearchIndex.checkpointContract;

  assert.equal(typeof keyFn, 'function');
  assert.equal(typeof recFn, 'function');
  assert.equal(typeof pruneFn, 'function');
  assert.equal(typeof metricsFn, 'function');
});
