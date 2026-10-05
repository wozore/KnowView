/**
 * news-reviewer.test.js — AI 审核建议器测试（content-reviewer）
 *
 * 测试原理：
 *   不请求真实网络，注入 mock fetchImpl 验证：
 *     1. buildReviewPayload 输入裁剪（title/desc/transcript/summary）与占位符替换；
 *     2. normalizeReview 解析模型输出的 JSON 容错（中文 verdict / confidence 置 0）；
 *     3. reviewContent 成功/缺 key/网络失败/输出无法解析降级；
 *     4. reviewCandidate 成功（含字幕/总结）/失败降级/无素材；
 *     5. reviewCandidates 批量、跳过已有 ai_review；
 *     6. mergeCandidatesMin 保留既有审核结论（重新采集不重置人工结论）。
 *
 * 运行方式：node --test tests/news/news-reviewer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewContent } = require('../../src/news/classify/llm-provider');
const {
  buildClassifyPayload, buildSummaryPayload, buildReviewPayload, buildLocalizePayload, normalizeReview,
} = require('../../src/news/classify/llm-prompts');
const { reviewAssessmentGate } = require('../../src/news/classify/review-assessment');
const {
  collectReviewSource,
  reviewCandidate,
  reviewCandidates,
} = require('../../src/news/classify/content-reviewer');
const { mergeCandidatesMin } = require('../../src/news/min/min-store');
const { applyL1Verdicts } = require('../../src/news/min/review-v2');

/** 构造一个 DeepSeek 成功响应（content 为模型输出文本）。 */
function deepSeekOk(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** 按 URL 返回响应的 mock fetchImpl。 */
function mockFetch(respond) {
  return async url => respond(String(url));
}

// ── 第 1 组：buildReviewPayload / normalizeReview（llm-provider）────

test('buildReviewPayload 裁剪标题/描述/字幕/总结并替换占位符', () => {
  const payload = buildReviewPayload({
    title: 't'.repeat(300),
    description: 'd'.repeat(2200),
    transcript: 'x'.repeat(5000),
    summary: 's'.repeat(900),
  });
  const user = payload.messages[1].content;
  assert.ok(user.includes('t'.repeat(200)));
  assert.ok(!user.includes('t'.repeat(300)));
  assert.ok(user.includes('d'.repeat(2000)));
  assert.ok(!user.includes('d'.repeat(2200)));
  assert.ok(user.includes('x'.repeat(3000)));   // 字幕截断前 3000 字符
  assert.ok(!user.includes('x'.repeat(5000)));
  assert.ok(user.includes('s'.repeat(800)));    // 总结截断前 800 字符
  assert.ok(!user.includes('s'.repeat(900)));
  assert.ok(user.includes('confidence_range'));
  assert.ok(user.includes('60-80%'));
  assert.ok(user.includes('政治评论'));
  assert.ok(user.includes('political_context_only'));
  assert.ok(user.includes('confidence 是所选区间的下界') || user.includes('confidence：填写所选区间的下界'));
});

test('buildReviewPayload 缺素材时占位符填空（无总结）', () => {
  const user = buildReviewPayload({ title: '标题' }).messages[1].content;
  assert.ok(user.includes('标题'));
  assert.ok(user.includes('（无描述）'));
  assert.ok(user.includes('（无字幕）'));
  assert.ok(user.includes('（无总结）'));
});

test('buildReviewPayload 内容含 $ 替换模式序列时不污染 prompt', () => {
  // 字符串 pattern 的 replace 会把 $&/$' 等当作替换模式解释，函数式替换不会
  const tricky = '$&$`$\'$1$$';
  const user = buildReviewPayload({ title: tricky, description: tricky, transcript: tricky, summary: tricky }).messages[1].content;
  assert.equal(user.split(tricky).length - 1, 4, '四个字段原样出现，未被替换模式改写');
});

test('AI 输入截断不能把 emoji 截成孤立代理字符', () => {
  const item = {
    title: 't'.repeat(199) + '😀',
    description: 'd'.repeat(599) + '😀',
    transcript: 'x'.repeat(2999) + '😀',
    summary: 's'.repeat(799) + '😀',
  };
  const payloads = [
    buildClassifyPayload(item, 'test'),
    buildSummaryPayload(item, 'test'),
    buildReviewPayload({ ...item, description: 'd'.repeat(1999) + '😀' }, 'test', { webEvidence: 'w'.repeat(2999) + '😀' }),
    buildLocalizePayload(item, 'test'),
  ];
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const payload of payloads) {
    assert.equal(unpaired.test(payload.messages[1].content), false);
  }
});

