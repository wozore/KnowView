'use strict';

/**
 * workbench-browser-fixture.test.js — 工作台浏览器验收 fixture 离线回归
 *
 * 覆盖：路由面完整性（scripts/browser-workbench-acceptance.js 触达的 server 路由）、
 * 内存 mutation 生效、revision 递增与陈旧 revision 冲突、实例间状态隔离、
 * 全新实例按相同操作序列可重放（观察轨迹 deep-equal）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixtureWorkbenchService } = require('../fixtures/workbench-browser-service');

test('fixture 覆盖浏览器验收触达的 server 路由方法面', () => {
  const service = createFixtureWorkbenchService();
  const required = [
    'overview', 'config',
    'newsReview', 'reviewNews',
    'keywords', 'applyKeywords', 'discardKeywords', 'generateKeywords',
    'top', 'generateTop', 'resetTop', 'applyTop',
    'publishNews', 'publishPreview',
    'pendingTools', 'pendingConcepts', 'reviewPendingTool',
    'toolUpdates', 'catalogDrafts', 'catalogBundles', 'conceptPreviews',
  ];
  for (const method of required) {
    assert.equal(typeof service[method], 'function', `缺少路由方法 ${method}`);
  }
});

test('fixture 内存 mutation 生效：新闻审核状态流转与计数一致', () => {
  const service = createFixtureWorkbenchService();
  const pending = service.newsReview('pending');
  assert.equal(pending.items.length, 2);
  const approved = service.newsReview('approved');
  assert.equal(approved.items.length, 2);

  const result = service.reviewNews({
    ids: approved.items.map(item => item.id),
    decision: 'pending',
    expected_revision: approved.revision,
  });
  assert.equal(result.ok, true);
  assert.equal(service.newsReview('pending').items.length, 4);
  assert.equal(service.newsReview('approved').items.length, 0);
  assert.equal(service.newsReview('pending').counts.total, 4);
});

test('fixture 每次 mutation 后 revision 递增，陈旧 revision 拒绝写入', () => {
  const service = createFixtureWorkbenchService();
  const before = service.newsReview('pending');
  const stale = before.revision;
  assert.equal(service.reviewNews({ ids: ['fixture-news-1'], decision: 'approved', expected_revision: stale }).ok, true);
  const conflict = service.reviewNews({ ids: ['fixture-news-2'], decision: 'approved', expected_revision: stale });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.equal(service.newsReview('pending').items.length, 1, '冲突写入不生效，剩余待审仍为 1 条');
});

test('fixture Top 生成/选择/重置/发布 mutation 生效且 revision 变化', () => {
  const service = createFixtureWorkbenchService();
  for (const item of service.newsReview('pending').items) {
    assert.equal(service.reviewNews({ ids: [item.id], decision: 'approved', expected_revision: service.newsReview('pending').revision }).ok, true);
  }
  const generated = service.generateTop();
  assert.equal(generated.ok, true);
  assert.equal(generated.count, 4);
  const beforeSelect = service.top().revision;
  const saved = service.applyTop({ ids: generated.candidates.slice(0, 3).map(item => item.id), selected: true, expected_revision: beforeSelect });
  assert.equal(saved.ok, true);
  assert.notEqual(saved.revision, beforeSelect);
  const previewEmpty = service.publishPreview();
  assert.equal(previewEmpty.items.length, 0);
  const published = service.publishNews();
  assert.equal(published.items, 3);
  assert.equal(service.publishPreview().items.length, 3);
  const reset = service.resetTop({ discard_pool: true, expected_revision: service.top().revision });
  assert.equal(reset.ok, true);
  assert.equal(service.top().items.length, 0);
  assert.equal(service.publishPreview().items.length, 3, '丢弃待选池不回滚已发布投影');
});

test('fixture 待补卡批准/丢弃可逆流转，未知 key 拒绝', () => {
  const service = createFixtureWorkbenchService();
  const tools = service.pendingTools();
  assert.equal(tools.items.length, 1);
  const key = tools.items[0].candidate_key;
  assert.equal(service.reviewPendingTool(key, { decision: 'approved', expected_revision: tools.revision }).ok, true);
  assert.equal(service.pendingTools().items[0].review_status, 'approved');
  assert.equal(service.reviewPendingTool(key, { decision: 'discarded', expected_revision: service.pendingTools().revision }).ok, true);
  assert.equal(service.pendingTools().items[0].review_status, 'discarded');
  const missing = service.reviewPendingTool('no-such-key', { decision: 'approved', expected_revision: service.pendingTools().revision });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PENDING_CANDIDATE_NOT_FOUND');
});

test('fixture 关键词采纳/丢弃只影响目标条目', () => {
  const service = createFixtureWorkbenchService();
  const list = service.keywords('content');
  assert.equal(list.items.length, 2);
  const adopted = service.applyKeywords({ ids: ['fixture-kw-1'], expected_revision: list.revision });
  assert.equal(adopted.ok, true);
  assert.equal(service.keywords('content').items.filter(item => item.adopted !== true).length, 1);
  assert.equal(service.generateKeywords({ purpose: 'youtube' }).candidate_count, 0, 'youtube 用途无候选');
});

test('fixture 实例间状态完全隔离（零共享可变状态）', () => {
  const first = createFixtureWorkbenchService();
  const second = createFixtureWorkbenchService();
  first.reviewNews({ ids: first.newsReview('pending').items.map(item => item.id), decision: 'discarded' });
  assert.equal(first.newsReview('pending').items.length, 0);
  assert.equal(second.newsReview('pending').items.length, 2, '另一实例不受影响');
  assert.equal(second.newsReview('pending').revision, 'fixture-rev-1', '另一实例保持初始 revision');
});

test('fixture 重复可重放：相同操作序列在全新实例上产生一致观察轨迹', () => {
  function replay() {
    const service = createFixtureWorkbenchService();
    const trace = [];
    const pending = service.newsReview('pending');
    trace.push({ revision: pending.revision, count: pending.items.length });
    service.reviewNews({ ids: service.newsReview('approved').items.map(item => item.id), decision: 'pending', expected_revision: service.newsReview('approved').revision });
    trace.push(service.newsReview('pending').items.map(item => item.id).sort());
    service.applyKeywords({ ids: ['fixture-kw-1'], expected_revision: service.keywords('content').revision });
    trace.push(service.keywords('content').items.filter(item => item.adopted).map(item => item.id));
    service.generateTop();
    service.applyTop({ ids: service.top().items.slice(0, 2).map(item => item.id), selected: true, expected_revision: service.top().revision });
    trace.push(service.publishNews());
    trace.push(service.publishPreview().items.map(item => item.id));
    return trace;
  }
  assert.deepEqual(replay(), replay());
});
