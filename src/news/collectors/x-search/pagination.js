/**
 * pagination.js —— cursor 分页纯状态机（T2 纯领域模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §5.1 与 §6.1 契约：
 * 状态流转：
 * not_started -> requesting -> page_complete
 * page_complete -> requesting (has_next_page=true 且有新 cursor)
 * page_complete -> complete (has_next_page=false)
 * requesting -> partial (max_pages 达到 / cursor 缺失)
 * requesting -> failed (cursor 重复 / 响应结构异常)
 */

'use strict';

/**
 * 创建初始分页状态对象。
 * @param {number} [maxPages=1] 单次查询最大翻页数
 * @returns {object}
 */
function createPaginationState(maxPages = 1) {
  const safeMax = Number.isFinite(Number(maxPages)) && Number(maxPages) > 0
    ? Math.trunc(Number(maxPages))
    : 1;

  return {
    status: 'not_started',
    page: 0,
    cursor: null,
    seenCursors: new Set(),
    maxPages: safeMax,
    reason: null,
  };
}

/**
 * 根据 Transport 响应更新分页状态。
 * @param {object} state 分页状态
 * @param {object} response Transport 返回的 DTO
 * @returns {object} 推进后的 state
 */
function advancePagination(state, response) {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid pagination state: must be an object');
  }

  // 1. 验证响应 DTO 契约
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray(response.tweets) ||
    typeof response.has_next_page !== 'boolean'
  ) {
    state.status = 'failed';
    state.reason = 'NEWS_INVALID_RESPONSE_DTO';
    return state;
  }

  // 2. 有下一页
  if (response.has_next_page === true) {
    const nextCursor = typeof response.next_cursor === 'string'
      ? response.next_cursor.trim()
      : null;

    if (!nextCursor) {
      state.status = 'partial';
      state.reason = 'NEWS_MISSING_NEXT_CURSOR';
      return state;
    }

    if (state.seenCursors.has(nextCursor)) {
      state.status = 'failed';
      state.reason = 'NEWS_REPEATED_CURSOR';
      return state;
    }

    state.cursor = nextCursor;
    state.seenCursors.add(nextCursor);
    state.page += 1;

    if (state.page >= state.maxPages) {
      state.status = 'partial';
      state.reason = 'NEWS_MAX_PAGES_REACHED';
      return state;
    }

    state.status = 'requesting';
    state.reason = null;
    return state;
  }

  // 3. 无下一页，正常结束
  state.page += 1;
  state.status = 'complete';
  state.reason = null;
  return state;
}

module.exports = {
  createPaginationState,
  advancePagination,
};
