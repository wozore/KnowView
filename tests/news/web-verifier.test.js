/**
 * web-verifier.test.js — 审核建议联网查证测试（web-verifier + llm-prompts 联网核验注入）
 *
 * 测试原理：
 *   全部注入 fake searchTavily / reviewFn，不发真实网络与 LLM 请求：
 *     1. approve 建议不触发查证，原样返回；
 *     2. hold/discard 触发查证，复判成功采用新 advice 并挂 web_verification.results；
 *     3. 搜索抛错 / 返回 ok:false（Tavily 限流的真实形态）→ 原 advice + search_error；
 *     4. 复判 LLM 失败（verdict null 或抛错）→ 原 advice + web_verification 照挂；
 *     5. 查询词取标题并截断 120 字符；空结果不复判；
 *     6. REVIEW_USER_PROMPT_TEMPLATE 含"无法确认真伪判 hold"认识论条款；
 *        buildReviewPayload 把 webEvidence 拼在"只输出 JSON："之前。
 *
 * 运行方式：node --test tests/news/web-verifier.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAdviceWithWeb } = require('../../src/news/classify/web-verifier');
const { REVIEW_USER_PROMPT_TEMPLATE, buildReviewPayload } = require('../../src/news/classify/llm-prompts');

const ITEM = { title: 'Gemini 3.8 Live 发布', description: '新模型介绍' };
const HOLD_ADVICE = { verdict: 'hold', reasons: ['需联网核实官方来源'], confidence: 0.4 };

/** 成功搜索的 fake：返回两条来源并记录调用。 */
function fakeSearchOk(sources = [
  { title: 'Google 官方公告', url: 'https://blog.google/gemini-38-live', content: 'Gemini 3.8 Live 已正式发布' },
  { title: '第三方报道', url: 'https://example.com/news', content: '模型上线' },
]) {
  const calls = [];
  const fn = async options => {
    calls.push(options);
    return { ok: true, sources };
  };
  return { fn, calls };
}

// ── 第 1 组：触发条件 ────────────────────────────────────────

test('approve 建议不触发搜索，原样返回', async () => {
  let searched = false;
  const advice = { verdict: 'approve', reasons: [], confidence: 0.9 };
  const result = await verifyAdviceWithWeb(ITEM, advice, {
    searchTavily: async () => { searched = true; return { ok: true, sources: [] }; },
    reviewFn: async () => { throw new Error('不应复判'); },
  });
  assert.equal(searched, false);
  assert.equal(result, advice);
  assert.equal(result.web_verification, undefined);
});

test('advice 为 null 或 verdict 缺失时原样返回', async () => {
  let searched = false;
  const searchTavily = async () => { searched = true; return { ok: true, sources: [] }; };
  assert.equal(await verifyAdviceWithWeb(ITEM, null, { searchTavily }), null);
  const noVerdict = { reasons: ['仅错误信息'], confidence: 0 };
  assert.equal(await verifyAdviceWithWeb(ITEM, noVerdict, { searchTavily }), noVerdict);
  assert.equal(searched, false);
});

test('discard 建议同样触发查证', async () => {
  const search = fakeSearchOk();
  const advice = { verdict: 'discard', reasons: ['疑似编造'], confidence: 0.9 };
  const result = await verifyAdviceWithWeb(ITEM, advice, {
    searchTavily: search.fn,
    reviewFn: async () => ({ verdict: 'discard', reasons: ['官方无此模型'], confidence: 0.9 }),
  });
  assert.equal(search.calls.length, 1);
  assert.equal(result.verdict, 'discard');
  assert.ok(Array.isArray(result.web_verification.results));
});

// ── 第 2 组：搜索 + 复判成功 ────────────────────────────────

