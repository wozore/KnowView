/**
 * x-search-budget.test.js —— X Advanced Search 四桶预算账本纯领域单元测试
 *
 * 运行：node --test tests/news/x-search-budget.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_BUDGET_CAPS,
  BudgetLedger,
  createBudgetLedger,
} = require('../../src/news/collectors/x-search/budget');

test('budget: hot/cold 四桶配置契约与默认分配', () => {
  const hotLedger = createBudgetLedger('hot');
  assert.equal(hotLedger.buckets.account.cap, 5500);
  assert.equal(hotLedger.buckets.discovery.cap, 800);
  assert.equal(hotLedger.buckets.article_retry.cap, 750);
  assert.equal(hotLedger.buckets.tail_recheck.cap, 450);

  const hotDto = hotLedger.toCreditsDto();
  assert.equal(hotDto.total_budget, 7500);
  assert.equal(hotDto.used, 0);

  const coldLedger = createBudgetLedger('cold');
  assert.equal(coldLedger.buckets.account.cap, 1300);
  assert.equal(coldLedger.buckets.discovery.cap, 300);
  assert.equal(coldLedger.buckets.article_retry.cap, 300);
  assert.equal(coldLedger.buckets.tail_recheck.cap, 600);

  const coldDto = coldLedger.toCreditsDto();
  assert.equal(coldDto.total_budget, 2500);
  assert.equal(coldDto.used, 0);
});

test('budget: 单页 300 credits 预占与空响应 15 credits 最低结算', () => {
  const ledger = createBudgetLedger('hot');

  assert.equal(ledger.canReserve('account', 300), true);
  const res = ledger.reserve('account', 300);
  assert.equal(res.bucketKey, 'account');
  assert.equal(res.amount, 300);
  assert.equal(ledger.buckets.account.reserved, 300);
  assert.equal(ledger.buckets.account.settled, 0);

  // 空响应（0 条）：平台最低结算 15 credits
  const { actualCost, overage } = ledger.settle(res, 0);
  assert.equal(actualCost, 15);
  assert.equal(overage, 0);
  assert.equal(ledger.buckets.account.reserved, 0);
  assert.equal(ledger.buckets.account.settled, 15);

  const dto = ledger.toCreditsDto();
  assert.equal(dto.settled, 15);
  assert.equal(dto.reserved, 0);
  assert.equal(dto.used, 15);
});

test('budget: 成功返回按实际条数结算并释放预占', () => {
  const ledger = createBudgetLedger('hot');
  const res = ledger.reserve('account', 300);

  // 返回 10 条推文：10 * 15 = 150 credits
  const { actualCost } = ledger.settle(res, 10);
  assert.equal(actualCost, 150);
  assert.equal(ledger.buckets.account.reserved, 0);
  assert.equal(ledger.buckets.account.settled, 150);
});

test('budget: 超量 20 条响应完整结算并记录 overage', () => {
  const ledger = createBudgetLedger('hot');
  const res = ledger.reserve('account', 300);

  // 返回 25 条推文：25 * 15 = 375 credits，超过 20 条，超量 5 条
  const { actualCost, overage } = ledger.settle(res, 25);
  assert.equal(actualCost, 375);
  assert.equal(overage, 5);
  assert.equal(ledger.buckets.account.overage, 5);
  assert.equal(ledger.buckets.account.settled, 375);

  const dto = ledger.toCreditsDto();
  assert.equal(dto.overage, 5);
  assert.equal(dto.settled, 375);
});

test('budget: 网络异常与超时通过 retainAsUnknown 保留预占，不退回额度', () => {
  const ledger = createBudgetLedger('hot');
  const res = ledger.reserve('account', 300);

  ledger.retainAsUnknown(res);
  assert.equal(ledger.buckets.account.reserved, 0);
  assert.equal(ledger.buckets.account.unknown_reserved, 300);
  assert.equal(ledger.buckets.account.settled, 0);

  const dto = ledger.toCreditsDto();
  assert.equal(dto.unknown_reserved, 300);
  assert.equal(dto.used, 300);

  // 剩余额度应扣除 unknown_reserved：5500 - 300 = 5200
  assert.equal(ledger.canReserve('account', 5200), true);
  assert.equal(ledger.canReserve('account', 5201), false);
});

test('budget: 桶额度不足时阻断预占并抛错', () => {
  const ledger = createBudgetLedger('cold'); // cold discovery 桶上限 300
  assert.equal(ledger.canReserve('discovery', 300), true);

  const res1 = ledger.reserve('discovery', 300);
  assert.equal(ledger.canReserve('discovery', 300), false);

  assert.throws(
    () => ledger.reserve('discovery', 300),
    /BUDGET_EXHAUSTED/
  );
});

test('budget: 桶间绝对隔离，禁止跨桶借用', () => {
  const ledger = createBudgetLedger('cold'); // account 1300, discovery 300
  // discovery 占满
  ledger.reserve('discovery', 300);
  assert.equal(ledger.canReserve('discovery', 1), false);

  // 虽然 account 桶仍有 1300，但 discovery 桶依然无法预占
  assert.equal(ledger.canReserve('account', 300), true);
  assert.equal(ledger.canReserve('discovery', 300), false);
  assert.throws(() => ledger.reserve('discovery', 300), /BUDGET_EXHAUSTED/);
});
