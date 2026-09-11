/**
 * x-search-window.test.js —— X Advanced Search 采集时间窗纯领域单元测试
 *
 * 运行：node --test tests/news/x-search-window.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveXCollectionWindow,
  inWindow,
  resolveTailRecheckWindow,
  checkDelayed,
} = require('../../src/news/collectors/x-search/window');

test('resolveXCollectionWindow: hot slot 构造前一日 20:00 至当日 08:00', () => {
  const window = resolveXCollectionWindow({ slot: 'hot', businessDate: '2026-09-10' });
  assert.equal(window.slot, 'hot');
  assert.equal(window.business_date, '2026-09-10');
  assert.equal(window.since_bjt, '2026-09-09T20:00:00+08:00');
  assert.equal(window.until_bjt, '2026-09-10T08:00:00+08:00');
  assert.equal(window.window_id, '2026-09-09T20:00:00+08:00__2026-09-10T08:00:00+08:00');

  // 校验 Unix 秒级时间戳转换一致性
  assert.equal(window.since_unix, Math.floor(Date.parse('2026-09-09T20:00:00+08:00') / 1000));
  assert.equal(window.until_unix, Math.floor(Date.parse('2026-09-10T08:00:00+08:00') / 1000));
  assert.equal(window.until_unix - window.since_unix, 12 * 3600);
});

test('resolveXCollectionWindow: cold slot 构造当日 08:00 至当日 20:00', () => {
  const window = resolveXCollectionWindow({ slot: 'cold', businessDate: '2026-09-10' });
  assert.equal(window.slot, 'cold');
  assert.equal(window.business_date, '2026-09-10');
  assert.equal(window.since_bjt, '2026-09-10T08:00:00+08:00');
  assert.equal(window.until_bjt, '2026-09-10T20:00:00+08:00');
  assert.equal(window.window_id, '2026-09-10T08:00:00+08:00__2026-09-10T20:00:00+08:00');
  assert.equal(window.until_unix - window.since_unix, 12 * 3600);
});

test('resolveXCollectionWindow: 跨月跨年计算准确', () => {
  // 跨月：3 月 1 日的前一日为 2 月 28 日
  const winMarch = resolveXCollectionWindow({ slot: 'hot', businessDate: '2026-03-01' });
  assert.equal(winMarch.since_bjt, '2026-02-28T20:00:00+08:00');
  assert.equal(winMarch.until_bjt, '2026-03-01T08:00:00+08:00');

  // 跨年：1 月 1 日的前一日为 12 月 31 日
  const winJan = resolveXCollectionWindow({ slot: 'hot', businessDate: '2026-01-01' });
  assert.equal(winJan.since_bjt, '2025-12-31T20:00:00+08:00');
  assert.equal(winJan.until_bjt, '2026-01-01T08:00:00+08:00');
});

test('resolveXCollectionWindow: manualWindow 显式覆盖支持', () => {
  const manual = {
    window_id: '2026-08-01T10:00:00+08:00__2026-08-01T14:00:00+08:00',
    slot: 'manual',
    business_date: '2026-08-01',
  };
  const window = resolveXCollectionWindow({ manualWindow: manual });
  assert.equal(window.slot, 'manual');
  assert.equal(window.since_bjt, '2026-08-01T10:00:00+08:00');
  assert.equal(window.until_bjt, '2026-08-01T14:00:00+08:00');
  assert.equal(window.until_unix - window.since_unix, 4 * 3600);
});

test('resolveXCollectionWindow: 非法 slot 抛错阻断', () => {
  assert.throws(() => resolveXCollectionWindow({ slot: 'invalid' }), /Invalid collection slot/);
  assert.throws(() => resolveXCollectionWindow({ slot: null }), /Invalid collection slot/);
});

test('inWindow: 严格半开区间 [since, until) 边界判定', () => {
  const window = resolveXCollectionWindow({ slot: 'cold', businessDate: '2026-09-10' });
  // since: 2026-09-10T08:00:00+08:00 = 2026-09-10T00:00:00.000Z
  // until: 2026-09-10T20:00:00+08:00 = 2026-09-10T12:00:00.000Z

  // 1. 正好等于 since -> true (包含)
  assert.equal(inWindow('2026-09-10T08:00:00+08:00', window), true);
  assert.equal(inWindow('2026-09-10T00:00:00.000Z', window), true);

  // 2. 窗口内部 -> true
  assert.equal(inWindow('2026-09-10T12:00:00+08:00', window), true);
  assert.equal(inWindow('2026-09-10T19:59:59.999+08:00', window), true);

  // 3. 正好等于 until -> false (排除！硬性契约)
  assert.equal(inWindow('2026-09-10T20:00:00+08:00', window), false);
  assert.equal(inWindow('2026-09-10T12:00:00.000Z', window), false);

  // 4. 早于 since -> false
  assert.equal(inWindow('2026-09-10T07:59:59.999+08:00', window), false);

  // 5. 晚于 until -> false
  assert.equal(inWindow('2026-09-10T20:00:01+08:00', window), false);

  // 6. 非法或空时间 -> false
  assert.equal(inWindow(null, window), false);
  assert.equal(inWindow('invalid-date', window), false);
});

test('resolveTailRecheckWindow: hot run 重查上一 cold 窗口最后 60 分钟', () => {
  const recheck = resolveTailRecheckWindow('hot', '2026-09-10');
  assert.equal(recheck.enabled, true);
  assert.equal(recheck.source_window_id, '2026-09-09T08:00:00+08:00__2026-09-09T20:00:00+08:00');
  assert.equal(recheck.since_bjt, '2026-09-09T19:00:00+08:00');
  assert.equal(recheck.until_bjt, '2026-09-09T20:00:00+08:00');
  assert.equal(recheck.until_unix - recheck.since_unix, 3600);
});

test('resolveTailRecheckWindow: cold run 重查上一 hot 窗口最后 60 分钟', () => {
  const recheck = resolveTailRecheckWindow('cold', '2026-09-10');
  assert.equal(recheck.enabled, true);
  assert.equal(recheck.source_window_id, '2026-09-09T20:00:00+08:00__2026-09-10T08:00:00+08:00');
  assert.equal(recheck.since_bjt, '2026-09-10T07:00:00+08:00');
  assert.equal(recheck.until_bjt, '2026-09-10T08:00:00+08:00');
  assert.equal(recheck.until_unix - recheck.since_unix, 3600);
});

test('checkDelayed: 超过 6 小时判定为 true，否则 false', () => {
  const sched = '2026-09-10T00:30:00.000Z';

  // 延迟 30 分钟 -> false
  assert.equal(checkDelayed(sched, '2026-09-10T01:00:00.000Z'), false);

  // 延迟 5 小时 59 分钟 -> false
  assert.equal(checkDelayed(sched, '2026-09-10T06:29:59.000Z'), false);

  // 正好 6 小时 -> false
  assert.equal(checkDelayed(sched, '2026-09-10T06:30:00.000Z'), false);

  // 超过 6 小时 (6 小时 1 秒) -> true
  assert.equal(checkDelayed(sched, '2026-09-10T06:30:01.000Z'), true);

  // 延迟 8 小时 -> true
  assert.equal(checkDelayed(sched, '2026-09-10T08:30:00.000Z'), true);

  // 非法时间 -> false
  assert.equal(checkDelayed('invalid', 'invalid'), false);
});
