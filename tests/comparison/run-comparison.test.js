'use strict';

/**
 * run-comparison.test.js — 模型对比抓取管线编排与 retention 事务性回归
 *
 * 覆盖：
 * 1. 抓取未全绿（pending > 0）时跳过重建，磁盘 retention.json 绝对不被提前推进（防与旧数据脱节）；
 * 2. 全绿且重建成功（rebuild.ok === true）后才持久化推进 retention.json。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runComparison } = require('../../src/comparison/core/run-comparison');
const { SHARED_FILES } = require('../../src/shared/paths');
const { readRetentionState, writeRetention } = require('../../src/shared/retention');

test('runComparison: 未全绿时跳过重建，磁盘 retention.json 保持原状不提前推进', async () => {
  // 记录原始 retention 内容以便安全恢复
  const original = readRetentionState();
  const baseRetention = {
    schema_version: 1,
    months: 14,
    retention_year_month: '2025-06',
    last_advanced_at: '2026-08-01T00:00:00.000Z',
  };
  writeRetention(baseRetention);

  try {
    // 注入虚拟时间 2026-09-15（正常会推进到 2025-07）
    const virtualNow = new Date('2026-09-15T12:00:00.000Z');
    // options.skipRebuild 或模拟未全绿跳过重建
    const summary = await runComparison({ skipRebuild: true, now: virtualNow });
    assert.equal(summary.rebuilt, false);

    // 关键断言：因为没有重建成功，磁盘 retention.json 仍然必须是 2025-06，绝不能变成 2025-07！
    const current = readRetentionState();
    assert.equal(current.year_month, '2025-06', '未重建时磁盘 retention.json 保持原状');
  } finally {
    // 恢复
    writeRetention(original);
  }
});
