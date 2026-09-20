'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createMaintainerWorkbenchService } = require('../../src/maintenance/maintainer-workbench-service');

function serviceWith(state) {
  const os = require('os');
  const path = require('path');
  return createMaintainerWorkbenchService({
    // 注入不存在的临时 topFile，避免读取真实 data/manual/top.json 使测试非幂等。
    topFile: path.join(os.tmpdir(), 'knowview-wb-no-top.json'),
    newsApi: {
      readStore: () => state.store, revisionOfStore: () => 'news-r1',
      commit: (mutation, options) => { state.commits.push(options); const result = mutation(state.store); state.store = result.store; return { ...result, revision: 'news-r2' }; },
      reviewMutation: (store, ids, decision) => ({ store, updated: ids.length, missing: [], not_pending: [], changed: ids.length, decision }),
      topMutation: (store, ids, selected) => ({ store, updated: ids.length, missing: [], not_approved: [], changed: ids.length, selected }),
      readKeywords: () => ({ candidates: [{ id: 'kw', word: 'AI' }] }), readConfig: () => ({}), revisionOfConfig: () => 'keyword-r1',
      commitKeywords: (list, options) => ({ list, before_revision: options.expectedRevision, revision: 'keyword-r2' }),
    },
    toolsApi: { readQueue: () => ({ revision: 'tool-r1', items: [{ review_status: 'pending' }] }), review: request => ({ ok: true, ...request, revision: 'tool-r2' }) },
    conceptsApi: { readPreviews: () => ({ cards: [{ term: 'RAG' }] }) },
  });
}

test('GET projections include revisions and items without commits', () => {
  const state = { store: { candidates: [{ id: 'p', review_status: 'pending', l1_review: { verdict: 'hold' } }, { id: 'a', review_status: 'approved', top_selected: true }] }, commits: [] };
  const service = serviceWith(state);
  assert.deepEqual(service.newsReview(), { revision: 'news-r1', items: [state.store.candidates[0]] });
  assert.equal(service.top().items.length, 0); // 无 top.json 时返回空池
  assert.match(service.top().note, /尚未生成 Top 待选池/);
  assert.deepEqual(service.keywords(), { revision: 'keyword-r1', items: [{ id: 'kw', word: 'AI', adopted: false, discarded: false }] });
  const conceptPreview = service.conceptPreviews();
  assert.deepEqual(conceptPreview.items, [{ term: 'RAG' }]);
  assert.equal(conceptPreview.status, 'legacy_preview');
  assert.equal(state.commits.length, 0);
});

test('newsReview() 在有未完成初审条目时返回 enriching 锁定状态与门禁统计', () => {
  const state = { store: { candidates: [{ id: 'raw', review_status: 'pending' }, { id: 'done', review_status: 'pending', l1_review: { verdict: 'hold' } }] }, commits: [] };
  const service = serviceWith(state);
  const res = service.newsReview();
  assert.equal(res.status, 'enriching');
  assert.equal(res.unreviewed_count, 1);
  assert.equal(res.items.length, 0);
  assert.match(res.message, /本地 Bonsai 正在进行 AI 初审分流与汉化/);
});

test('newsReview() 不因失败的 ai_advice 外壳解除门禁', () => {
  const state = {
    store: {
      candidates: [{
        id: 'failed',
        review_status: 'pending',
        ai_advice: { verdict: null, reasons: [], llm_error: 'timeout' },
      }],
    },
    commits: [],
  };
  const res = serviceWith(state).newsReview();
  assert.equal(res.status, 'enriching');
  assert.equal(res.unreviewed_count, 1);
  assert.equal(res.items.length, 0);
});

