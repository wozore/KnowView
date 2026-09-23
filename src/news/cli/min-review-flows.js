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
const { nonNegativeInteger, countRepairWork } = require('../min/enrichment-core');
const { createWebSearchBudget } = require('../classify/web-verifier');

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

/**
 * enrich 流：GLM 初审/摘要/本地化，衔接残缺修复。
 * 无待处理项且未 --force 时短路返回 enriched:null。
 */
async function runEnrichFlow(store, config, flags) {
  const work = parseWorkFlags(flags);
  const searchBudget = config?.review?.web_search_provider === 'zhipu_web_search'
    ? createWebSearchBudget(config?.review?.web_verify_max_searches_per_run)
    : null;
  const stats = countEnrichmentWork(store.candidates, {
    l2Enabled: config?.review?.l2_enabled !== false,
    webVerifyEnabled: config?.review?.web_verify !== false,
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
      webVerifyEnabled: config?.review?.web_verify !== false,
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
  const searchBudget = config?.review?.web_search_provider === 'zhipu_web_search'
    ? createWebSearchBudget(config?.review?.web_verify_max_searches_per_run)
    : null;
  const stats = countRepairWork(store.candidates, {
    l2Enabled: config?.review?.l2_enabled !== false,
    webVerifyEnabled: config?.review?.web_verify !== false,
    skipReview: work.skipReview,
    skipSummary: work.skipSummary,
    skipLocalize: work.skipLocalize,
  });
  if (!stats.hasWork) {
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
    searchBudget,
  });

  const { result: reviewListResult, skipped: reviewListSkipped } = refreshReviewListSafe(store, config, work);
  return { stats, repaired, review_list: reviewListResult, review_list_skipped: reviewListSkipped };
}

module.exports = {
  parseWorkFlags,
  runEnrichFlow,
  runRepairFlow,
};
