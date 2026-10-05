/**
 * min-review-flows.js —— min-review enrich / repair 两个本地加工流的编排。
 *
 * enrich：GLM 初审/摘要/本地化分批编排（断点续跑），完成后默认衔接
 * GLM 残缺修复与待审清单刷新。
 * repair：使用 GLM 修复残缺数据；--no-external 被拒绝。
 * 两个流都返回结构化结果；人类可读输出由 scripts/news-cli.js 壳打印。
 */

'use strict';

const { buildReviewList } = require('../min/review-list');
const { enrichMinCandidates, countEnrichmentWork } = require('../min/local-enrichment');
const { repairIncompleteCandidates } = require('../min/min-repair');
const { nonNegativeInteger, countRepairWork, executeL2OnlyAdvice, needsL1Review, needsStructuredRescreen } = require('../min/enrichment-core');
const { createWebSearchBudget } = require('../classify/web-verifier');
const { runPool } = require('../classify/content-reviewer');
const {
  readMinStore,
  revisionOfMinStore,
  commitMinStoreMutation,
} = require('../min/min-store');
const { readJson } = require('../../shared/json-store');
const { createFactCheckBatch, fingerprintOf, importFactCheckResults } = require('../min/fact-check-handoff');

/** 把 flags 解析为 enrich/repair 共用的加工参数。 */
function parseWorkFlags(flags) {
  if (flags.no_external === true) throw new Error('当前初审只使用 GLM，不能使用 --no-external');
  return {
    batchSize: flags.batch_size ? Number(flags.batch_size) : 30,
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    limit: flags.limit != null ? nonNegativeInteger(flags.limit, undefined, '--limit') : undefined,
    skipReview: flags.skip_review === true,
    skipSummary: flags.skip_summary === true,
    skipLocalize: flags.skip_localize === true,
    force: flags.force === true,
    dryRun: flags.dry_run === true,
    refreshReviewList: !flags.no_refresh_review_list,
    externalEnabled: flags.no_external !== true,
  };
}

/** 刷新待审清单（保留人工已审状态）；--no-refresh-review-list 跳过。 */
function refreshReviewListSafe(store, config, work) {
  if (work.dryRun) return { result: null, skipped: false };
  if (!work.refreshReviewList) return { result: null, skipped: true };
  return { result: buildReviewList(store, config, { updateSummaries: true }), skipped: false };
}