test('normalizeReview 解析标准 JSON', () => {
  const parsed = normalizeReview('{"verdict":"discard","reasons":["非 AI 主题","广告内容"],"confidence":0.95}');
  assert.deepEqual(parsed, { verdict: 'discard', reasons: ['非 AI 主题', '广告内容'], confidence: 0.95 });
});

test('normalizeReview 支持区间置信度，并以区间下界作为安全数值', () => {
  assert.deepEqual(normalizeReview('{"verdict":"hold","confidence_range":"60-80%","confidence":0.6,"reasons":["信息不完整"]}'), {
    verdict: 'hold', reasons: ['信息不完整'], confidence: 0.6, confidence_range: '60-80%'
  });
  assert.equal(normalizeReview('{"verdict":"approve","confidence_range":"90–100%","confidence":0.95}').confidence, 0.9);
  assert.equal(normalizeReview('{"verdict":"approve","confidence_range":"90–100%","confidence":0.95}').confidence_range, '90-100%');
  assert.equal(normalizeReview('{"verdict":"hold","confidence_range":"bad","confidence":0.6}').confidence_range, undefined);
});

test('normalizeReview 容忍 markdown 代码块与前后多余文字', () => {
  const parsed = normalizeReview('```json\n{"verdict":"hold","reasons":["信息不全"]}\n```');
  assert.deepEqual(parsed, { verdict: 'hold', reasons: ['信息不全'], confidence: 0 });
  const parsed2 = normalizeReview('好的，这是审核结果：{"verdict":"approve","confidence":0.8}末尾');
  assert.deepEqual(parsed2, { verdict: 'approve', reasons: [], confidence: 0.8 });
});

test('normalizeReview 中文 verdict 映射、空 reasons 过滤、confidence 置 0', () => {
  assert.equal(normalizeReview('{"verdict":"丢弃","reasons":["a","","b"]}').verdict, 'discard');
  assert.deepEqual(normalizeReview('{"verdict":"挂起","reasons":["a"]}').verdict, 'hold');
  assert.deepEqual(normalizeReview('{"verdict":"通过"}').verdict, 'approve');
  const withEmpty = normalizeReview('{"verdict":"approve","reasons":["",null,"  "]}');
  assert.deepEqual(withEmpty.reasons, []);
  assert.equal(withEmpty.confidence, 0);        // confidence 缺省 → 0（安全默认）
});

test('normalizeReview 非法/越界 confidence 钳制到 0-1，非法 verdict 返回 null', () => {
  assert.equal(normalizeReview('{"verdict":"approve","confidence":1.5}').confidence, 1);
  assert.equal(normalizeReview('{"verdict":"approve","confidence":-0.2}').confidence, 0);
  assert.equal(normalizeReview('{"verdict":"approve","confidence":"high"}').confidence, 0);
  assert.equal(normalizeReview('{"verdict":"maybe","confidence":0.9}'), null);   // 非法 verdict
  assert.equal(normalizeReview('不是 JSON'), null);
  assert.equal(normalizeReview(''), null);
});

