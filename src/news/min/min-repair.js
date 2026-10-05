/**
 * min-repair.js —— 热点初审残缺数据 GLM 修复。
 *
 * 正常运行只启用通道 B（智谱 GLM）；注入替身请求的离线测试仍覆盖通道 A 的合并门禁。
 * 残缺判定、单条审核执行与并发安全落盘共用 enrichment-core.js。
 */

'use strict';

const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates, hasUsableLocalizedContent } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { revisionOfMinStore } = require('./min-store');
const { getProvider, DEFAULT_PROVIDER_NAME, apiKeyForProvider } = require('../../shared/providers');
const {
  needsL1Review,
  needsStructuredRescreen,
  needsL2Advice,
  needsSummary,
  needsLocalize,
  needsRepair,
  countRepairWork,
  executeCandidateReview,
  executeL2OnlyAdvice,
  guardedWriteStore,
  nonNegativeInteger,
} = require('./enrichment-core');
const { createWebSearchBudget } = require('../classify/web-verifier');

const DEFAULT_REPAIR_LIMIT = 100;

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function transientAiFailure(error) {
  return /\bHTTP (?:429|5\d\d)\b|network failure|network error|LOCALIZATION_(?:ECHO_UNTRANSLATED|PARTIAL_OUTPUT)/i.test(String(error || ''));
}

async function repairContentStage(items, options, needs, errorOf, run, countKey) {
  const targets = items.filter(c => c.review_status !== 'discarded' && needs(c));
  const concurrency = options.concurrency || 3;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  let completed = 0;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0 && (options.external !== true || retryDelayMs <= 0)) break;
    const work = attempt === 0 ? targets : targets.filter(c => needs(c) && transientAiFailure(errorOf(c)));
    if (!work.length) break;
    if (attempt > 0) await sleepMs(retryDelayMs * (attempt === 1 ? 1 : 3));
    try {
      const result = await run(work, { ...options, concurrency: Math.max(1, Math.floor(concurrency / (attempt + 1))) });
      completed += result?.[countKey] || 0;
    } catch { break; }
  }
  return completed;
}

/**
 * 运行单个通道的初审、摘要与翻译处理。
 * 摘要/翻译对 429/5xx/网络故障及翻译原样复述/缺字段最多补做两轮，退避 5s/15s 并逐轮降低并发。
 * @returns {Promise<{ reviewed: number, summarized: number, localized: number }>}
 */
async function runRepairChannel(items, config, channelOpts) {
  const stats = { reviewed: 0, summarized: 0, localized: 0 };
  const conc = channelOpts.concurrency || 3;
  const locale = channelOpts.locale || 'zh';

  // 1. 审核：缺 L1 的走完整流程；仅缺 L2 建议的只补建议（不重跑 L1、不改状态）
  if (!channelOpts.skipReview) {
    const l1Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status === 'discarded' || c.review_status === 'approved') return false;
      return needsL1Review(c) || (channelOpts.rescreenStructured === true && needsStructuredRescreen(c));
    });
    const l2Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status !== 'pending') return false;
      return needsL2Advice(c, channelOpts.l2Enabled !== false);
    });
    if (l1Targets.length > 0) {
      await runPool(l1Targets, conc, async item => {
        try {
          await executeCandidateReview(item, config, channelOpts);
          if (item.l1_review?.verdict) stats.reviewed += 1;
        } catch (error) {
          const message = error?.message || String(error);
          item.l1_review = { verdict: null, reasons: [], confidence: 0, llm_error: message };
          item.ai_advice = channelOpts.rescreenStructured === true && item.ai_advice?.verdict
            ? item.ai_advice
            : { verdict: null, reasons: [], confidence: 0, reviewer: 'llm_failed', llm_error: message };
        }
      });
    }
    if (l2Targets.length > 0) {
      await runPool(l2Targets, conc, async item => {
        try {
          await executeL2OnlyAdvice(item, config, channelOpts);
          if (item.ai_advice?.verdict) stats.reviewed += 1;
        } catch {
          /* 隔离异常 */
        }
      });
    }
  }

  if (!channelOpts.skipSummary) {
    stats.summarized = await repairContentStage(items, channelOpts, needsSummary,
      c => c.summary_llm_error, summarizeCandidates, 'summarized');
  }
  if (!channelOpts.skipLocalize) {
    stats.localized = await repairContentStage(items, channelOpts, c => needsLocalize(c, locale),
      c => c.localizations_meta?.[locale]?.llm_error, localizeCandidates, 'localized');
  }

  return stats;
}

