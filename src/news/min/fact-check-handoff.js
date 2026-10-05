'use strict';

const crypto = require('crypto');
const { revisionOfMinStore } = require('./min-store');
const { reviewAssessmentGate } = require('../classify/review-assessment');

const MAX_BATCH_SIZE = 10;
const MAX_SOURCES = 5;
const CONCLUSIONS = Object.freeze(['supports', 'contradicts', 'inconclusive']);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprintOf(candidate) {
  const advice = candidate?.ai_advice || {};
  return digest([
    candidate?.id, candidate?.title, candidate?.url, candidate?.published_at,
    advice.verdict, advice.generated_at, advice.fact_check?.claim, advice.fact_check?.query,
    advice.web_verification?.search_error,
  ]);
}

function isFactCheckCandidate(candidate, includeHistorical = false) {
  const advice = candidate?.ai_advice;
  if (candidate?.review_status !== 'pending' || candidate.reviewed_at || !advice) return false;
  if (candidate.fact_check_rescreen?.status === 'failed') return false;
  if (!['approve', 'hold', 'discard'].includes(advice.verdict)) return false;
  const verification = advice.web_verification || {};
  if (verification.status === 'completed') return false;
  if (advice.fact_check?.needed === true) return true;
  return ['hold', 'discard'].includes(advice.verdict)
    && includeHistorical && Boolean(verification.search_error);
}