test('hold + 搜索成功 + 复判成功 → 采用复判 advice 且带 web_verification.results', async () => {
  const search = fakeSearchOk();
  const reviewCalls = [];
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: search.fn,
    reviewFn: async (item, options) => {
      reviewCalls.push(options);
      return { verdict: 'approve', reasons: ['官方来源证实模型存在'], confidence: 0.9 };
    },
  });

  assert.equal(result.verdict, 'approve');
  assert.deepEqual(result.reasons, ['官方来源证实模型存在']);
  assert.deepEqual(result.web_verification.results, [
    { title: 'Google 官方公告', url: 'https://blog.google/gemini-38-live' },
    { title: '第三方报道', url: 'https://example.com/news' },
  ]);
  assert.equal(result.web_verification.query, 'Gemini 3.8 Live 发布');
  assert.ok(result.web_verification.searched_at);
  assert.equal(result.web_verification.search_error, undefined);

  // 复判收到 webEvidence（含 title/url/content），且查询词截断与结果条数受控
  assert.equal(search.calls.length, 1);
  assert.equal(search.calls[0].query, 'Gemini 3.8 Live 发布');
  assert.equal(search.calls[0].maxResults, 5);
  assert.equal(reviewCalls.length, 1);
  assert.ok(reviewCalls[0].webEvidence.includes('Google 官方公告'));
  assert.ok(reviewCalls[0].webEvidence.includes('https://blog.google/gemini-38-live'));
  assert.ok(reviewCalls[0].webEvidence.includes('Gemini 3.8 Live 已正式发布'));
});

test('查询词取标题并截断到 120 字符', async () => {
  const longTitle = '超长标题'.repeat(50); // 200 字符
  const search = fakeSearchOk();
  await verifyAdviceWithWeb({ title: longTitle }, HOLD_ADVICE, {
    searchTavily: search.fn,
    reviewFn: async () => ({ verdict: 'hold', reasons: [], confidence: 0.4 }),
  });
  assert.equal(search.calls[0].query.length, 120);
  assert.ok(longTitle.startsWith(search.calls[0].query));
});

test('搜索成功但无有效结果 → 不复判，保留原 advice 并挂空 results', async () => {
  const search = fakeSearchOk([]);
  let reviewed = false;
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: search.fn,
    reviewFn: async () => { reviewed = true; return { verdict: 'approve', reasons: [], confidence: 0.9 }; },
  });
  assert.equal(reviewed, false);
  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, ['需联网核实官方来源']);
  assert.deepEqual(result.web_verification.results, []);
});

// ── 第 3 组：fail-open 降级 ─────────────────────────────────

test('搜索抛错 → 原 advice 不变 + web_verification.search_error 存在', async () => {
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: async () => { throw new Error('network down'); },
    reviewFn: async () => { throw new Error('不应复判'); },
  });
  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, HOLD_ADVICE.reasons);
  assert.equal(result.confidence, 0.4);
  assert.equal(result.web_verification.query, ITEM.title);
  assert.ok(result.web_verification.searched_at);
  assert.match(result.web_verification.search_error, /network down/);
  assert.equal(result.web_verification.results, undefined);
});

test('搜索返回 ok:false（限流）→ search_error 记录错误码', async () => {
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: async () => ({ ok: false, code: 'TAVILY_SEARCH_RATE_LIMITED', error: 'keyless 限流' }),
    reviewFn: async () => { throw new Error('不应复判'); },
  });
  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, HOLD_ADVICE.reasons);
  assert.equal(result.web_verification.search_error, 'TAVILY_SEARCH_RATE_LIMITED');
});

test('复判 LLM 失败（verdict null）→ 原 advice + web_verification 仍在', async () => {
  const search = fakeSearchOk();
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: search.fn,
    reviewFn: async () => ({ verdict: null, reasons: [], confidence: 0, llm_error: 'llm_failed' }),
  });
  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, HOLD_ADVICE.reasons);
  assert.deepEqual(result.web_verification.results, [
    { title: 'Google 官方公告', url: 'https://blog.google/gemini-38-live' },
    { title: '第三方报道', url: 'https://example.com/news' },
  ]);
});

test('复判 LLM 抛错 → 原 advice + web_verification 仍在，绝不向上抛', async () => {
  const search = fakeSearchOk();
  const result = await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    searchTavily: search.fn,
    reviewFn: async () => { throw new Error('review exploded'); },
  });
  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, HOLD_ADVICE.reasons);
  assert.equal(result.web_verification.query, ITEM.title);
  assert.ok(Array.isArray(result.web_verification.results));
});

