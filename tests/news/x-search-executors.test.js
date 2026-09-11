/**
 * x-search-executors.test.js —— 账号组与关键词执行器轮次公平与尾部重查离线测试
 *
 * 运行：node --test tests/news/x-search-executors.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBudgetLedger } = require('../../src/news/collectors/x-search/budget');
const { executeAccountGroups, executeTailRecheck } = require('../../src/news/collectors/x-search/account-executor');
const { executeDiscoveryQueries } = require('../../src/news/collectors/x-search/discovery-executor');

const MOCK_WINDOW = {
  window_id: 'test_win',
  since_unix: 1788955200,
  until_unix: 1788998400,
};

test('executors: 账号组首轮轮次公平调度（第 1 轮全覆盖再进第 2 轮）', async () => {
  const accountGroups = [
    { id: 'g1', priority: 1, handles: ['OpenAI'], max_pages: 2 },
    { id: 'g2', priority: 2, handles: ['AnthropicAI'], max_pages: 2 },
    { id: 'g7', priority: 7, handles: ['xiaohu'], max_pages: 2, high_frequency: true },
  ];

  const executionOrder = [];
  const client = {
    search: async (query, cursor) => {
      const match = query.match(/from:([^)\s]+)/);
      const handle = match ? match[1] : 'unknown';
      const round = cursor ? 2 : 1;
      executionOrder.push(`${handle}:page_${round}`);
      return {
        tweets: [{ id: `${handle}_${round}` }],
        has_next_page: round === 1,
        next_cursor: round === 1 ? `cursor_${handle}` : null,
      };
    },
  };

  const budget = createBudgetLedger('hot');
  const result = await executeAccountGroups({
    accountGroups,
    window: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  // 严格轮次公平验证：先执行每个组的第 1 页，再执行各组的第 2 页！
  assert.deepEqual(executionOrder, [
    'OpenAI:page_1',
    'AnthropicAI:page_1',
    'xiaohu:page_1',
    'OpenAI:page_2',
    'AnthropicAI:page_2',
    'xiaohu:page_2',
  ]);

  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 6);
  assert.equal(result.outcomes.length, 3);
  for (const o of result.outcomes) {
    assert.equal(o.status, 'complete');
    assert.equal(o.pages_completed, 2);
  }
});

test('executors: 单组网络失败不影响其他组继续执行，失败状态进入 outcomes', async () => {
  const accountGroups = [
    { id: 'g1', priority: 1, handles: ['OpenAI'], max_pages: 1 },
    { id: 'g2_failing', priority: 2, handles: ['BadHandle'], max_pages: 1 },
    { id: 'g3', priority: 3, handles: ['deepseek_ai'], max_pages: 1 },
  ];

  const client = {
    search: async query => {
      if (query.includes('BadHandle')) {
        const err = new Error('HTTP 500');
        err.code = 'NEWS_HTTP_500';
        throw err;
      }
      return { tweets: [{ id: 't1' }], has_next_page: false, next_cursor: null };
    },
  };

  const budget = createBudgetLedger('hot');
  const result = await executeAccountGroups({
    accountGroups,
    window: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  assert.equal(result.status, 'partial', '有失败组且有成功组时总状态为 partial');
  assert.equal(result.items.length, 2, '成功组的 items 正常保留');

  const g2Outcome = result.outcomes.find(o => o.group_id === 'g2_failing');
  assert.equal(g2Outcome.status, 'failed');
  assert.equal(g2Outcome.reason, 'NEWS_HTTP_500');
  assert.equal(budget.buckets.account.unknown_reserved, 300, '失败预占保留在 unknown_reserved');
});

test('executors: 尾部重查在 tail_recheck 桶中执行，预算耗尽标记 partial', async () => {
  // 设置动态重查桶上限 100（不足以执行第二组的 300 预占）
  const budget = createBudgetLedger('hot', { tail_recheck: 100 });
  const accountGroups = [
    { id: 'g1', priority: 1, handles: ['OpenAI'], max_pages: 1 },
    { id: 'g2', priority: 2, handles: ['AnthropicAI'], max_pages: 1 },
  ];

  const client = {
    search: async () => ({ tweets: [], has_next_page: false, next_cursor: null }),
  };

  const result = await executeTailRecheck({
    accountGroups,
    tailRecheckWindow: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  assert.equal(result.status, 'partial');
  const g1Outcome = result.outcomes.find(o => o.group_id === 'g1');
  assert.equal(g1Outcome.status, 'partial');
  assert.equal(g1Outcome.reason, 'NEWS_BUDGET_EXHAUSTED');
});

test('executors: Discovery 查询执行器遵循 max_pages 与独立预算桶', async () => {
  const discoveryQueries = [
    { id: 'd1', query: 'AI model release', max_pages: 1 },
    { id: 'd2', query: 'LLM reasoning paper', max_pages: 1 },
  ];

  const client = {
    search: async () => ({
      tweets: [{ id: 'tweet_disc_1' }],
      has_next_page: false,
      next_cursor: null,
    }),
  };

  const budget = createBudgetLedger('hot');
  const result = await executeDiscoveryQueries({
    discoveryQueries,
    window: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 2);
  assert.equal(result.outcomes.length, 2);
  assert.equal(budget.buckets.discovery.settled, 30, '两条各返回 1 条，结算 2*15=30');
  assert.equal(budget.buckets.account.settled, 0, '未触碰 account 桶');
});

test('executors: 账号组单页返回 > 20 条触发 overage 止损，停止该组后续翻页并标记 NEWS_OVERAGE_STOP', async () => {
  const accountGroups = [
    { id: 'g_overage', priority: 1, handles: ['OpenAI'], max_pages: 3 },
    { id: 'g_normal', priority: 2, handles: ['AnthropicAI'], max_pages: 1 },
  ];

  let overageGroupCalls = 0;
  let normalGroupCalls = 0;

  const client = {
    search: async (query, cursor) => {
      if (query.includes('OpenAI')) {
        overageGroupCalls += 1;
        // 模拟超量返回 25 条（超出单页上限 20 条）
        const tweets = Array.from({ length: 25 }, (_, i) => ({ id: `openai_${i}` }));
        return {
          tweets,
          has_next_page: true,
          next_cursor: 'cursor_page_2',
        };
      }
      normalGroupCalls += 1;
      return {
        tweets: [{ id: 'anthropic_1' }],
        has_next_page: false,
        next_cursor: null,
      };
    },
  };

  const budget = createBudgetLedger('hot');
  const result = await executeAccountGroups({
    accountGroups,
    window: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  // 1. 验证 overage 组只执行了 1 次，第 2/3 页被立即止损阻断
  assert.equal(overageGroupCalls, 1, '超量响应后立即停止后续翻页');
  assert.equal(normalGroupCalls, 1, '其他组正常执行');

  // 2. 验证 overage 组 outcome 状态与原因
  const overageOutcome = result.outcomes.find(o => o.group_id === 'g_overage');
  assert.equal(overageOutcome.status, 'partial');
  assert.equal(overageOutcome.reason, 'NEWS_OVERAGE_STOP');
  assert.equal(overageOutcome.pages_completed, 1);
  assert.equal(overageOutcome.items.length, 25, '超量返回的 items 依然完整保留');
  assert.equal(overageOutcome.credits_used, 25 * 15, '按实际 25 条结算 375 credits');

  // 3. 验证预算账本中的 overage 累加
  assert.equal(budget.buckets.account.overage, 5);

  // 4. 总体状态为 partial
  assert.equal(result.status, 'partial');
});

test('executors: Discovery 查询单页返回 > 20 条触发 overage 止损，停止后续翻页并标记 NEWS_OVERAGE_STOP', async () => {
  const discoveryQueries = [
    { id: 'd_overage', query: 'AI model release', max_pages: 3 },
  ];

  let queryCalls = 0;
  const client = {
    search: async () => {
      queryCalls += 1;
      // 模拟超量返回 22 条
      const tweets = Array.from({ length: 22 }, (_, i) => ({ id: `disc_${i}` }));
      return {
        tweets,
        has_next_page: true,
        next_cursor: 'cursor_disc_2',
      };
    },
  };

  const budget = createBudgetLedger('hot');
  const result = await executeDiscoveryQueries({
    discoveryQueries,
    window: MOCK_WINDOW,
    client,
    budgetLedger: budget,
  });

  assert.equal(queryCalls, 1, 'Discovery 超量响应后立即停止后续翻页');
  assert.equal(result.status, 'partial');
  assert.equal(result.outcomes.length, 1);

  const outcome = result.outcomes[0];
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.reason, 'NEWS_OVERAGE_STOP');
  assert.equal(outcome.pages_completed, 1);
  assert.equal(outcome.items.length, 22);
  assert.equal(outcome.credits_used, 22 * 15);
  assert.equal(budget.buckets.discovery.overage, 2);
});
