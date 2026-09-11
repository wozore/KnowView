/**
 * discovery-executor.js —— X Discovery 关键词发现执行器（T10 模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §4、§5 与 §13.2 契约：
 * 1. 遍历 discovery_queries，使用 discovery 独立预算桶
 * 2. 严格遵守 max_pages 限制（默认 1 页，无 14 天门槛批准不得提升）
 * 3. 预算耗尽时标记 partial(NEWS_BUDGET_EXHAUSTED)，不影响已完成查询
 */

'use strict';

const { buildDiscoveryQuery, generateQueryHash } = require('./query-contract');
const { createPaginationState, advancePagination } = require('./pagination');

/**
 * 标记预算耗尽状态。
 * @private
 */
function markDiscoveryBudgetExhausted(state, outcome) {
  state.status = 'partial';
  state.reason = 'NEWS_BUDGET_EXHAUSTED';
  outcome.status = 'partial';
  outcome.reason = 'NEWS_BUDGET_EXHAUSTED';
}

/**
 * 调度单次 Discovery 页面请求。
 * @private
 * @returns {Promise<boolean>} 是否允许继续调度下一页
 */
async function dispatchDiscoveryPage({
  query,
  state,
  outcome,
  client,
  budgetLedger,
  bucketKey,
}) {
  if (!budgetLedger.canReserve(bucketKey, 300)) {
    markDiscoveryBudgetExhausted(state, outcome);
    return false;
  }

  let reservation = null;
  try {
    reservation = budgetLedger.reserve(bucketKey, 300);
  } catch {
    markDiscoveryBudgetExhausted(state, outcome);
    return false;
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
      return false;
    }

    advancePagination(state, response);
    outcome.next_cursor = state.cursor;
    outcome.status = state.status;
    outcome.reason = state.status === 'complete' ? null : state.reason;
    return true;
  } catch (err) {
    budgetLedger.retainAsUnknown(reservation);
    state.status = 'failed';
    state.reason = err.code || err.message || 'REQUEST_FAILED';
    outcome.status = 'failed';
    outcome.reason = state.reason;
    outcome.errors.push(err.message);
    return false;
  }
}

/**
 * 执行单条 Discovery 查询（含跨页循环）。
 * @private
 */
async function executeSingleDiscoveryQuery(item, window, client, budgetLedger, bucketKey) {
  const query = buildDiscoveryQuery(item, window);
  const queryId = item.id || item.query;
  const maxPages = item.max_pages || 1;
  const state = createPaginationState(maxPages);
  const outcome = {
    query_id: queryId,
    query,
    status: 'pending',
    pages_completed: 0,
    items: [],
    credits_used: 0,
    next_cursor: null,
    reason: null,
    errors: [],
    query_hash: generateQueryHash(query, window),
  };

  while (state.page < state.maxPages && state.status !== 'complete' && state.status !== 'failed') {
    const shouldContinue = await dispatchDiscoveryPage({
      query,
      state,
      outcome,
      client,
      budgetLedger,
      bucketKey,
    });
    if (!shouldContinue) break;
  }

  if (outcome.status === 'pending') {
    outcome.status = state.status === 'complete' ? 'complete' : 'partial';
    outcome.reason = state.reason;
  }
  return outcome;
}

/**
 * 汇总 Discovery 总体状态。
 * @private
 */
function deriveDiscoveryStatus(outcomes, itemCount) {
  let hasFailed = false;
  let hasPartial = false;
  for (const o of outcomes) {
    if (o.status === 'failed') hasFailed = true;
    if (o.status === 'partial') hasPartial = true;
  }

  if (hasFailed && itemCount === 0) {
    return 'failed';
  }
  if (hasFailed || hasPartial) {
    return 'partial';
  }
  return 'complete';
}

/**
 * 执行 Discovery 关键词查询。
 * @param {object} params
 * @param {object[]} params.discoveryQueries
 * @param {object} params.window
 * @param {object} params.client
 * @param {object} params.budgetLedger
 * @param {string} [params.bucketKey='discovery']
 * @returns {Promise<{outcomes: object[], items: object[], status: string}>}
 */
async function executeDiscoveryQueries({
  discoveryQueries,
  window,
  client,
  budgetLedger,
  bucketKey = 'discovery',
}) {
  if (!Array.isArray(discoveryQueries) || discoveryQueries.length === 0) {
    return { outcomes: [], items: [], status: 'complete' };
  }

  const outcomes = [];
  const allItems = [];

  for (const item of discoveryQueries) {
    const outcome = await executeSingleDiscoveryQuery(
      item,
      window,
      client,
      budgetLedger,
      bucketKey
    );
    allItems.push(...outcome.items);
    outcomes.push(outcome);
  }

  const status = deriveDiscoveryStatus(outcomes, allItems.length);
  return { outcomes, items: allItems, status };
}

module.exports = {
  executeDiscoveryQueries,
};
