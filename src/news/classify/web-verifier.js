/**
 * web-verifier.js —— 按 L2 事实主张路由人工 MCP 或直接 Web Search 查证
 *
 * 背景：审核 LLM 只靠训练记忆判断真伪，会把真实存在的最新模型误判为"编造"。
 * 只有 advice.fact_check 明确标出可核实事实时才查证。Codex MCP 方式登记人工任务；
 * 直连 Web Search API 将结果追加进审核 prompt 复判。
 *
 * 铁律：全程 fail-open —— 搜索失败/复判失败/任何异常都不向上抛，
 * 绝不阻断审核流程；失败时原 advice 原样返回，
 * 尽力挂 web_verification 痕迹（随 ai_advice 持久化，供人工追溯）。
 *
 * 注入点：options.searchWeb / options.reviewFn 可替换真实实现（测试 mock 用）。
 * search 只接收白名单参数（provider/providerOptions/query/maxResults/timeoutMs/fetchImpl），上层审核 LLM 的
 * apiKey/provider/model/config 绝不透传给 Web Search transport（防跨服务凭据泄漏与限流被误判
 * AUTH_REQUIRED）；复判 review 仍按 l2AiAdvice 的方式透传 options 给 reviewCandidate。
 */

'use strict';

const { searchWeb } = require('../../shared/web-search');
const { reviewCandidate } = require('./content-reviewer');

// 查询词截断（字符）与参与复判的结果条数
const QUERY_MAX_CHARS = 120;
const MAX_SEARCH_RESULTS = 5;
// 单条结果 content 参与证据文本的截断（字符），控复判 token 成本
const EXCERPT_MAX_CHARS = 400;

function createWebSearchBudget(limit = 10) {
  const max = Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : 10;
  let used = 0;
  return Object.freeze({
    reserve(amount = 1) {
      const count = Number(amount);
      if (!Number.isInteger(count) || count < 0) return { ok: false, code: 'WEB_SEARCH_BUDGET_INVALID' };
      if (used + count > max) return { ok: false, code: 'WEB_SEARCH_BUDGET_EXHAUSTED', remaining: Math.max(0, max - used) };
      used += count;
      return { ok: true, used, remaining: max - used };
    },
    snapshot() { return { limit: max, used, remaining: Math.max(0, max - used) }; },
  });
}

function searchProviderOf(options = {}) {
  return options.searchProvider || options.config?.review?.web_search_provider || 'zhipu_web_search';
}

function searchEngineOf(options = {}) {
  return options.searchEngine || options.config?.review?.web_search_engine || 'search_std';
}

function factCheckModeOf(config) {
  return String(config?.review?.fact_check_mode || 'off');
}

function searchQueryOf(item, advice) {
  return String(advice?.fact_check?.query || advice?.fact_check?.claim || item?.title || '').trim().slice(0, QUERY_MAX_CHARS);
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
 * 对明确标记了关键事实主张的审核建议做联网查证复判（fail-open，绝不抛错）。
 *
 * @param {object} item - 候选条目（取 title 作查询词）
 * @param {object|null} advice - 待复核的审核建议；非 hold/discard 原样返回
 * @param {object} [options] - searchWeb/reviewFn 注入 + 透传 reviewCandidate 选项
 * @returns {Promise<object|null>} 复判成功采用新 advice，否则原 advice；均尽力挂 web_verification
 */
async function verifyAdviceWithWeb(item, advice, options = {}) {
  if (!advice || !['approve', 'hold', 'discard'].includes(advice.verdict)) return advice;
  const claim = String(advice.fact_check?.claim || '').trim();
  if (advice.fact_check?.needed !== true || claim.length < 8) return advice;
  const mode = options.factCheckMode || factCheckModeOf(options.config);
  if (mode === 'off') return advice;
  const query = searchQueryOf(item, advice);
  if (!query) return advice;

  const searchedAt = options.now || new Date().toISOString();
  if (mode === 'codex_mcp') {
    return { ...advice, web_verification: {
      status: 'awaiting_agent', provider: 'zhipu_web_search_prime_mcp', claim, query, requested_at: searchedAt,
    } };
  }
  if (mode !== 'web_search_api') {
    return { ...advice, web_verification: {
      status: 'failed', claim, query, searched_at: searchedAt, search_error: 'FACT_CHECK_MODE_UNSUPPORTED',
    } };
  }
  const provider = searchProviderOf(options);
  const engine = searchEngineOf(options);
  if (provider === 'zhipu_web_search') {
    const budget = options.searchBudget;
    const reserved = budget?.reserve ? budget.reserve(1) : { ok: false, code: 'WEB_SEARCH_BUDGET_REQUIRED' };
    if (!reserved.ok) {
      return {
        ...advice,
        web_verification: {
          status: 'failed', claim,
          query,
          searched_at: searchedAt,
          search_error: reserved.code || 'WEB_SEARCH_BUDGET_EXHAUSTED',
          provider,
        },
      };
    }
  }
  const search = options.searchWeb || searchWeb;
  const review = options.reviewFn || options.reviewCandidate || reviewCandidate;

  let searchResult;
  try {
    // 白名单传参：绝不把上层 options（含 LLM apiKey/provider/config）透传给搜索 transport
    searchResult = await search({
      provider,
      query,
      maxResults: MAX_SEARCH_RESULTS,
      apiKey: options.webSearchApiKey,
      providerOptions: { engine },
      ...(Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.fetchImpl === 'function' ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    return {
      ...advice,
      web_verification: {
        status: 'failed', claim,
        query,
        searched_at: searchedAt,
        provider,
        search_error: String(error?.code || error?.message || 'search_failed'),
      },
    };
  }

  if (!searchResult || searchResult.ok !== true) {
    return {
      ...advice,
      web_verification: {
        status: 'failed', claim,
        query,
        searched_at: searchedAt,
        provider,
        search_error: String(searchResult?.code || searchResult?.error || 'search_failed'),
      },
    };
  }

  const sources = Array.isArray(searchResult.sources) ? searchResult.sources : [];
  const verification = {
    status: 'completed', claim,
    query,
    searched_at: searchedAt,
    provider,
    engine,
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
  createWebSearchBudget,
  factCheckModeOf,
  verifyAdviceWithWeb,
};
