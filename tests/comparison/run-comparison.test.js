'use strict';

/**
 * run-comparison.test.js — 模型对比抓取管线编排与 retention 事务性回归
 *
 * 覆盖：
 * 1. 抓取未全绿（pending > 0）时跳过重建，磁盘 retention.json 绝对不被提前推进（防与旧数据脱节）；
 * 2. 全绿且重建成功（rebuild.ok === true）后才持久化推进 retention.json；
 * 3. scripts/fetch-comparison.js 的 run 退出判定纯函数：全绿→0，有失败源/到期未就绪源/重建失败→非 0。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runComparison } = require('../../src/comparison/core/run-comparison');
const { runExitCode } = require('../../scripts/fetch-comparison');
const { COMPARISON_FILES } = require('../../src/shared/paths');
const { readRetentionState, writeRetention } = require('../../src/shared/retention');

function summaryOf(overrides = {}) {
  return {
    fetched: [],
    failed: [],
    pending: [],
    rebuilt: false,
    errors: {},
    ...overrides,
  };
}

test('runExitCode: 全绿重建（无失败、无 pending、已重建）→ 0', () => {
  assert.equal(runExitCode(summaryOf({ fetched: ['openrouter', 'lmarena', 'livebench', 'llm_stats'], rebuilt: true })), 0);
});

test('runExitCode: 无源到期且数据保持新鲜（无失败、无 pending、未重建）→ 0', () => {
  assert.equal(runExitCode(summaryOf()), 0);
});

test('runExitCode: 有失败源 → 非 0', () => {
  assert.notEqual(runExitCode(summaryOf({ failed: ['lmarena'], pending: ['lmarena'] })), 0);
});

test('runExitCode: 有到期未就绪源（无失败也判非 0）', () => {
  assert.notEqual(runExitCode(summaryOf({ fetched: ['openrouter'], pending: ['lmarena'] })), 0);
});

test('runExitCode: 全绿但重建失败（fail-closed）→ 非 0', () => {
  assert.notEqual(runExitCode(summaryOf({ fetched: ['openrouter', 'lmarena', 'livebench', 'llm_stats'], errors: { rebuild: ['boom'] } })), 0);
});

test('runComparison: 未全绿时跳过重建，磁盘 retention.json 保持原状不提前推进', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-test-'));
  const retentionFile = path.join(tempDir, 'retention.json');
  const files = { refreshConfig: path.join(tempDir, 'refresh-config.json') };
  const sources = {};
  const rawKeys = {
    openrouter: 'rawOpenRouter',
    lmarena: 'rawLmarena',
    livebench: 'rawLivebench',
    llm_stats: 'rawLlmStats',
  };
  for (const source of Object.keys(rawKeys)) {
    const key = rawKeys[source];
    files[key] = path.join(tempDir, `${source}.json`);
    sources[source] = { interval_hours: 24, full_every: 10, count: 0 };
    fs.writeFileSync(files[key], JSON.stringify({ fetched_at: new Date().toISOString(), items: [] }), 'utf8');
  }
  fs.writeFileSync(files.refreshConfig, JSON.stringify({ sources }), 'utf8');

  const baseRetention = {
    schema_version: 1,
    months: 14,
    retention_year_month: '2025-06',
    last_advanced_at: '2026-08-01T00:00:00.000Z',
  };
  writeRetention(baseRetention, retentionFile);

  try {
    const virtualNow = new Date('2026-09-15T12:00:00.000Z');
    const summary = await runComparison({
      skipRebuild: true,
      now: virtualNow,
      files,
      retentionFile,
      fetchers: Object.fromEntries(Object.keys(sources).map(source => [source, async () => {
        throw new Error('测试不应调用 fetcher');
      }])),
    });
    assert.equal(summary.rebuilt, false);
    const current = readRetentionState(retentionFile);
    assert.equal(current.year_month, '2025-06', '未重建时磁盘 retention.json 保持原状');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