/**
 * 热点初审残缺数据 GLM 修复机制。
 * - 原子落盘，遵守不变式：受保护的字幕总结与已有人工审核标记绝不被覆盖；discarded 绝不进入摘要/翻译修复。
 *
 * @param {object} store - min store 对象 ({ candidates: [] })
 * @param {object} [config] - news-config-v2.json
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function repairIncompleteCandidates(store, config = {}, options = {}) {
  const candidates = Array.isArray(store?.candidates) ? store.candidates : [];
  const locale = options.locale || 'zh';
  const dryRun = options.dryRun === true;
  const l2Enabled = config?.review?.l2_enabled !== false;
  const searchBudget = options.searchBudget || (config?.review?.fact_check_mode === 'web_search_api'
    ? createWebSearchBudget(config?.review?.web_search_max_requests_per_run)
    : null);
  const repairLimit = nonNegativeInteger(options.limit, DEFAULT_REPAIR_LIMIT, 'options.limit');
  const selectedIds = options.ids === undefined ? null : new Set(options.ids.map(String));
  // 请求期间的基准 revision，用于并发安全落盘
  const baseRevision = revisionOfMinStore(store);

  // 1. 筛选出残缺条目
  const rawTargets = candidates.filter(c => (!selectedIds || selectedIds.has(String(c?.id))) && (needsRepair(c, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }) || (options.rescreenStructured === true && needsStructuredRescreen(c))));
  const targets = rawTargets.slice(0, repairLimit);

  const resultStats = {
    totalTargets: targets.length,
    repairedReview: 0,
    repairedSummary: 0,
    repairedLocalize: 0,
    channelASuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    channelBSuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    remainingIncomplete: 0,
    rescreenFailedIds: [],
  };

  if (targets.length === 0) {
    resultStats.remainingIncomplete = countRepairWork(candidates, {
      locale,
      l2Enabled,
      skipReview: options.skipReview === true,
      skipSummary: options.skipSummary === true,
      skipLocalize: options.skipLocalize === true,
    }).total;
    if (options.rescreenStructured === true) {
      resultStats.remainingIncomplete += candidates.filter(needsStructuredRescreen).length;
    }
    return resultStats;
  }

  // 2. 双通道数据深拷贝隔离
  const targetsA = structuredClone(targets);
  const targetsB = structuredClone(targets);

  // 3. 通道参数配置（通道 B 外部 provider 跟随全局开关，密钥按 provider 读取）
  const externalProvider = options.providerB || options.provider || DEFAULT_PROVIDER_NAME;
  const externalProviderInfo = getProvider(externalProvider) || getProvider(DEFAULT_PROVIDER_NAME);
  const channelAOpts = {
    ...options,
    timeoutMs: options.channelA?.timeoutMs ?? 30000,
    maxDescChars: options.channelA?.maxDescChars ?? 2000,
    concurrency: options.channelA?.concurrency ?? 3,
    l2Enabled,
    rescreenStructured: options.rescreenStructured === true,
    reuseExistingAdvice: options.rescreenStructured === true,
    external: false,
    apiKey: options.apiKeyA || 'local-bonsai',
    fetchImpl: options.fetchImplA || options.fetchImpl,
    reviewCandidate: options.reviewCandidateA || options.reviewCandidate,
    locale,
    config,
    searchBudget,
  };

  const externalApiKey = options.apiKeyB || options.apiKey || apiKeyForProvider(externalProviderInfo);
  const channelBOpts = {
    ...options,
    timeoutMs: options.channelB?.timeoutMs ?? 60000,
    concurrency: options.channelB?.concurrency ?? options.concurrency ?? 5,
    l2Enabled,
    rescreenStructured: options.rescreenStructured === true,
    reuseExistingAdvice: options.rescreenStructured === true,
    external: true,
    provider: externalProvider,
    model: options.channelB?.model || options.modelB || options.model || externalProviderInfo.defaultModel,
    apiKey: externalApiKey,
    // 缺密钥时外部调用必然失败（missing_api_key 非瞬时错误），关闭重试避免无谓延迟
    retryDelayMs: externalApiKey ? (options.retryDelayMs ?? 5000) : 0,
    fetchImpl: options.fetchImplB || options.fetchImpl,
    reviewCandidate: options.reviewCandidateB || options.reviewCandidate,
    locale,
    config,
    searchBudget,
  };

  // 4. 正常运行只请求 GLM；注入替身请求时验证双通道合并门禁
  const injectedLocalChannel = Boolean(options.fetchImplA || options.reviewCandidateA || options.fetchImpl || options.reviewCandidate);
  const [statsA, statsB] = await Promise.all([
    injectedLocalChannel
      ? runRepairChannel(targetsA, config, channelAOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 }))
      : Promise.resolve({ reviewed: 0, summarized: 0, localized: 0 }),
    options.externalEnabled === false
      ? Promise.resolve({ reviewed: 0, summarized: 0, localized: 0 })
      : runRepairChannel(targetsB, config, channelBOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 })),
  ]);

  resultStats.channelASuccesses = statsA;
  resultStats.channelBSuccesses = statsB;

  // 5. 将 GLM 结果合并回候选；注入替身时沿用双通道合并门禁
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const a = targetsA[i];
    const b = targetsB[i];

    // ── 审核结论合并 ──
    if (!target.reviewed_at) {
      const hadReviewDefect = needsL1Review(target)
        || needsL2Advice(target, l2Enabled)
        || (options.rescreenStructured === true && needsStructuredRescreen(target));
      if (hadReviewDefect) {
        const aSuccess = injectedLocalChannel && Boolean(a.l1_review?.verdict && (
          a.review_status !== 'pending' ||
          a.ai_advice?.verdict ||
          !l2Enabled
        ));
        const bSuccess = options.externalEnabled !== false && Boolean(b.l1_review?.verdict && (
          b.review_status !== 'pending' ||
          b.ai_advice?.verdict ||
          !l2Enabled
        ));

        if (aSuccess) {
          target.review_status = a.review_status;
          target.l1_review = a.l1_review;
          target.ai_advice = a.ai_advice;
          if (a.discard_reason) target.discard_reason = a.discard_reason; else delete target.discard_reason;
          if (a.discard_stage) target.discard_stage = a.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        } else if (bSuccess) {
          target.review_status = b.review_status;
          target.l1_review = b.l1_review;
          target.ai_advice = b.ai_advice;
          if (b.discard_reason) target.discard_reason = b.discard_reason; else delete target.discard_reason;
          if (b.discard_stage) target.discard_stage = b.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        } else if (b.l1_review || b.ai_advice) {
          if (!b.l1_review?.verdict) {
            target.l1_review = {
              ...(b.l1_review || { verdict: null, reasons: [], confidence: 0 }),
              llm_error: b.l1_review?.llm_error || b.ai_advice?.llm_error || 'GLM 未返回有效初审结论',
            };
          }
          if (b.ai_advice && !b.ai_advice.verdict) target.ai_advice = b.ai_advice;
        }
      }
    }

    // 严禁对 discarded 条目进行摘要与翻译修复
    if (target.review_status === 'discarded') {
      continue;
    }

    // ── 摘要合并（有效摘要存在时跳过；保护标记 + 空摘要允许重试补齐） ──
    if (!target.summary || !String(target.summary).trim()) {
      const aSumSuccess = Boolean(a.summary && a.summarizer !== 'llm_failed');
      const bSumSuccess = Boolean(b.summary && b.summarizer !== 'llm_failed');

      if (aSumSuccess) {
        target.summary = a.summary;
        target.summary_key_points = a.summary_key_points || [];
        target.summarizer = a.summarizer;
        target.summary_generated_at = a.summary_generated_at;
        target.summary_input_chars = a.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      } else if (bSumSuccess) {
        target.summary = b.summary;
        target.summary_key_points = b.summary_key_points || [];
        target.summarizer = b.summarizer;
        target.summary_generated_at = b.summary_generated_at;
        target.summary_input_chars = b.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      } else if (options.skipSummary !== true && b.summary_llm_error) {
        target.summarizer = 'llm_failed';
        target.summary_llm_error = b.summary_llm_error;
      }
    }

    // ── 本地化翻译合并（可用判定：原样复述的假翻译不抢占合并结果） ──
    const hasLocal = hasUsableLocalizedContent(target, locale);
    if (!hasLocal) {
      const aLoc = a.localizations?.[locale];
      const aLocSuccess = hasUsableLocalizedContent(a, locale);
      const bLoc = b.localizations?.[locale];
      const bLocSuccess = hasUsableLocalizedContent(b, locale);

      if (aLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = aLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = a.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      } else if (bLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = bLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = b.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      } else if (options.skipLocalize !== true && b.localizations_meta?.[locale]?.llm_error) {
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = b.localizations_meta[locale];
      }
    }
  }

  // 6. 并发安全原子落盘：请求期间若候选层被并发修改（如工作台人工审核），
  //    只把修复结果合并进最新状态，绝不覆盖人工结论
  if (!dryRun) {
    if (store) {
      store.updated_at = new Date().toISOString();
    }
    const writeResult = guardedWriteStore(store, baseRevision, targets, options.runId || 'min-repair-dual-channel', {
      ...options,
      locale,
      l2Enabled,
    });
    resultStats.writeMerged = writeResult.merged;
  }

  resultStats.remainingIncomplete = countRepairWork(candidates, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }).total;
  if (options.rescreenStructured === true) {
    resultStats.remainingIncomplete += candidates.filter(needsStructuredRescreen).length;
    resultStats.rescreenFailedIds = targets.filter(item => !item.l1_review?.verdict).map(item => String(item.id));
  }
  return resultStats;
}

module.exports = {
  repairIncompleteCandidates,
};
