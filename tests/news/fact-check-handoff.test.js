'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFactCheckBatch,
  fingerprintOf,
  isFactCheckCandidate,
  importFactCheckResults,
} = require('../../src/news/min/fact-check-handoff');
const { runFactCheckCommand } = require('../../src/news/cli/min-review-flows');

function pending(id, options = {}) {
  return {
    id,
    review_status: options.reviewStatus || 'pending',
    title: `AI 新闻 ${id}`,
    url: `https://example.com/${id}`,
    description: '介绍一项近期模型发布事实。',
    final_score: options.score || 50,
    l1_review: { verdict: 'hold' },
    ai_advice: {
      verdict: options.verdict || 'hold',
      generated_at: '2026-09-27T00:00:00.000Z',
      reasons: ['发布事实尚待核实'],
      ...(options.needed ? { fact_check: { needed: true, claim: '该模型已经正式发布', query: '模型正式发布' } } : {}),
      ...(options.error ? { web_verification: { search_error: options.error } } : {}),
      ...(options.completed ? { web_verification: { status: 'completed', sources: [] } } : {}),
    },
  };
}

test('批次只导出明确查证项和历史搜索错误，且限制为 10 条', () => {
  const store = {
    schema_version: 1,
    candidates: [
      pending('new', { needed: true, score: 99 }),
      pending('approve-needs-fact-check', { needed: true, verdict: 'approve', score: 95 }),
      pending('old-a', { error: 'RATE_LIMITED', score: 90 }),
      pending('no-check', { score: 100 }),
      pending('done', { error: 'RATE_LIMITED', completed: true }),
      pending('approved', { error: 'RATE_LIMITED', reviewStatus: 'approved' }),
      ...Array.from({ length: 12 }, (_, index) => pending(`old-${index}`, { error: 'RATE_LIMITED', score: index })),
    ],
  };
  const batch = createFactCheckBatch(store, { limit: 10 });
  assert.equal(batch.kind, 'news_fact_check_batch');
  assert.equal(batch.mode, 'codex_mcp');
  assert.equal(batch.task_count, 2, '默认队列包含任何 verdict 明确标记的关键事实');
  assert.equal(batch.tasks[0].id, 'new');
  assert.equal(batch.tasks[1].id, 'approve-needs-fact-check');
  assert.ok(batch.tasks.every(task => task.fingerprint.length === 64));
  const history = createFactCheckBatch(store, { limit: 10, includeHistorical: true });
  assert.equal(history.task_count, 10);
  assert.equal(history.tasks.find(task => task.id === 'old-a').source, 'historical_search_failure');
  assert.throws(() => createFactCheckBatch(store, { limit: 11 }), /1–10/);
});

test('min-review 查证命令导出候选批次并经 guarded commit 导入结果', async () => {
  const candidate = pending('cli-pilot', { error: 'RATE_LIMITED' });
  const store = { schema_version: 1, candidates: [candidate] };
  const config = { review: { fact_check_mode: 'codex_mcp' } };
  const batch = await runFactCheckCommand('fact-check-list', { limit: 1, include_history: true }, config, { readStore: () => store });
  assert.equal(batch.task_count, 1);
  const payload = {
    schema_version: 1,
    kind: 'news_fact_check_results',
    mode: 'codex_mcp',
    search_tool: 'webSearchPrime',
    batch_id: batch.batch_id,
    results: [{
      id: candidate.id,
      fingerprint: batch.tasks[0].fingerprint,
      source: batch.tasks[0].source,
      conclusion: 'inconclusive',
      summary: '现有来源不足以确认。',
      sources: [],
    }],
  };
  let expectedRevision;
  const imported = await runFactCheckCommand('fact-check-import', { file: 'result.json' }, config, {
    readStore: () => store,
    readJson: () => payload,
    revisionOfMinStore: () => 'revision-before-import',
    commitMinStoreMutation: (mutation, options) => {
      expectedRevision = options.expectedRevision;
      return { ...mutation(store), changed: true, revision: 'revision-after-import' };
    },
  });
  assert.equal(expectedRevision, 'revision-before-import');
  assert.equal(imported.imported, 1);
  assert.equal(imported.store, undefined);
  assert.equal(candidate.review_status, 'pending');
  await assert.rejects(() => runFactCheckCommand('fact-check-list', {}, { review: { fact_check_mode: 'off' } }), /codex_mcp/);
});

