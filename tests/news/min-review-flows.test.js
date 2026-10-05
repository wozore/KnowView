'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRepairFlow } = require('../../src/news/cli/min-review-flows');

test('structured L1 rescreen requires explicit IDs, limit, and review-only stages', async () => {
  const store = { candidates: [{
    id: 'one', review_status: 'pending', l1_review: { verdict: 'hold' },
  }] };
  const config = { collection: {}, review: {} };
  const base = {
    rescreen_structured: true,
    skip_summary: true,
    skip_localize: true,
    limit: 1,
  };
  await assert.rejects(() => runRepairFlow(store, config, base), /明确的 --ids/);
  await assert.rejects(() => runRepairFlow(store, config, { ...base, ids: 'one', limit: 0 }), /1 到 --ids 条数/);
  await assert.rejects(() => runRepairFlow(store, config, {
    ...base, ids: 'one', skip_summary: false,
  }), /仅运行初审/);
});

test('structured L1 rescreen rejects reviewed or non-pending records before starting calls', async () => {
  const store = { candidates: [{
    id: 'human-reviewed', review_status: 'pending', reviewed_at: '2026-09-28T00:00:00Z',
    l1_review: { verdict: 'hold' },
  }] };
  await assert.rejects(() => runRepairFlow(store, { collection: {}, review: {} }, {
    rescreen_structured: true,
    ids: 'human-reviewed', limit: 1,
    skip_summary: true, skip_localize: true, no_refresh_review_list: true,
  }), /只接受未人工定案且缺少完整 L1 结论的 pending 候选/);
});