function repairIdsOf(flags) {
  if (flags.ids === undefined) return undefined;
  if (flags.ids === true || flags.ids === null) throw new Error('--ids 必须是逗号分隔的候选 ID 列表');
  const values = Array.isArray(flags.ids) ? flags.ids : String(flags.ids).split(',');
  const ids = [...new Set(values.map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length || ids.length > 100) throw new Error('--ids 必须包含 1–100 个候选 ID');
  return ids;
}

function tavilyFailedPending(candidate, allowRetry = false) {
  return candidate?.review_status === 'pending' && !candidate.reviewed_at
    && ['hold', 'discard'].includes(candidate.ai_advice?.verdict)
    && candidate.ai_advice?.web_verification?.search_error === 'TAVILY_SEARCH_FAILED'
    && (allowRetry || candidate.fact_check_rescreen?.status !== 'failed');
}

function rescreenTargets(store, flags) {
  const limit = Number(flags.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('--limit 必须是 1–10 的整数');
  const ids = flags.ids == null ? null : new Set(String(flags.ids).split(',').map(id => id.trim()).filter(Boolean));
  const eligible = (store.candidates || []).filter(item => tavilyFailedPending(item, Boolean(ids)));
  if (ids && (!ids.size || [...ids].some(id => !eligible.some(item => String(item.id) === id)))) {
    throw new Error('--ids 中含非 Tavily 初审失败候选');
  }
  return eligible.filter(item => !ids || ids.has(String(item.id)))
    .sort((a, b) => (Number(b.final_score) || 0) - (Number(a.final_score) || 0))
    .slice(0, limit);
}

async function rescreenFactCheckBatch(store, config, flags, deps = {}) {
  if (config?.review?.l2_enabled === false) throw new Error('L2 已关闭，拒绝重新筛查');
  const targets = rescreenTargets(store, flags);
  if (!targets.length) return {
    selected: 0, updated: 0, fact_check_needed: 0, no_search_needed: 0, failed: 0,
    failed_marked: 0, failed_ids: [], errors: [],
  };
  const getRevision = deps.revisionOfMinStore || revisionOfMinStore;
  const commit = deps.commitMinStoreMutation || commitMinStoreMutation;
  const baseRevision = getRevision(store);
  const outputs = structuredClone(targets);
  const concurrency = Math.max(1, Math.min(Number(flags.concurrency) || 3, 5));
  await runPool(outputs, concurrency, async item => {
    const previous = structuredClone(item.ai_advice);
    try {
      await executeL2OnlyAdvice(item, config, { reviewCandidate: deps.reviewCandidate, config });
    } catch (error) {
      item.ai_advice = previous;
      item.fact_check_rescreen_failed = true;
      item.fact_check_rescreen_error = String(error?.code || error?.message || 'L2 request failed').slice(0, 120);
      return;
    }
    if (!item.ai_advice?.verdict) {
      item.fact_check_rescreen_error = String(item.ai_advice?.llm_error || 'L2 returned no verdict').slice(0, 120);
      item.ai_advice = previous;
      item.fact_check_rescreen_failed = true;
    }
  });
  const successful = outputs.filter(item => item.fact_check_rescreen_failed !== true);
  const failedOutputs = outputs.filter(item => item.fact_check_rescreen_failed === true);
  const attemptedAt = new Date().toISOString();
  const committed = successful.length || failedOutputs.length
    ? commit(current => {
      const currentById = new Map(current.candidates.map(candidate => [String(candidate.id), candidate]));
      let updated = 0;
      let failedMarked = 0;
      for (const result of [...successful, ...failedOutputs]) {
        const candidate = currentById.get(String(result.id));
        const source = targets.find(item => String(item.id) === String(result.id));
        if (!candidate || !tavilyFailedPending(candidate, Boolean(flags.ids)) || fingerprintOf(candidate) !== fingerprintOf(source)) continue;
        if (result.fact_check_rescreen_failed) {
          candidate.fact_check_rescreen = {
            status: 'failed',
            attempted_at: attemptedAt,
            error: result.fact_check_rescreen_error || 'L2 request failed',
          };
          failedMarked += 1;
        } else {
          candidate.ai_advice = result.ai_advice;
          delete candidate.fact_check_rescreen;
          updated += 1;
        }
      }
      const changed = updated + failedMarked;
      if (changed) current.updated_at = attemptedAt;
      return { store: current, changed, updated, failed_marked: failedMarked };
    }, { expectedRevision: baseRevision, runId: `min-fact-check-rescreen-${Date.now()}` })
    : { updated: 0, failed_marked: 0 };
  return {
    selected: targets.length,
    updated: committed.updated,
    fact_check_needed: successful.filter(item => item.ai_advice?.fact_check?.needed === true).length,
    no_search_needed: successful.filter(item => item.ai_advice?.fact_check?.needed !== true).length,
    failed: targets.length - successful.length,
    failed_marked: committed.failed_marked,
    failed_ids: outputs.filter(item => item.fact_check_rescreen_failed === true).map(item => String(item.id)),
    errors: outputs.filter(item => item.fact_check_rescreen_failed === true).map(item => ({
      id: String(item.id),
      error: item.fact_check_rescreen_error || 'L2 request failed',
    })),
  };
}

async function runFactCheckCommand(action, flags, config, deps = {}) {
  if (config?.review?.fact_check_mode !== 'codex_mcp') throw new Error(`${action} 只在 review.fact_check_mode=codex_mcp 时可用`);
  const readStore = deps.readStore || readMinStore;
  if (action === 'fact-check-list') {
    const limit = flags.limit == null ? 10 : Number(flags.limit);
    const ids = flags.ids == null ? null : [...new Set(String(flags.ids).split(',').map(id => id.trim()).filter(Boolean))];
    if (ids && (!ids.length || ids.length > 10)) throw new Error('--ids 必须包含 1–10 个候选 ID');
    return createFactCheckBatch(readStore(), { limit, ids, includeHistorical: flags.include_history === true });
  }
  if (action === 'fact-check-rescreen') return rescreenFactCheckBatch(readStore(), config, flags, deps);
  if (action === 'fact-check-import') {
    if (!flags.file) throw new Error('fact-check-import 缺少 --file（Codex 查证结果 JSON）');
    const payload = (deps.readJson || readJson)(flags.file, null);
    const current = readStore();
    const revision = (deps.revisionOfMinStore || revisionOfMinStore)(current);
    const commit = deps.commitMinStoreMutation || commitMinStoreMutation;
    const result = commit(store => importFactCheckResults(store, payload), {
      expectedRevision: revision,
      runId: `min-fact-check-import-${Date.now()}`,
    });
    const { store, ...summary } = result;
    return summary;
  }
  throw new Error(`未知事实查证命令：${action}`);
}

/**
 * enrich 流：GLM 初审/摘要/本地化，衔接残缺修复。
 * 无待处理项且未 --force 时短路返回 enriched:null。
 */
async function runEnrichFlow(store, config, flags) {
  if (flags.ids !== undefined) throw new Error('--ids 当前仅支持 min-review repair');
  const work = parseWorkFlags(flags);
  const searchBudget = config?.review?.fact_check_mode === 'web_search_api'
    ? createWebSearchBudget(config?.review?.web_search_max_requests_per_run)
    : null;
  const stats = countEnrichmentWork(store.candidates, {
    l2Enabled: config?.review?.l2_enabled !== false,
    skipReview: work.skipReview,
    skipSummary: work.skipSummary,
    skipLocalize: work.skipLocalize,
    force: work.force,
  });
  const concurrency = work.concurrency || config.collection?.concurrency || 5;

  if (!stats.hasWork && !work.force) {
    return { stats, enriched: null };
  }

  // 批次进度记录（人类可读输出由 scripts/news-cli.js 壳打印）
  const batchLog = [];
  const onBatchDone = ({ batchIndex, totalBatches, batchSize: currentBatchSize, stats: bStats }) => {
    batchLog.push({ batchIndex, totalBatches, batchSize: currentBatchSize, ...bStats });
  };

  const enriched = await enrichMinCandidates(store, config, {
    batchSize: work.batchSize,
    concurrency: work.concurrency,
    limit: work.limit,
    skipReview: work.skipReview,
    skipSummary: work.skipSummary,
    skipLocalize: work.skipLocalize,
    force: work.force,
    dryRun: work.dryRun,
    searchBudget,
    onBatchDone,
  });

  let repaired = null;
  let repairTotal = null;
  if (!flags.no_repair && !work.dryRun) {
    const repairWork = countRepairWork(store.candidates, {
      l2Enabled: config?.review?.l2_enabled !== false,
      skipReview: work.skipReview,
      skipSummary: work.skipSummary,
      skipLocalize: work.skipLocalize,
    });
    if (repairWork.hasWork) {
      repairTotal = repairWork.total;
      repaired = await repairIncompleteCandidates(store, config, {
        limit: work.limit,
        externalEnabled: work.externalEnabled,
        skipReview: work.skipReview,
        skipSummary: work.skipSummary,
        skipLocalize: work.skipLocalize,
        searchBudget,
      });
    }
  }

  const { result: reviewListResult, skipped: reviewListSkipped } = refreshReviewListSafe(store, config, work);
  return { stats, concurrency, batchLog, enriched, repaired, repair_total: repairTotal, review_list: reviewListResult, review_list_skipped: reviewListSkipped };
}

/** repair 流：GLM 修复残缺数据；无残缺项时短路返回 repaired:null。 */
async function runRepairFlow(store, config, flags) {
  const work = parseWorkFlags(flags);
  const ids = repairIdsOf(flags);
  const scopedCandidates = ids ? store.candidates.filter(item => ids.includes(String(item.id))) : store.candidates;
  if (ids && scopedCandidates.length !== ids.length) throw new Error('--ids 包含不存在的候选 ID');
  if (flags.rescreen_structured === true) {
    if (!ids) throw new Error('--rescreen-structured 必须配合明确的 --ids 使用');
    if (!Number.isInteger(work.limit) || work.limit < 1 || work.limit > ids.length) {
      throw new Error('--rescreen-structured 必须显式设置 1 到 --ids 条数之间的 --limit');
    }
    if (!work.skipSummary || !work.skipLocalize || work.skipReview) {
      throw new Error('--rescreen-structured 仅运行初审，必须使用 --skip-summary --skip-localize，且不能使用 --skip-review');
    }
    const ineligible = scopedCandidates.filter(item => !needsStructuredRescreen(item) && !needsL1Review(item));
    if (ineligible.length) throw new Error(`--rescreen-structured 只接受未人工定案且缺少完整 L1 结论的 pending 候选：${ineligible.map(item => item.id).join(',')}`);
  }
  const searchBudget = config?.review?.fact_check_mode === 'web_search_api'
    ? createWebSearchBudget(config?.review?.web_search_max_requests_per_run)
    : null;
  let stats = countRepairWork(scopedCandidates, {
    l2Enabled: config?.review?.l2_enabled !== false,
    skipReview: work.skipReview,
    skipSummary: work.skipSummary,
    skipLocalize: work.skipLocalize,
  });
  if (flags.rescreen_structured === true) {
    stats = { ...stats, total: scopedCandidates.length, review: scopedCandidates.length, hasWork: scopedCandidates.length > 0 };
  }
  if (!stats.hasWork && flags.rescreen_structured !== true) {
    return { stats, repaired: null };
  }

  const repaired = await repairIncompleteCandidates(store, config, {
    limit: work.limit,
    concurrency: work.concurrency,
    externalEnabled: work.externalEnabled,
    dryRun: work.dryRun,
    skipReview: work.skipReview,
    skipSummary: work.skipSummary,
    skipLocalize: work.skipLocalize,
    rescreenStructured: flags.rescreen_structured === true,
    searchBudget,
    ids,
  });

  const { result: reviewListResult, skipped: reviewListSkipped } = refreshReviewListSafe(store, config, work);
  return { stats, repaired, review_list: reviewListResult, review_list_skipped: reviewListSkipped };
}

module.exports = {
  parseWorkFlags,
  repairIdsOf,
  runFactCheckCommand,
  runEnrichFlow,
  runRepairFlow,
};