test('L2 重筛只改写 Tavily 失败项，失败保留原建议，并区分是否需要联网', async () => {
  const needed = pending('screen-needed', { error: 'TAVILY_SEARCH_FAILED' });
  const noSearch = pending('screen-no-search', { error: 'TAVILY_SEARCH_FAILED' });
  const failed = pending('screen-failed', { error: 'TAVILY_SEARCH_FAILED' });
  const otherProvider = pending('screen-other', { error: 'ZHIPU_WEB_SEARCH_RATE_LIMITED' });
  const store = { schema_version: 1, candidates: [needed, noSearch, failed, otherProvider] };
  const config = { review: { fact_check_mode: 'codex_mcp', l2_enabled: true } };
  const result = await runFactCheckCommand('fact-check-rescreen', { limit: 10 }, config, {
    readStore: () => store,
    revisionOfMinStore: () => 'before',
    reviewCandidate: async item => {
      if (item.id === 'screen-needed') return { verdict: 'hold', reasons: ['核实发布事实'], fact_check: { needed: true, claim: '该模型已经在官方渠道正式发布', query: '模型发布' } };
      if (item.id === 'screen-no-search') return { verdict: 'hold', reasons: ['主题重复'], fact_check: { needed: false, claim: '', query: '' } };
      return { verdict: null, llm_error: 'temporary failure' };
    },
    commitMinStoreMutation: mutation => mutation(store),
  });
  assert.deepEqual(result, {
    selected: 3, updated: 2, fact_check_needed: 1, no_search_needed: 1, failed: 1,
    failed_marked: 1,
    failed_ids: ['screen-failed'], errors: [{ id: 'screen-failed', error: 'temporary failure' }],
  });
  assert.equal(needed.review_status, 'pending');
  assert.equal(needed.l1_review.verdict, 'hold');
  assert.equal(needed.ai_advice.web_verification.status, 'awaiting_agent');
  assert.equal(noSearch.ai_advice.web_verification, undefined);
  assert.equal(failed.ai_advice.web_verification.search_error, 'TAVILY_SEARCH_FAILED');
  assert.equal(failed.fact_check_rescreen.status, 'failed');
  assert.equal(isFactCheckCandidate(failed), false);
  assert.equal(otherProvider.ai_advice.web_verification.search_error, 'ZHIPU_WEB_SEARCH_RATE_LIMITED');
  const nextBatch = await runFactCheckCommand('fact-check-rescreen', { limit: 10 }, config, {
    readStore: () => store,
    reviewCandidate: async () => { throw new Error('不应自动重试失败项'); },
  });
  assert.equal(nextBatch.selected, 0, '失败记录标记后不会阻塞后续批次或自动重试');
  const retried = await runFactCheckCommand('fact-check-rescreen', { ids: ['screen-failed'], limit: 1 }, config, {
    readStore: () => store,
    revisionOfMinStore: () => 'before',
    reviewCandidate: async () => ({ verdict: 'hold', fact_check: { needed: true, claim: '该服务已经正式上线发布', query: '服务上线' } }),
    commitMinStoreMutation: mutation => mutation(store),
  });
  assert.equal(retried.updated, 1);
  assert.equal(failed.fact_check_rescreen, undefined);
  assert.equal(failed.ai_advice.web_verification.status, 'awaiting_agent');
});

