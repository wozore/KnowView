/**
 * account-executor.js —— 账号组轮次公平调度与尾部重查执行器（T10 模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §6.2 与 §6.3 契约：
 * 1. 账号组轮次公平：第一轮所有组各执行第 1 页，第二轮轮转后续页
 * 2. 单组失败/超限不影响其他组，记录 outcome 继续执行
 * 3. 预算桶耗尽时对剩余组标记 partial(NEWS_BUDGET_EXHAUSTED)
 * 4. 尾部重查执行器：对 7 个账号组在 tail_recheck 桶中执行上一逻辑窗口尾部 60 分钟查询
 */

'use strict';

const { buildAccountGroupQuery, generateQueryHash } = require('./query-contract');
const { createPaginationState, advancePagination } = require('./pagination');

/**
 * 标记账号组预算耗尽状态。
 * @private
 */
function markGroupBudgetExhausted(state, outcome) {
  state.status = 'partial';
  state.reason = 'NEWS_BUDGET_EXHAUSTED';
  outcome.status = 'partial';
  outcome.reason = 'NEWS_BUDGET_EXHAUSTED';
}

/**
 * 调度单次页面请求。
 * @private
 */
async function dispatchGroupPage({
  group,
  query,
  state,
  outcome,
  client,
  budgetLedger,
  bucketKey,
}) {
  if (!budgetLedger.canReserve(bucketKey, 300)) {
    markGroupBudgetExhausted(state, outcome);
    return;
  }

  let reservation = null;
  try {
    reservation = budgetLedger.reserve(bucketKey, 300);
  } catch {
    markGroupBudgetExhausted(state, outcome);
    return;
  }

  try {
    const response = await client.search(query, state.cursor, {
      beforeAttempt: attempt => {
        if (attempt === 0) return true;
        try {
          reservation = budgetLedger.reserve(bucketKey, 300, { isRetry: true });
          return true;
        } catch {
          return false;
        }
      },
      onAttemptFailure: () => budgetLedger.retainAsUnknown(reservation),
    });
    const returnedCount = response.tweets.length;
    const settlement = budgetLedger.settle(reservation, returnedCount);

    outcome.credits_used += settlement.actualCost;
    outcome.items.push(...response.tweets);
    outcome.pages_completed += 1;

    if (settlement.overage > 0) {
      state.page += 1;
      state.status = 'partial';
      state.reason = 'NEWS_OVERAGE_STOP';
      outcome.status = 'partial';
      outcome.reason = 'NEWS_OVERAGE_STOP';
      return;
    }

    advancePagination(state, response);
    outcome.next_cursor = state.cursor;
    outcome.status = state.status;
    outcome.reason = state.status === 'complete' ? null : state.reason;
  } catch (err) {
    budgetLedger.retainAsUnknown(reservation);
    state.status = 'failed';
    state.reason = err.code || err.message || 'REQUEST_FAILED';
    outcome.status = 'failed';
    outcome.reason = state.reason;
    outcome.errors.push(err.message);
  }
}

/**
 * 账号组轮次公平调度执行器。
 * @param {object} params
 * @param {object[]} params.accountGroups 账号组配置数组
 * @param {object} params.window 采集时间窗口
 * @param {object} params.client AdvancedSearchClient 实例
 * @param {object} params.budgetLedger BudgetLedger 实例
 * @param {string} [params.bucketKey='account']
 * @returns {Promise<{outcomes: object[], items: object[], status: string}>}
 */
/**
 * 初始化账号组查询语句、分页状态与 outcome 映射。
 * @private
 */
function initAccountGroupState(sorted, window) {
  const queries = new Map();
  const paginations = new Map();
  const outcomes = new Map();

  for (const g of sorted) {
    const query = buildAccountGroupQuery(g, window);
    queries.set(g.id, query);
    paginations.set(g.id, createPaginationState(g.max_pages || 1));
    outcomes.set(g.id, {
      group_id: g.id,
      priority: g.priority ?? 999,
      status: 'pending',
      pages_completed: 0,
      items: [],
      credits_used: 0,
      next_cursor: null,
      reason: null,
      errors: [],
      query_hash: generateQueryHash(query, window),
    });
  }

  return { queries, paginations, outcomes };
}

/**
 * 汇聚各账号组执行结果与总体状态。
 * @private
 */
function aggregateGroupResults(outcomes, paginations) {
  const allItems = [];
  let hasFailed = false;
  let hasPartial = false;

  for (const outcome of outcomes.values()) {
    if (outcome.status === 'pending') {
      const state = paginations.get(outcome.group_id);
      outcome.status = state.status === 'complete' ? 'complete' : 'partial';
      outcome.reason = state.reason;
    }
    if (outcome.status === 'failed') hasFailed = true;
    if (outcome.status === 'partial') hasPartial = true;
    allItems.push(...outcome.items);
  }

  let status = 'complete';
  if (hasFailed && allItems.length === 0) {
    status = 'failed';
  } else if (hasFailed || hasPartial) {
    status = 'partial';
  }

  return {
    outcomes: [...outcomes.values()],
    items: allItems,
    status,
  };
}

/**
 * 账号组轮次公平调度执行器。
 * @param {object} params
 * @param {object[]} params.accountGroups 账号组配置数组
 * @param {object} params.window 采集时间窗口
 * @param {object} params.client AdvancedSearchClient 实例
 * @param {object} params.budgetLedger BudgetLedger 实例
 * @param {string} [params.bucketKey='account']
 * @returns {Promise<{outcomes: object[], items: object[], status: string}>}
 */
async function executeAccountGroups({
  accountGroups,
  window,
  client,
  budgetLedger,
  bucketKey = 'account',
}) {
  if (!Array.isArray(accountGroups)) {
    throw new Error('accountGroups must be an array');
  }

  const sorted = [...accountGroups].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const { queries, paginations, outcomes } = initAccountGroupState(sorted, window);
  const maxRounds = Math.max(1, ...sorted.map(g => g.max_pages || 1));

  for (let round = 1; round <= maxRounds; round++) {
    for (const group of sorted) {
      const state = paginations.get(group.id);
      const outcome = outcomes.get(group.id);

      if (state.status === 'complete' || state.status === 'failed') continue;
      if (state.status === 'partial') continue;
      if (state.page >= state.maxPages) continue;

      await dispatchGroupPage({
        group,
        query: queries.get(group.id),
        state,
        outcome,
        client,
        budgetLedger,
        bucketKey,
      });
    }
  }

  return aggregateGroupResults(outcomes, paginations);
}

/**
 * 尾部重查执行器：复用轮次调度，在 tail_recheck 桶中执行。
 * @param {object} params
 * @param {object[]} params.accountGroups 7 个账号组配置
 * @param {object} params.tailRecheckWindow 尾部重查时间窗口
 * @param {object} params.client
 * @param {object} params.budgetLedger
 * @returns {Promise<{outcomes: object[], items: object[], status: string}>}
 */
async function executeTailRecheck({
  accountGroups,
  tailRecheckWindow,
  client,
  budgetLedger,
}) {
  return await executeAccountGroups({
    accountGroups,
    window: tailRecheckWindow,
    client,
    budgetLedger,
    bucketKey: 'tail_recheck',
  });
}

module.exports = {
  executeAccountGroups,
  executeTailRecheck,
};