test('structured gate preview requires complete evidence and defers unresolved claims', () => {
  const supported = {
    topic_relevance: 'in_scope', subject_clarity: 'specific', information_value: 'substantive', source_quality: 'primary',
    evidence_status: 'sufficient', decision_basis: 'clear_relevant_content',
  };
  assert.deepEqual(reviewAssessmentGate('approve', supported, { needed: false }), {
    action: 'approve_candidate', reason: 'criteria_satisfied',
  });
  assert.deepEqual(reviewAssessmentGate('approve', supported, { needed: true }), {
    action: 'manual', reason: 'fact_check_required',
  });
  assert.deepEqual(reviewAssessmentGate('approve', { ...supported, subject_clarity: 'broad' }, { needed: false }), {
    action: 'manual', reason: 'criteria_not_satisfied',
  });
  assert.deepEqual(reviewAssessmentGate('approve', {
    ...supported,
    source_quality: 'unknown',
    evidence_status: 'needs_fact_check',
    decision_basis: 'unverified_fact',
  }, { needed: true }, {
    status: 'completed', conclusion: 'supports', sources: [{ title: 'Official source', url: 'https://example.com' }],
  }), { action: 'approve_candidate', reason: 'criteria_satisfied' });
  assert.deepEqual(reviewAssessmentGate('discard', null, { needed: false }), {
    action: 'manual', reason: 'assessment_incomplete',
  });
  assert.deepEqual(reviewAssessmentGate('discard', {
    topic_relevance: 'out_of_scope', subject_clarity: 'broad', information_value: 'low', source_quality: 'unknown',
    evidence_status: 'sufficient', decision_basis: 'political_context_only',
  }, { needed: false }), { action: 'discard_candidate', reason: 'criteria_satisfied' });
});

// ── 第 2 组：reviewContent 降级语义 ─────────────────