test('结果导入保留待审状态，仅附查证结论和来源', () => {
  const candidate = pending('pilot-1', { error: 'RATE_LIMITED' });
  const store = { schema_version: 1, candidates: [candidate] };
  const result = importFactCheckResults(store, {
    schema_version: 1,
    kind: 'news_fact_check_results',
    mode: 'codex_mcp',
    search_tool: 'webSearchPrime',
    batch_id: 'pilot-batch',
    results: [{
      id: candidate.id,
      fingerprint: fingerprintOf(candidate),
      source: 'historical_search_failure',
      conclusion: 'supports',
      summary: '官方公告确认已发布。',
      sources: [{ title: '官方公告', url: 'https://example.com/announcement', excerpt: '已正式发布。' }],
    }],
  }, { now: '2026-09-27T01:00:00.000Z' });
  assert.equal(result.imported, 1);
  assert.equal(candidate.review_status, 'pending');
  assert.equal(candidate.reviewed_at, undefined);
  assert.equal(candidate.ai_advice.verdict, 'hold');
  assert.equal(candidate.ai_advice.web_verification.status, 'completed');
  assert.equal(candidate.ai_advice.web_verification.conclusion, 'supports');
  assert.equal(candidate.ai_advice.web_verification.sources[0].url, 'https://example.com/announcement');
});

test('通过建议的事实查证导入支持证据后刷新门禁预演，但不改审核状态', () => {
  const candidate = pending('approve-pilot', { needed: true, verdict: 'approve' });
  candidate.ai_advice.assessment = {
    topic_relevance: 'in_scope',
    subject_clarity: 'specific',
    information_value: 'substantive',
    source_quality: 'unknown',
    evidence_status: 'needs_fact_check',
    decision_basis: 'unverified_fact',
  };
  const store = { schema_version: 1, candidates: [candidate] };
  const result = importFactCheckResults(store, {
    schema_version: 1,
    kind: 'news_fact_check_results',
    mode: 'codex_mcp',
    search_tool: 'webSearchPrime',
    batch_id: 'approve-pilot-batch',
    results: [{
      id: candidate.id,
      fingerprint: fingerprintOf(candidate),
      source: 'l2_fact_check',
      conclusion: 'supports',
      summary: '可追溯来源支持该主张。',
      sources: [{ title: '发布公告', url: 'https://example.com/announcement', excerpt: '正式发布。' }],
    }],
  }, { now: '2026-09-28T01:00:00.000Z' });
  assert.equal(result.imported, 1);
  assert.equal(candidate.review_status, 'pending');
  assert.equal(candidate.ai_advice.verdict, 'approve');
  assert.deepEqual(candidate.ai_advice.assessment_gate_preview, {
    action: 'approve_candidate', reason: 'criteria_satisfied',
  });
});

test('过期指纹、重复 ID、无来源结论和危险 URL 都会拒绝且不改数据', () => {
  const candidate = pending('pilot-2', { error: 'RATE_LIMITED' });
  const store = { schema_version: 1, candidates: [candidate] };
  const base = {
    schema_version: 1,
    kind: 'news_fact_check_results',
    mode: 'codex_mcp',
    search_tool: 'webSearchPrime',
    batch_id: 'pilot-batch',
    results: [{ id: candidate.id, fingerprint: fingerprintOf(candidate), source: 'historical_search_failure', conclusion: 'supports', sources: [{ title: 'source', url: 'https://example.com' }] }],
  };
  assert.throws(() => importFactCheckResults(store, { ...base, results: [{ ...base.results[0], fingerprint: '0'.repeat(64) }] }), /已变化/);
  assert.throws(() => importFactCheckResults(store, { ...base, results: [...base.results, ...base.results] }), /重复/);
  assert.throws(() => importFactCheckResults(store, { ...base, results: [{ ...base.results[0], sources: [] }] }), /必须附来源/);
  assert.throws(() => importFactCheckResults(store, { ...base, results: [{ ...base.results[0], sources: [{ title: 'unsafe', url: 'javascript:alert(1)' }] }] }), /HTTP\(S\)/);
  assert.throws(() => importFactCheckResults(store, { ...base, unexpected: true }), /不支持的字段/);
  assert.equal(candidate.ai_advice.web_verification.search_error, 'RATE_LIMITED');
  assert.equal(candidate.ai_advice.web_verification.status, undefined);
});
