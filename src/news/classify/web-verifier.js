/**
 * web-verifier.js —— 审核建议联网查证（Tavily 搜索 + LLM 复判）
 *
 * 背景：审核 LLM 只靠训练记忆判断真伪，会把真实存在的最新模型误判为"编造"。
 * 本模块对 verdict 为 hold/discard 的建议做一次联网查证：用标题搜 Tavily，
 * 把前 5 条结果的 title+url+content 拼成证据文本（webEvidence）追加进审核
 * prompt 复判一次，让"知识无法确认"的建议有官方来源可依。
 *
 * 铁律：全程 fail-open —— 搜索失败/复判失败/任何异常都不向上抛，
 * 绝不阻断审核流程（Tavily 限流是常态）；失败时原 advice 原样返回，
 * 尽力挂 web_verification 痕迹（随 ai_advice 持久化，供人工追溯）。
 *
 * 注入点：options.searchTavily / options.reviewFn 可替换真实实现（测试 mock 用）。
 * search 只接收白名单参数（query/maxResults/timeoutMs/fetchImpl），上层审核 LLM 的
 * apiKey/provider/model/config 绝不透传给 Tavily（防跨服务凭据泄漏与限流被误判
 * AUTH_REQUIRED）；复判 review 仍按 l2AiAdvice 的方式透传 options 给 reviewCandidate。
 */

'use strict';

const { searchTavily } = require('../../shared/tavily-client');
const { reviewCandidate } = require('./content-reviewer');

// 查询词截断（字符）与参与复判的结果条数
const QUERY_MAX_CHARS = 120;
const MAX_SEARCH_RESULTS = 5;
// 单条结果 content 参与证据文本的截断（字符），控复判 token 成本
const EXCERPT_MAX_CHARS = 400;

function searchQueryOf(item) {
  return String(item?.title || '').trim().slice(0, QUERY_MAX_CHARS);
}

/** 前 5 条结果拼成证据文本：[n] 标题 / URL / 内容截断。 */
function buildWebEvidence(sources) {
  return (Array.isArray(sources) ? sources : [])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((source, index) => {
      const title = String(source?.title || '').trim();
      const url = String(source?.url || '').trim();
      const content = String(source?.content || source?.excerpt || '').trim().slice(0, EXCERPT_MAX_CHARS);
      return `[${index + 1}] ${title}\n${url}\n${content}`;
    })
    .filter(block => block.replace(/\[\d+\]\s*/, '').trim())
    .join('\n\n');
}

/**
 * 对 hold/discard 的审核建议做联网查证复判（fail-open，绝不抛错）。
 *
 * @param {object} item - 候选条目（取 title 作查询词）
 * @param {object|null} advice - 待复核的审核建议；非 hold/discard 原样返回
 * @param {object} [options] - searchTavily/reviewFn 注入 + 透传 reviewCandidate 选项
 * @returns {Promise<object|null>} 复判成功采用新 advice，否则原 advice；均尽力挂 web_verification
 */
async function verifyAdviceWithWeb(item, advice, options = {}) {
  if (!advice || (advice.verdict !== 'hold' && advice.verdict !== 'discard')) return advice;
  const query = searchQueryOf(item);
  if (!query) return advice;

  const searchedAt = options.now || new Date().toISOString();
  const search = options.searchTavily || searchTavily;
  const review = options.reviewFn || options.reviewCandidate || reviewCandidate;

  let searchResult;
  try {
    // 白名单传参：绝不把上层 options（含 LLM apiKey/provider/config）透传给 Tavily
    searchResult = await search({
      query,
      maxResults: MAX_SEARCH_RESULTS,
      ...(Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.fetchImpl === 'function' ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    return {
      ...advice,
      web_verification: {
        query,
        searched_at: searchedAt,
        search_error: String(error?.code || error?.message || 'search_failed'),
      },
    };
  }

  if (!searchResult || searchResult.ok !== true) {
    return {
      ...advice,
      web_verification: {
        query,
        searched_at: searchedAt,
        search_error: String(searchResult?.code || searchResult?.error || 'search_failed'),
      },
    };
  }

  const sources = Array.isArray(searchResult.sources) ? searchResult.sources : [];
  const verification = {
    query,
    searched_at: searchedAt,
    results: sources.slice(0, MAX_SEARCH_RESULTS).map(source => ({
      title: String(source?.title || '').trim(),
      url: String(source?.url || '').trim(),
    })),
  };
  const webEvidence = buildWebEvidence(sources);
  // 无有效证据时复判只会浪费一次 LLM 调用，直接保留原建议
  if (!webEvidence) return { ...advice, web_verification: verification };

  try {
    const revised = await review(item, { ...options, webEvidence });
    if (revised && revised.verdict) return { ...revised, web_verification: verification };
  } catch {
    /* 复判失败保留原 advice，痕迹照挂 */
  }
  return { ...advice, web_verification: verification };
}

module.exports = {
  verifyAdviceWithWeb,
};