test('reviewContent 缺 key：resolve 降级不 reject', async () => {
  const result = await reviewContent({ title: 't' }, { apiKey: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_api_key');
});

test('reviewContent 网络失败：resolve 降级', async () => {
  const result = await reviewContent({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => { throw new Error('network down'); }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
});

test('reviewContent 输出无法解析：invalid_review', async () => {
  const result = await reviewContent({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('我不懂你在说什么')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_review');
});

test('reviewContent 成功：返回 verdict + reasons + confidence', async () => {
  const result = await reviewContent({ title: 't', summary: 's' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"discard","reasons":["广告"],"confidence":0.9}')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'discard');
  assert.deepEqual(result.reasons, ['广告']);
  assert.equal(result.confidence, 0.9);
});

test('reviewContent 成功：传递区间置信度并使用区间下界', async () => {
  const result = await reviewContent({ title: 't', summary: 's' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"hold","confidence_range":"40-60%","confidence":0.6,"reasons":["证据不足"]}')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.confidence_range, '40-60%');
  assert.equal(result.confidence, 0.4);
});



test('collectReviewSource 提取标题/描述/字幕/总结（字幕支持对象或字符串）', () => {
  assert.deepEqual(collectReviewSource({ title: 't', description: 'd', transcript: { text: '字幕' }, summary: '总结' }), {
    title: 't', description: 'd', transcript: '字幕', summary: '总结', source_context: '', description_truncated: false,
  });
  assert.deepEqual(collectReviewSource({ title: 't', transcript: '字幕文本' }), {
    title: 't', description: '', transcript: '字幕文本', summary: null, source_context: '', description_truncated: false,
  });
  assert.deepEqual(collectReviewSource({ title: 't' }), {
    title: 't', description: '', transcript: null, summary: null, source_context: '', description_truncated: false,
  });
});

test('reviewCandidate 无素材：返回 no_source 不调 LLM', async () => {
  let calls = 0;
  const result = await reviewCandidate({}, {
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.equal(result.verdict, null);
  assert.equal(result.llm_error, 'no_source');
  assert.equal(calls, 0);
});

test('reviewCandidate 成功：含字幕/总结输入，记录 reviewer/input_chars', async () => {
  const result = await reviewCandidate({
    title: '标题', description: '描述', transcript: { text: '字幕' }, summary: '总结',
  }, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","reasons":["有实质信息"],"confidence":0.9}')),
  });
  assert.equal(result.verdict, 'approve');
  assert.deepEqual(result.reasons, ['有实质信息']);
  assert.equal(result.reviewer, 'llm_zhipu');
  assert.ok(result.generated_at);
  assert.equal(result.input_chars, '标题'.length + '描述'.length + '字幕'.length + '总结'.length);
  assert.equal(result.llm_error, null);
});

test('reviewCandidate 失败：verdict 置 null、reviewer=llm_failed、llm_error 有值', async () => {
  const result = await reviewCandidate({ title: '标题', description: '描述' }, {
    fetchImpl: mockFetch(() => deepSeekOk('无法解析')),
  });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, 'llm_failed');
  assert.ok(result.llm_error);
});

// ── 第 4 组：reviewCandidates 批量 ───────────────────────

test('reviewCandidates：批量成功写入 ai_review 建议', async () => {
  const items = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  const result = await reviewCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","reasons":["相关"],"confidence":0.9}')),
  });
  assert.equal(result.reviewed, 2);
  assert.equal(result.skipped, 0);
  assert.equal(items[0].ai_review.verdict, 'approve');
  assert.equal(items[1].ai_review.verdict, 'approve');
  assert.equal(items[0].ai_review_llm_error, null);
});

test('reviewCandidates：跳过已有 ai_review 与无素材条目', async () => {
  const items = [
    { id: 'has', title: '已有', ai_review: { verdict: 'hold' } },
    { id: 'empty', title: '' },
    { id: 'new', title: '新条目' },
  ];
  const result = await reviewCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","confidence":0.9}')),
  });
  assert.equal(result.reviewed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(items[0].ai_review.verdict, 'hold');       // 不覆盖已有
  assert.equal(items[1].ai_review, undefined);
  assert.equal(items[2].ai_review.verdict, 'approve');
});

test('reviewCandidates：LLM 全失败时 reviewed=0 且不写 ai_review（不误杀）', async () => {
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const result = await reviewCandidates(items, {
    fetchImpl: mockFetch(() => deepSeekOk('bad output')),
  });
  assert.equal(result.reviewed, 0);
  assert.equal(items[0].ai_review, undefined);            // 不写建议
  assert.ok(items[0].ai_review_llm_error);                // 留错误痕迹便于排查
});

test('L1 自动分流，L2 标记可核实事实后登记 Codex 查证任务', async () => {
  let calls = 0;
  const verifyTargets = [];
  const items = [
    { id: 'approve', title: 'AI 产品发布', url: 'https://example.com/a', published_at: '2026-08-09T00:00:00Z', description: 'AI tool release' },
    { id: 'discard', title: 'AI 内容', url: 'https://example.com/d', published_at: '2026-08-09T00:00:00Z', description: 'AI topic is unrelated to the product' },
    { id: 'hold', title: 'AI 存疑内容', url: 'https://example.com/h', published_at: '2026-08-09T00:00:00Z', description: 'AI topic unclear' },
  ];
  const verdicts = {
    approve: {
      verdict: 'approve', confidence: 0.1, reasons: ['保留结构化审核痕迹'],
      assessment: {
        topic_relevance: 'in_scope', subject_clarity: 'specific', information_value: 'substantive',
        source_quality: 'unknown', evidence_status: 'sufficient', decision_basis: 'clear_relevant_content',
      },
    },
    discard: {
      verdict: 'discard', confidence: 0.1, reasons: ['保留结构化审核痕迹'],
      assessment: {
        topic_relevance: 'out_of_scope', subject_clarity: 'broad', information_value: 'low',
        source_quality: 'unknown', evidence_status: 'sufficient', decision_basis: 'political_context_only',
      },
    },
    hold: { verdict: 'hold', confidence: 0.6, reasons: ['需要人工确认'], fact_check: { needed: true, claim: 'Gemini 3.8 Live 已正式发布', query: 'Gemini 3.8 Live 发布' } },
  };
  const result = await applyL1Verdicts(items, {
    keywords: { content_keywords: ['ai'] },
    collection: { concurrency: 1 },
    review: { l2_enabled: true, fact_check_mode: 'codex_mcp' },
  }, {
    reviewCandidate: async item => { calls += 1; return verdicts[item.id]; },
    verifyAdviceWithWeb: async (item, advice) => {
      verifyTargets.push({ id: item.id, verdict: advice.verdict });
      return { ...advice, web_verification: { query: item.title, searched_at: '2026-09-16T00:00:00Z', results: [] } };
    },
  });
  const byId = new Map([...result.kept, ...result.discarded].map(item => [item.id, item]));
  assert.equal(byId.get('approve').review_status, 'approved');
  assert.equal(byId.get('discard').review_status, 'discarded');
  assert.equal(byId.get('hold').review_status, 'pending');
  assert.equal(byId.get('approve').l1_review.confidence, 0.1, '结构化门禁通过时不再被旧置信度阈值拦住');
  assert.equal(byId.get('discard').l1_review.assessment_gate_preview.action, 'discard_candidate');
  assert.deepEqual(byId.get('approve').l1_review.reasons, []);
  assert.deepEqual(byId.get('discard').l1_review.reasons, []);
  assert.equal(calls, 4, 'L1 3 次 + pending 的 L2 1 次');
  assert.deepEqual(verifyTargets, [{ id: 'hold', verdict: 'hold' }], '只有显式标记事实核验的建议进入查证流程');
  assert.equal(byId.get('hold').ai_advice.verdict, 'hold');
  assert.equal(byId.get('hold').ai_advice.web_verification.query, 'AI 存疑内容');
  assert.equal(byId.get('hold').ai_advice.fact_check.needed, true);
  // 自动分流项无建议、无核验
  assert.equal(byId.get('approve').ai_advice, null);
});

test('L1 缺少完整结构化审核维度时保持 pending，即使置信度很高', async () => {
  const result = await applyL1Verdicts([{
    id: 'incomplete', title: 'AI 产品', url: 'https://example.com/i',
    published_at: '2026-08-09T00:00:00Z', description: 'AI tool release',
  }], {
    keywords: { content_keywords: ['ai'] },
    collection: { concurrency: 1 },
    review: { l2_enabled: false, fact_check_mode: 'off' },
  }, {
    reviewCandidate: async () => ({ verdict: 'approve', confidence: 0.99, reasons: ['缺结构化判断'] }),
  });
  const [item] = result.kept;
  assert.equal(item.review_status, 'pending');
  assert.deepEqual(item.l1_review.assessment_gate_preview, {
    action: 'manual', reason: 'assessment_incomplete',
  });
});

test('fact_check_mode=off：主管线不调用查证器', async () => {
  let verifyCalled = false;
  const items = [
    { id: 'hold', title: 'AI 存疑内容', url: 'https://example.com/h', published_at: '2026-08-09T00:00:00Z', description: 'AI topic unclear' },
  ];
  const result = await applyL1Verdicts(items, {
    keywords: { content_keywords: ['ai'] },
    collection: { concurrency: 1 },
    review: { l2_enabled: true, fact_check_mode: 'off' },
  }, {
    reviewCandidate: async () => ({ verdict: 'hold', confidence: 0.6, reasons: ['需要人工确认'] }),
    verifyAdviceWithWeb: async () => { verifyCalled = true; return null; },
  });
  assert.equal(verifyCalled, false, 'off 模式不调用查证器');
  assert.equal(result.kept[0].ai_advice.verdict, 'hold');
  assert.equal(result.kept[0].ai_advice.web_verification, undefined);
});


test('mergeCandidatesMin 保留既有 review_status，重新采集不重置人工结论', () => {
  const prev = { schema_version: 1, updated_at: null, candidates: [
    { id: 'a', title: '旧', review_status: 'approved', top_selected: true, ai_advice: { verdict: 'approve', reasons: ['人工确认'] } },
  ] };
  // 下一轮 incoming 无 review_status（本轮未重新审核）→ 保留既有 approved
  const store1 = mergeCandidatesMin(prev, [{ id: 'a', title: '新标题' }]);
  assert.equal(store1.candidates[0].review_status, 'approved');
  assert.equal(store1.candidates[0].top_selected, true);
});
