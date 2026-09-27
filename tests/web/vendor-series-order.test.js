'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const orderModule = import(pathToFileURL(path.resolve(__dirname, '../../src/web/js/data/vendor-series-order.mjs')).href);

test('厂商页先按模型系列、工具、套餐分组，再保留一级目录中的组内顺序', async () => {
  const { sortVendorGroups } = await orderModule;
  const groups = [
    { id: 'plan', title: 'Plan', series_kind: 'subscription_series', detail_refs: [] },
    { id: 'old', title: 'Old', series_kind: 'model_series', generation_state: 'previous', detail_refs: [{ id: 'd-new' }] },
    { id: 'tool-b', title: 'Tool B', series_kind: 'tool_series', detail_refs: [] },
    { id: 'undated', title: 'Undated', series_kind: 'model_series', generation_state: 'newest', detail_refs: [{ id: 'd-none' }] },
    { id: 'new', title: 'New', series_kind: 'model_series', generation_state: 'newest', detail_refs: [{ id: 'd-new' }] },
    { id: 'tool-a', title: 'Tool A', series_kind: 'tool_series', detail_refs: [] },
    { id: 'recent', title: 'Recent', series_kind: 'model_series', generation_state: 'newest', detail_refs: [{ id: 'd-recent' }] },
    { id: 'unmarked', title: 'Unmarked', series_kind: 'model_series', detail_refs: [{ id: 'd-latest' }] },
  ];
  const refs = ['old', 'undated', 'recent', 'new', 'unmarked', 'tool-b', 'tool-a', 'plan'].map(id => ({ id }));
  const original = groups.map(group => group.id);
  assert.deepEqual(sortVendorGroups(groups, refs).map(group => group.id),
    ['old', 'undated', 'recent', 'new', 'unmarked', 'tool-b', 'tool-a', 'plan']);
  assert.deepEqual(groups.map(group => group.id), original);
});

test('系列内具体模型按日期倒序，同日按自然名称，无日期排后', async () => {
  const { sortSeriesMembers } = await orderModule;
  const group = { series_kind: 'model_series' };
  const members = [
    { id: 'missing', title: 'Model 9' },
    { id: 'older', title: 'Model 2', release_date: '2026-08-01' },
    { id: 'ten', title: 'Model 10', release_date: '2026-09-01' },
    { id: 'two', title: 'Model 2', release_date: '2026-09-01' },
  ];
  assert.deepEqual(sortSeriesMembers(group, members).map(item => item.id), ['two', 'ten', 'older', 'missing']);
  assert.deepEqual(members.map(item => item.id), ['missing', 'older', 'ten', 'two']);
  assert.deepEqual(sortSeriesMembers({ series_kind: 'subscription_series' }, members), members);
});

test('无 series_kind 的存量 API 模型分组仍按模型系列处理', async () => {
  const { sortVendorGroups, sortSeriesMembers } = await orderModule;
  const details = [
    { id: 'old', detail_kind: 'api_model', title: 'Old', release_date: '2025-02-01' },
    { id: 'new', detail_kind: 'api_model', title: 'New', release_date: '2026-02-01' },
  ];
  const model = { id: 'model', title: 'Models', detail_refs: [{ id: 'old' }, { id: 'new' }] };
  const tool = { id: 'tool', title: 'Tools', series_kind: 'tool_series', detail_refs: [] };
  assert.deepEqual(sortVendorGroups([tool, model], [], details).map(group => group.id), ['model', 'tool']);
  assert.deepEqual(sortSeriesMembers(model, details).map(item => item.id), ['new', 'old']);
});