test('top() 只返回 top.json 池内且已 approved 的项', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-top-'));
  const topFile = path.join(dir, 'top.json');
  fs.writeFileSync(topFile, JSON.stringify({ kind: 'ai_top_candidates', candidates: [
    { id: 'a', summary: '选中的 approved 项' },
    { id: 'nope', summary: '不在候选层' },
  ] }));
  const state = { store: { candidates: [{ id: 'a', review_status: 'approved', top_selected: true, title: 'A', localizations: { zh: { title: '甲' } } }] }, commits: [] };
  const service = createMaintainerWorkbenchService({
    topFile,
    newsApi: { readStore: () => state.store, revisionOfStore: () => 'news-r1', commit: () => ({}), reviewMutation: () => ({ store: state.store, updated: 0 }), topMutation: () => ({ store: state.store, updated: 0 }), readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'k', commitKeywords: () => ({}) },
    toolsApi: { readQueue: () => ({ revision: 't', items: [] }), review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  const top = service.top();
  assert.equal(top.items.length, 1);
  assert.equal(top.items[0].id, 'a');
  assert.equal(top.items[0].title, '甲'); // 汉化优先
  assert.equal(top.items[0].top_selected, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toolUpdates separates latest current pending items from historical evidence', () => {
  const source = { kind: 'changelog', url: 'https://example.com/changelog', collector: 'tavily_extract', product_surface: 'product' };
  const registry = { products: { sample: { name: 'Sample', update_sources: [source] } } };
  const oldItem = { candidate_key: 'old', product_key: 'sample', source_url: source.url, collector: source.collector, proposed_date: '2026-08-20', status: 'candidate', review_status: 'approved', blocked_reasons: [], evidence: {} };
  const newItem = { candidate_key: 'new', product_key: 'sample', source_url: source.url, collector: source.collector, proposed_date: '2026-08-22', status: 'blocked', review_status: 'pending', blocked_reasons: ['EVIDENCE_DATE_MISSING'], evidence: {} };
  const service = createMaintainerWorkbenchService({
    newsApi: { readStore: () => ({ candidates: [] }), revisionOfStore: () => 'n', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}), readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'k', commitKeywords: () => ({}) },
    toolsApi: { readQueue: () => ({ revision: 'tool-r1', items: [oldItem, newItem] }), readRegistry: () => registry, review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  const result = service.toolUpdates();
  assert.deepEqual(result.items.map(item => item.candidate_key), ['new']);
  assert.deepEqual(result.history.map(item => item.candidate_key), ['old']);
  assert.equal(result.history[0].history_reason, 'newer_evidence');
  assert.equal(service.overview().tool_updates.pending, 1);
});
test('工作台后续动作仅在首审完成且保留底层确认参数', async () => {
  const state = { store: { candidates: [{ id: 'a', review_status: 'approved', top_selected: true }] } };
  const calls = [];
  const service = createMaintainerWorkbenchService({
    newsApi: {
      readStore: () => state.store, revisionOfStore: () => 'news-r1', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}),
      readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'keywords-r1', commitKeywords: () => ({}),
      generateKeywords: async () => { calls.push('keywords'); return { candidates: ['AI'] }; }, generateTop: async () => { calls.push('top'); return { candidates: [{ id: 'a' }] }; }, publish: () => { calls.push('publish'); return { items: 1 }; },
    },
    toolsApi: { readQueue: () => ({ revision: 'tool-r1', items: [] }), review: () => ({}), preview: () => ({ ok: true, expected_revision: 'catalog-r1', preview_hash: 'hash', count: 1, changes: [] }), apply: flags => { calls.push(flags); return { ok: true, applied: 1 }; } },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  await service.generateKeywords();
  await service.generateTop();
  assert.deepEqual(service.publishNews(), { items: 1 });
  assert.equal(service.previewToolUpdates().preview_hash, 'hash');
  assert.deepEqual(await service.applyToolUpdates({ expected_revision: 'catalog-r1', preview_hash: 'hash', confirm: 'APPLY TOOL-UPDATES hash' }), { ok: true, applied: 1 });
  assert.deepEqual(calls, ['keywords', 'top', 'publish', { expected_revision: 'catalog-r1', preview_hash: 'hash', confirm: 'APPLY TOOL-UPDATES hash' }]);
});
test('关键词投影标记已采纳/已丢弃且丢弃写入黑名单', async () => {
  const state = { store: { candidates: [] } };
  let excluded = [];
  const service = createMaintainerWorkbenchService({
    newsApi: {
      readStore: () => state.store, revisionOfStore: () => 'news-r1', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}),
      readKeywords: () => ({ candidates: [{ word: 'deepseek' }, { word: 'google' }, { word: 'yolo' }], source_count: 691, input_count: 12, source_basis: 'top_12_by_score' }),
      readConfig: () => ({ keywords: { ai_keywords: ['deepseek'], excluded_keywords: excluded } }),
      revisionOfConfig: () => 'keywords-r1',
      commitKeywords: () => ({ added: [] }),
      commitKeywordExclusions: words => { excluded = words; return { added: words, written: true }; },
    },
    toolsApi: { readQueue: () => ({ revision: 't', items: [] }), review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  const projection = service.keywords();
  const byWord = Object.fromEntries(projection.items.map(item => [item.word, item]));
  assert.equal(byWord.deepseek.adopted, true);
  assert.equal(byWord.deepseek.discarded, false);
  assert.equal(byWord.google.adopted, false);
  assert.equal(projection.source.source_count, 691);
  assert.equal(projection.source.source_basis, 'top_12_by_score');
  const result = service.discardKeywords({ ids: ['google', 'yolo'], expected_revision: 'keywords-r1' });
  assert.equal(result.added.length, 2);
  assert.deepEqual(excluded, ['google', 'yolo']);
});

test('工作台字幕上传与外部 AI 总结委托底层并保留成本确认', async () => {
  const state = { store: { candidates: [{ id: 'yt-1', review_status: 'approved', top_selected: true, transcript: 'text' }] } };
  const calls = [];
  const service = createMaintainerWorkbenchService({
    newsApi: {
      readStore: () => state.store, revisionOfStore: () => 'news-r1', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}),
      readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'k', commitKeywords: () => ({}),
      uploadTranscript: (payload, opts) => { calls.push(['upload', payload, opts]); return { ok: true }; },
      summarizeTranscripts: (ids, opts) => { calls.push(['summarize', ids, opts]); return { ok: true, summarized: [] }; },
    },
    toolsApi: { readQueue: () => ({ revision: 't', items: [] }), review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  const up = service.uploadTranscript({ candidate_id: 'yt-1', filename: 'a.srt', content_base64: 'aGVsbG8=', expected_revision: 'news-r1' });
  assert.equal(up.ok, true);
  const su = await service.summarizeTranscripts({ ids: ['yt-1'], expected_revision: 'news-r1', confirm_cost: true });
  assert.equal(su.ok, true);
  assert.deepEqual(calls.map(call => call[0]), ['upload', 'summarize']);
  assert.equal(calls[0][1].candidate_id, 'yt-1');
  assert.equal(calls[1][2].confirmCost, true);
  assert.throws(() => service.uploadTranscript({ candidate_id: 'yt-1', expected_revision: 'news-r1' }), /文件名必填/);
});


test('Catalog recovery service enforces top-level request allowlists', () => {
  const calls = [];
  const service = createMaintainerWorkbenchService({
    catalogWorkbench: {
      recoveryPlan: (draftId, body) => { calls.push(['plan', draftId, body]); return { ok: true }; },
      resume: (draftId, body) => { calls.push(['resume', draftId, body]); return { ok: true }; },
    },
    topFile: require('path').join(require('os').tmpdir(), 'knowview-wb-no-top.json'),
    newsApi: { readStore: () => ({ candidates: [] }), revisionOfStore: () => 'n', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}), readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'k', commitKeywords: () => ({}) },
    toolsApi: { readQueue: () => ({ revision: 't', items: [] }), review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });
  assert.deepEqual(service.catalogRecoveryPlan('draft-1', { expected_revision: 'c-r1', generator_options: { model: 'deepseek-v4-flash' } }), { ok: true });
  assert.deepEqual(service.catalogResume('draft-1', { expected_revision: 'c-r1', recovery_token: 'token', confirm_cost: true }), { ok: true });
  assert.throws(() => service.catalogRecoveryPlan('draft-1', { expected_revision: 'c-r1', apiKey: 'secret' }), error => error.code === 'RECOVERY_OPTIONS_INVALID');
  assert.throws(() => service.catalogResume('draft-1', { expected_revision: 'c-r1', recovery_token: 'token', confirm_cost: true, endpoint: 'https://evil.invalid' }), error => error.code === 'RECOVERY_OPTIONS_INVALID');
  assert.equal(calls.length, 2);
});

test('工作台清空只允许全部审核完成并委托白名单清理', async () => {
  const os = require('os');
  const path = require('path');
  const missingTop = path.join(os.tmpdir(), `knowview-wb-no-top-${Date.now()}.json`);
  const makeService = (store, clear) => createMaintainerWorkbenchService({
    topFile: missingTop,
    newsApi: { readStore: () => store, revisionOfStore: () => 'news-r1', readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}) },
    toolsApi: { readQueue: () => ({ revision: 'tool-r1', items: [] }), readRegistry: () => ({ products: {} }), review: () => ({}) },
    conceptsApi: { readPreviews: () => null, readPending: () => ({ revision: 'concept-r1', cards: [] }), readGlossary: () => [] },
    pendingApi: { read: () => ({ revision: 'pending-r1', cards: [] }), review: () => ({}) },
    catalogWorkbench: { list: () => ({ catalog_revision: 'catalog-r1', items: [] }) },
    workspaceApi: { clear },
  });
  let clearCalls = 0;
  const complete = makeService({ candidates: [] }, async () => { clearCalls += 1; return { removed_files: ['data/manual/top.json'] }; });
  assert.equal(complete.workspaceStatus().clearable, true);
  assert.deepEqual(await complete.clearWorkspace(), { ok: true, status: 'cleared', removed_files: ['data/manual/top.json'] });
  assert.equal(clearCalls, 1);

  const incomplete = makeService({ candidates: [{ id: 'news-1', review_status: 'pending' }] }, async () => { clearCalls += 1; return {}; });
  const blocked = await incomplete.clearWorkspace();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'WORKBENCH_NOT_COMPLETE');
  assert.equal(blocked.blockers[0].code, 'NEWS_REVIEW_PENDING');
  assert.equal(clearCalls, 1);
});

test('mutations require expected revision and delegate guarded commits', () => {
  const state = { store: { candidates: [{ id: 'p', review_status: 'pending' }, { id: 'a', review_status: 'approved' }] }, commits: [] };
  const service = serviceWith(state);
  assert.throws(() => service.reviewNews({ ids: ['p'], decision: 'approved' }), /expected_revision/);
  assert.deepEqual(service.reviewNews({ ids: ['p'], decision: 'approved', expected_revision: 'news-r1' }), { updated: 1, missing: [], not_pending: [], revision: 'news-r2' });
  assert.equal(state.commits[0].expectedRevision, 'news-r1');
  assert.throws(() => service.applyTop({ ids: ['a'], expected_revision: 'news-r1' }), /selected/);
  assert.deepEqual(service.applyTop({ ids: ['a'], selected: true, expected_revision: 'news-r1' }), { updated: 1, missing: [], not_approved: [], revision: 'news-r2' });
  assert.equal(service.applyKeywords({ ids: ['kw'], expected_revision: 'keyword-r1' }).revision, 'keyword-r2');
  assert.equal(service.reviewToolUpdate('tool-key', { decision: 'approved', expected_revision: 'tool-r1' }).expected_revision, 'tool-r1');
});

test('配置 API 通过构造注入只读装配并保持现有服务方法兼容', () => {
  const dto = { schema_version: 1, mode: 'read_only', groups: [{ id: 'news' }] };
  const service = createMaintainerWorkbenchService({ configApi: { read: () => dto } });
  assert.equal(service.config(), dto);
  assert.equal(typeof service.overview, 'function');
});

test('service catalogCleanup enforces parameter allowlist and delegates to workbench cleanup', () => {
  let cleanupPayload = null;
  const service = createMaintainerWorkbenchService({
    catalogWorkbench: {
      cleanup: body => { cleanupPayload = body; return { ok: true, status: 'cleanup_only', cleanup_only: true }; },
    },
    topFile: require('path').join(require('os').tmpdir(), 'knowview-wb-no-top.json'),
    newsApi: { readStore: () => ({ candidates: [] }), revisionOfStore: () => 'n', commit: () => ({}), reviewMutation: () => ({}), topMutation: () => ({}), readKeywords: () => ({ candidates: [] }), readConfig: () => ({}), revisionOfConfig: () => 'k', commitKeywords: () => ({}) },
    toolsApi: { readQueue: () => ({ revision: 't', items: [] }), review: () => ({}) },
    conceptsApi: { readPreviews: () => ({ cards: [] }) },
  });

  assert.throws(() => service.catalogCleanup(null), /Catalog 清理请求无效/);
  assert.throws(() => service.catalogCleanup({ draft_ids: ['d1'], expected_revision: 'r1', batch_token: 'b', confirm: 'c', extra: 1 }), /Catalog 清理请求字段无效/);

  const result = service.catalogCleanup({
    draft_ids: ['d1'],
    expected_revision: 'r1',
    batch_token: 'b',
    confirm: 'APPLY CATALOG DRAFTS b',
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleanup_only, true);
  assert.deepEqual(cleanupPayload, {
    draft_ids: ['d1'],
    expected_revision: 'r1',
    batch_token: 'b',
    confirm: 'APPLY CATALOG DRAFTS b',
  });
});

test('全链路集成：createMaintainerWorkbenchService -> extractKnowledge -> feedbackFromSummaries -> pending store -> API 投影', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-extract-integration-'));
  const pendingToolFile = path.join(dir, 'tool-cards-pending.json');
  const pendingConceptFile = path.join(dir, 'concept-cards-pending.json');
  const topFile = path.join(dir, 'top.json');

  const candidates = [
    {
      id: 'news-1',
      review_status: 'approved',
      summary: 'xAI 正式发布了 Grok Voice Transcribe 2.0 模型，OpenAI 与 Anthropic 也发布了更新。',
    },
    {
      id: 'news-2',
      review_status: 'approved',
      summary: '测试表明 Grok Voice Transcribe 2.0 的识别准确率领先。',
    },
    {
      id: 'news-3',
      review_status: 'approved',
      summary: '开发者在 API 中广泛集成了 Grok Voice Transcribe 2.0。',
    },
    {
      id: 'news-4',
      review_status: 'pending',
      summary: '未初审的新闻摘要，不应参与提取。',
    },
  ];

  const mockLlmExtract = async text => {
    const out = [];
    if (text.includes('Grok Voice Transcribe 2.0')) {
      out.push({ name: 'Grok Voice Transcribe 2.0', type: 'model' });
    }
    if (text.includes('OpenAI')) {
      out.push({ name: 'OpenAI', type: 'vague' });
    }
    if (text.includes('Anthropic')) {
      out.push({ name: 'Anthropic', type: 'vague' });
    }
    return out;
  };

  const service = createMaintainerWorkbenchService({
    pendingToolFile,
    pendingConceptFile,
    topFile,
    newsApi: {
      readStore: () => ({ candidates }),
      revisionOfStore: () => 'news-rev-1',
      readConfig: () => ({ feedback: { llm_extract: true } }),
      readKeywords: () => ({ candidates: [] }),
      commitKeywords: () => ({}),
      commit: () => ({}),
      reviewMutation: () => ({}),
      topMutation: () => ({}),
    },
    feedbackOptions: {
      llmExtract: mockLlmExtract,
      pendingToolFile,
      pendingConceptFile,
    },
  });

  // 1. 调用 extractKnowledge 全链路
  const extractResult = await service.extractKnowledge({ expected_revision: 'news-rev-1' });
  assert.equal(extractResult.ok, true);
  assert.equal(extractResult.tools_pending, 1);
  assert.ok(extractResult.pending_revisions.tools);
  assert.ok(extractResult.diagnostics);
  assert.ok(extractResult.diagnostics.vague_filtered.some(e => e.name === 'OpenAI'));
  assert.ok(extractResult.diagnostics.vague_filtered.some(e => e.name === 'Anthropic'));

  // 2. 调用 API 投影 pendingTools()
  const pendingProjection = service.pendingTools();
  assert.equal(pendingProjection.items.length, 1, '仅包含真正待办');
  assert.equal(pendingProjection.history_items.length, 0, '初始无历史卡');

  const card = pendingProjection.items[0];
  assert.equal(card.name, 'Grok Voice Transcribe 2.0');
  assert.equal(card.entity_type, 'model');
  assert.equal(card.detail_kind_hint, 'api_model');
  assert.equal(card.mentioned_in_summaries, 3, '3 篇摘要合并为 1 张卡');
  assert.equal(card.review_status, 'pending');
  assert.equal(card.description, '', '空描述透传供前端显示待补全');

  // 3. 审核待补卡：将 Grok Voice Transcribe 2.0 标记为 discarded
  const reviewResult = await service.reviewPendingTool(card.candidate_key, {
    decision: 'discarded',
    expected_revision: extractResult.pending_revisions.tools,
  });
  assert.equal(reviewResult.ok, true);

  // 4. 再次获取 pendingTools()，验证 active/history 分流
  const afterReview = service.pendingTools();
  assert.equal(afterReview.items.length, 0, '待办列表清空');
  assert.equal(afterReview.history_items.length, 1, '已移入历史列表');
  assert.equal(afterReview.history_items[0].review_status, 'discarded');

  fs.rmSync(dir, { recursive: true, force: true });
});