function assertKeysOnly(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label}包含不支持的字段`);
}

function taskFor(candidate) {
  const advice = candidate.ai_advice || {};
  const verification = advice.web_verification || {};
  const claim = String(advice.fact_check?.claim || '').trim();
  return {
    id: String(candidate.id),
    fingerprint: fingerprintOf(candidate),
    candidate_context: {
      title: String(candidate.title || '').slice(0, 240),
      url: String(candidate.url || '').slice(0, 1000),
      published_at: candidate.published_at || null,
      description: String(candidate.description || '').slice(0, 1200),
    },
    claim: claim || null,
    query: String(advice.fact_check?.query || candidate.title || '').slice(0, 120),
    reasons: (Array.isArray(advice.reasons) ? advice.reasons : []).slice(0, 3).map(reason => String(reason).slice(0, 240)),
    source: advice.fact_check?.needed === true ? 'l2_fact_check' : 'historical_search_failure',
  };
}

function scoreOf(candidate) {
  const score = Number(candidate?.final_score ?? candidate?.score);
  return Number.isFinite(score) ? score : -Infinity;
}

function createFactCheckBatch(store, options = {}) {
  const requestedLimit = Number(options.limit ?? MAX_BATCH_SIZE);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_BATCH_SIZE) {
    throw new Error(`查证批次 limit 必须为 1–${MAX_BATCH_SIZE}`);
  }
  const requestedIds = options.ids == null ? null : new Set(options.ids.map(String));
  if (requestedIds?.size > MAX_BATCH_SIZE) throw new Error(`查证批次最多选择 ${MAX_BATCH_SIZE} 条`);
  const candidates = (store?.candidates || []).filter(candidate => isFactCheckCandidate(candidate, options.includeHistorical === true));
  if (requestedIds && candidates.filter(item => requestedIds.has(String(item.id))).length !== requestedIds.size) {
    throw new Error('指定候选中有记录不在待查证队列或已经人工审核');
  }
  const selected = candidates
    .filter(item => !requestedIds || requestedIds.has(String(item.id)))
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, requestedLimit);
  const tasks = selected.map(taskFor);
  const batchId = digest(tasks.map(task => [task.id, task.fingerprint])).slice(0, 24);
  return {
    schema_version: 1,
    kind: 'news_fact_check_batch',
    mode: 'codex_mcp',
    search_tool: 'webSearchPrime',
    batch_id: batchId,
    exported_at: options.now || new Date().toISOString(),
    base_revision: revisionOfMinStore(store),
    task_count: tasks.length,
    instructions: '使用 Zhipu Coding Plan 的 webSearchPrime MCP 查证每条任务。历史任务可能没有 claim；只从标题、简介和审核理由中找出明确事实主张，找不到或无法判断时填 inconclusive，不要推测。只返回事实结论和来源，不批准或丢弃候选。结果需包含 schema_version=1、kind=news_fact_check_results、mode=codex_mcp、search_tool=webSearchPrime、原 batch_id，以及每条 task 的 id/fingerprint/conclusion/summary/sources。结论只能是 supports、contradicts、inconclusive；每条来源包含 title、url、excerpt，可选 published_at。',
    result_template: {
      schema_version: 1,
      kind: 'news_fact_check_results',
      mode: 'codex_mcp',
      search_tool: 'webSearchPrime',
      batch_id: batchId,
      results: tasks.map(task => ({
        id: task.id,
        fingerprint: task.fingerprint,
        source: task.source,
        conclusion: 'inconclusive',
        summary: '',
        sources: [],
      })),
    },
    tasks,
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('查证来源格式无效');
  assertKeysOnly(source, ['title', 'url', 'excerpt', 'published_at'], '查证来源');
  const title = String(source.title || '').trim().slice(0, 240);
  if (!title) throw new Error('查证来源缺少标题');
  const url = String(source.url || '').trim().slice(0, 1200);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('查证来源必须是有效 HTTP(S) URL');
  return {
    title,
    url,
    excerpt: String(source.excerpt || '').trim().slice(0, 1000),
    ...(source.published_at ? { published_at: String(source.published_at).slice(0, 80) } : {}),
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('查证结果格式无效');
  assertKeysOnly(result, ['id', 'fingerprint', 'source', 'conclusion', 'summary', 'sources'], '查证结果');
  const id = String(result.id || '').trim();
  const fingerprint = String(result.fingerprint || '');
  if (!id || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('查证结果缺少有效 id 或 fingerprint');
  if (!['l2_fact_check', 'historical_search_failure'].includes(result.source)) throw new Error('查证结果缺少有效任务来源');
  if (!CONCLUSIONS.includes(result.conclusion)) throw new Error(`查证结论无效：${result.conclusion}`);
  const sources = Array.isArray(result.sources) ? result.sources.slice(0, MAX_SOURCES).map(normalizeSource) : [];
  if (result.conclusion !== 'inconclusive' && sources.length === 0) throw new Error(`${id} 的支持/反驳结论必须附来源`);
  return {
    id,
    fingerprint,
    source: result.source,
    conclusion: result.conclusion,
    summary: String(result.summary || '').trim().slice(0, 1000),
    sources,
  };
}

function importFactCheckResults(store, payload, options = {}) {
  if (!payload || payload.schema_version !== 1 || payload.kind !== 'news_fact_check_results'
    || payload.mode !== 'codex_mcp' || payload.search_tool !== 'webSearchPrime'
    || !String(payload.batch_id || '').trim() || !Array.isArray(payload.results)) {
    throw new Error('查证结果文件 schema 无效');
  }
  assertKeysOnly(payload, ['schema_version', 'kind', 'mode', 'search_tool', 'batch_id', 'results'], '查证结果文件');
  if (payload.results.length < 1 || payload.results.length > MAX_BATCH_SIZE) throw new Error(`结果数量必须为 1–${MAX_BATCH_SIZE}`);
  const results = payload.results.map(normalizeResult);
  const ids = new Set(results.map(result => result.id));
  if (ids.size !== results.length) throw new Error('查证结果中有重复候选 ID');
  const candidates = new Map((store.candidates || []).map(candidate => [String(candidate.id), candidate]));
  for (const result of results) {
    const candidate = candidates.get(result.id);
    if (!isFactCheckCandidate(candidate, result.source === 'historical_search_failure') || fingerprintOf(candidate) !== result.fingerprint) {
      throw new Error(`候选 ${result.id} 已变化、已审核或不再需要查证；请重新导出任务`);
    }
  }
  const completedAt = options.now || new Date().toISOString();
  for (const result of results) {
    const candidate = candidates.get(result.id);
    const verification = { ...(candidate.ai_advice.web_verification || {}) };
    delete verification.search_error;
    candidate.ai_advice.web_verification = {
      ...verification,
      status: 'completed',
      provider: 'zhipu_web_search_prime_mcp',
      method: 'codex_mcp_handoff',
      batch_id: String(payload.batch_id || '').slice(0, 80) || null,
      claim: candidate.ai_advice.fact_check?.claim || null,
      query: candidate.ai_advice.fact_check?.query || candidate.title || '',
      conclusion: result.conclusion,
      summary: result.summary,
      sources: result.sources,
      completed_at: completedAt,
    };
    if (candidate.ai_advice.assessment) {
      candidate.ai_advice.assessment_gate_preview = reviewAssessmentGate(
        candidate.ai_advice.verdict,
        candidate.ai_advice.assessment,
        candidate.ai_advice.fact_check,
        candidate.ai_advice.web_verification,
      );
    }
  }
  store.updated_at = completedAt;
  return { store, imported: results.length, conclusions: results.reduce((counts, result) => ({ ...counts, [result.conclusion]: counts[result.conclusion] + 1 }), { supports: 0, contradicts: 0, inconclusive: 0 }) };
}

module.exports = {
  MAX_BATCH_SIZE,
  fingerprintOf,
  isFactCheckCandidate,
  createFactCheckBatch,
  importFactCheckResults,
};