test('标题为空时无法构造查询词 → 原样返回不搜索', async () => {
  let searched = false;
  const advice = { verdict: 'hold', reasons: ['x'], confidence: 0.4 };
  const result = await verifyAdviceWithWeb({ title: '   ' }, advice, {
    searchTavily: async () => { searched = true; return { ok: true, sources: [] }; },
  });
  assert.equal(searched, false);
  assert.equal(result, advice);
});

// ── 第 4 组：prompt 认识论修正与 webEvidence 拼装 ───────────

test('REVIEW_USER_PROMPT_TEMPLATE 含"无法确认真伪判 hold"与"以核验结果为准"条款', () => {
  assert.ok(REVIEW_USER_PROMPT_TEMPLATE.includes('需联网核实官方来源'));
  assert.ok(REVIEW_USER_PROMPT_TEMPLATE.includes('联网核验结果'));
  assert.ok(REVIEW_USER_PROMPT_TEMPLATE.includes('不要断言'));
});

test('buildReviewPayload 把 webEvidence 拼在"只输出 JSON："之前', () => {
  const payload = buildReviewPayload(ITEM, 'model', { webEvidence: '[1] 官方公告\nhttps://blog.google/x\n已发布' });
  const user = payload.messages[1].content;
  const evidenceIndex = user.indexOf('联网核验结果：');
  const jsonIndex = user.lastIndexOf('只输出 JSON：');
  assert.ok(evidenceIndex > -1);
  assert.ok(jsonIndex > evidenceIndex);
  assert.ok(user.includes('https://blog.google/x'));
  // 不带 webEvidence 时 prompt 不含核验段
  const plain = buildReviewPayload(ITEM, 'model').messages[1].content;
  assert.ok(!plain.includes('联网核验结果：'));
});

// ── 第 5 组：搜索参数白名单（凭据不外泄） ──────────────────

test('search 只收到白名单参数，apiKey/provider/model/config 绝不透传给 Tavily', async () => {
  const search = fakeSearchOk();
  await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    // 模拟上层 reviewCandidate 选项整体混入：含 LLM 凭据与配置
    apiKey: 'sk-llm-secret-key',
    provider: 'deepseek',
    model: 'deepseek-chat',
    config: { review: { web_verify: true } },
    searchTavily: search.fn,
    reviewFn: async () => ({ verdict: 'approve', reasons: ['官方来源证实'], confidence: 0.9 }),
    timeoutMs: 12345,
    fetchImpl: async () => { throw new Error('不应发起真实请求'); },
  });

  assert.equal(search.calls.length, 1);
  const sent = search.calls[0];
  // 泄漏面：LLM key 若透传，keyless 429 回退 keyed 时会被当 Tavily Bearer 发出
  assert.equal(sent.apiKey, undefined);
  assert.equal(sent.provider, undefined);
  assert.equal(sent.model, undefined);
  assert.equal(sent.config, undefined);
  // 白名单：仅允许 query/maxResults + 可选 timeoutMs/fetchImpl
  assert.deepEqual(Object.keys(sent).sort(), ['fetchImpl', 'maxResults', 'query', 'timeoutMs']);
  assert.equal(sent.query, ITEM.title);
  assert.equal(sent.maxResults, 5);
  assert.equal(sent.timeoutMs, 12345);
  assert.equal(typeof sent.fetchImpl, 'function');
});

test('search 白名单：未传 timeoutMs/fetchImpl 时只发 query 与 maxResults', async () => {
  const search = fakeSearchOk();
  await verifyAdviceWithWeb(ITEM, HOLD_ADVICE, {
    apiKey: 'sk-llm-secret-key',
    searchTavily: search.fn,
    reviewFn: async () => ({ verdict: 'hold', reasons: [], confidence: 0.4 }),
  });
  assert.deepEqual(Object.keys(search.calls[0]).sort(), ['maxResults', 'query']);
});
