/**
 * x-search-pagination.test.js —— cursor 分页状态机纯领域单元测试
 *
 * 运行：node --test tests/news/x-search-pagination.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPaginationState,
  advancePagination,
} = require('../../src/news/collectors/x-search/pagination');

test('pagination: 单页查询无下一页直接 complete', () => {
  const state = createPaginationState(1);
  assert.equal(state.status, 'not_started');
  assert.equal(state.page, 0);

  const res = { tweets: [{ id: '1' }], has_next_page: false, next_cursor: null };
  const updated = advancePagination(state, res);

  assert.equal(updated.status, 'complete');
  assert.equal(updated.page, 1);
  assert.equal(updated.cursor, null);
  assert.equal(updated.reason, null);
});

test('pagination: 多页正常推进到下一页', () => {
  const state = createPaginationState(2);
  const page1 = { tweets: [{ id: '1' }], has_next_page: true, next_cursor: 'cursor_page_2' };
  advancePagination(state, page1);

  assert.equal(state.status, 'requesting');
  assert.equal(state.page, 1);
  assert.equal(state.cursor, 'cursor_page_2');
  assert.equal(state.seenCursors.has('cursor_page_2'), true);

  const page2 = { tweets: [{ id: '2' }], has_next_page: false, next_cursor: null };
  advancePagination(state, page2);

  assert.equal(state.status, 'complete');
  assert.equal(state.page, 2);
});

test('pagination: 达到 max_pages 限制时标记 partial MAX_PAGES_REACHED', () => {
  const state = createPaginationState(1); // 仅允许 1 页
  const page1 = { tweets: [{ id: '1' }], has_next_page: true, next_cursor: 'cursor_2' };
  advancePagination(state, page1);

  assert.equal(state.status, 'partial');
  assert.equal(state.reason, 'NEWS_MAX_PAGES_REACHED');
  assert.equal(state.page, 1);
  assert.equal(state.cursor, 'cursor_2');
});

test('pagination: has_next_page=true 但 cursor 缺失或空标记 partial MISSING_NEXT_CURSOR', () => {
  const state = createPaginationState(2);
  const badResponse = { tweets: [{ id: '1' }], has_next_page: true, next_cursor: null };
  advancePagination(state, badResponse);

  assert.equal(state.status, 'partial');
  assert.equal(state.reason, 'NEWS_MISSING_NEXT_CURSOR');
});

test('pagination: 重复 cursor 阻断死循环标记 failed REPEATED_CURSOR', () => {
  const state = createPaginationState(5);
  advancePagination(state, { tweets: [{ id: '1' }], has_next_page: true, next_cursor: 'same_cursor' });
  assert.equal(state.status, 'requesting');

  // 第二页返回完全相同的 cursor
  advancePagination(state, { tweets: [{ id: '2' }], has_next_page: true, next_cursor: 'same_cursor' });
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'NEWS_REPEATED_CURSOR');
});

test('pagination: 响应结构不满足契约标记 failed INVALID_RESPONSE_DTO', () => {
  const state = createPaginationState(2);

  // tweets 不是数组
  advancePagination(state, { tweets: null, has_next_page: false });
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'NEWS_INVALID_RESPONSE_DTO');

  // has_next_page 不是布尔值
  const state2 = createPaginationState(2);
  advancePagination(state2, { tweets: [], has_next_page: 'true' });
  assert.equal(state2.status, 'failed');
  assert.equal(state2.reason, 'NEWS_INVALID_RESPONSE_DTO');
});
