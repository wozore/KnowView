/**
 * collector-x-v2.js —— X(TwitterAPI.io) Advanced Search 统一采集门面（Facade）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §2.2 与 §13.2 契约：
 * 1. 唯一 Interface：collectXV2(xRunSpec) -> Promise<XRunResult>
 * 2. 彻底移除直接写盘（不写候选、不写 history、不写 checkpoint、不写 last-run、不调 Git）
 * 3. 四桶预算控制（hot 7500 / cold 2500）与 Transport 客户端
 * 4. 推文半开区间过滤、互动类型过滤、native_id 去重与长文 Article 补读
 * 5. 账号组轮次公平调度、可选尾部重查与 Discovery 关键词发现
 */

'use strict';

const { readJson } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');
const { beijingDayKey } = require('../../shared/beijing-time');
const { xApiKeyOf } = require('./loadCollectorConfig');
const {
  normalizeXV2Tweet,
  hasArticleSignal,
  extractArticleText,
} = require('./collector-x-normalize');
const {
  resolveXCollectionWindow,
  inWindow,
  resolveTailRecheckWindow,
  createBudgetLedger,
  createAdvancedSearchClient,
  executeAccountGroups,
  executeTailRecheck,
  executeDiscoveryQueries,
  queryContract,
  checkpointContract,
} = require('./x-search');
const { buildAccountGroupQuery, buildDiscoveryQuery } = queryContract;
const { buildCheckpointRecord } = checkpointContract;

const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  collection: {
    enabled: true, twitter_api_base_url: 'https://api.twitterapi.io',
    request_timeout_ms: 15000, max_retries: 2, retry_base_ms: 500,
  },
  keywords: { x_discovery_queries: [] }, account_groups: [],
});

let cachedV2Config = null;

function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  cachedV2Config = readJson(NEWS_FILES.configV2, null) || DEFAULT_CONFIG;
  return cachedV2Config;
}

function resolveConfig(config) {
  const base = loadV2Config();
  if (!config) return base;
  return {
    ...base,
    ...config,
    collection: { ...(base.collection || {}), ...(config.collection || {}) },
    keywords: { ...(base.keywords || {}), ...(config.keywords || {}) },
  };
}

/**
 * 校验单条推文的时间窗、归一化与互动类型，过滤不合格推文。
 * @private
 */
function ingestRawTweet(rawTweet, { targetWindow, nowIso, diagnostics }) {
  const created = rawTweet.createdAt || rawTweet.created_at || rawTweet.created || rawTweet.timestamp;
  if (!inWindow(created, targetWindow)) return null;

  const item = normalizeXV2Tweet(rawTweet, null, nowIso);
  if (!item) return null;

  if (item.interaction_type !== 'original' && item.interaction_type !== 'quote') {
    const type = item.interaction_type || 'unknown';
    diagnostics.excluded_interaction_counts[type] = (diagnostics.excluded_interaction_counts[type] || 0) + 1;
    return null;
  }
  return item;
}

/**
 * 对命中长文信号的候选，从 article_retry 桶预占额度并读取正文。
 * 失败仅记 diagnostics，不阻断主候选。
 * @private
 */
async function enrichArticle(item, rawTweet, { client, budgetLedger, diagnostics }) {
  if (!hasArticleSignal(rawTweet, item.description)) return;

  if (!budgetLedger.canReserve('article_retry', 100)) {
    diagnostics.article_failures.push({ native_id: item.native_id, reason: 'BUDGET_EXHAUSTED' });
    return;
  }

  let reservation = null;
  try {
    reservation = budgetLedger.reserve('article_retry', 100, { isArticle: true });
  } catch {
    diagnostics.article_failures.push({ native_id: item.native_id, reason: 'BUDGET_EXHAUSTED' });
    return;
  }

  try {
    const payload = await client.fetchArticle(item.native_id);
    const body = extractArticleText(payload);
    if (body) {
      const base = item.description || '';
      item.description = [body, base].filter(Boolean).join('\n\n').slice(0, 600);
    }
    budgetLedger.settle(reservation, 1, 100, Boolean(body));
  } catch (err) {
    budgetLedger.retainAsUnknown(reservation);
    diagnostics.article_failures.push({ native_id: item.native_id, error: err.message });
  }
}

/**
 * 遍历 outcomes 中的原始推文，执行时间窗裁决、归一化、去重、上下文注入与 Article 补读。
 * @private
 */
async function processOutcomeItems(outcomes, queryKind, targetWindow, context) {
  const { dedupedItems, runId, slot, nowIso, client, budgetLedger, diagnostics } = context;
  let newlyAddedCount = 0;

  for (const outcome of outcomes) {
    const rawTweets = Array.isArray(outcome.items) ? outcome.items : [];
    let retainedForGroup = 0;
    const queryId = outcome.group_id || outcome.query_id;

    for (const rawTweet of rawTweets) {
      const item = ingestRawTweet(rawTweet, { targetWindow, nowIso, diagnostics });
      if (!item) continue;
      if (dedupedItems.has(item.native_id)) continue;

      item.collection_context = {
        window_id: targetWindow.window_id,
        half: slot,
        query_kind: queryKind,
        query_id: queryId,
        first_seen_run_id: runId,
        last_seen_run_id: runId,
      };

      await enrichArticle(item, rawTweet, { client, budgetLedger, diagnostics });
      dedupedItems.set(item.native_id, item);
      retainedForGroup += 1;
      newlyAddedCount += 1;
    }
    outcome.retained_items = retainedForGroup;
  }
  return newlyAddedCount;
}

/**
 * 汇总执行总体状态。
 * @private
 */
function deriveStatus(accountResult, discResult, tailResult, diagnostics, totalItems) {
  if (accountResult.status === 'failed' && totalItems === 0) return 'failed';
  if (accountResult.status === 'failed' || accountResult.status === 'partial') return 'partial';
  if (discResult && (discResult.status === 'failed' || discResult.status === 'partial')) return 'partial';
  if (tailResult && (tailResult.status === 'failed' || tailResult.status === 'partial')) return 'partial';
  if (diagnostics.article_failures.some(f => f.reason === 'BUDGET_EXHAUSTED')) return 'partial';
  return 'complete';
}

/**
 * 组装各阶段 outcomes 为标准 Checkpoint 记录数组。
 * @private
 */
function buildPatches(accountOutcomes, discOutcomes, window, slot, nowIso) {
  const patches = [];
  for (const o of accountOutcomes) {
    patches.push(buildCheckpointRecord({
      window_id: window.window_id, half: slot, query_kind: 'account_group',
      query_id: o.group_id, group_id: o.group_id, query_hash: o.query_hash,
      status: o.status, pages_completed: o.pages_completed, next_cursor: o.next_cursor,
      reason_code: o.reason, credits_used: o.credits_used, retained_items: o.retained_items || 0,
      updated_at: nowIso,
    }));
  }
  for (const o of discOutcomes) {
    patches.push(buildCheckpointRecord({
      window_id: window.window_id, half: slot, query_kind: 'discovery',
      query_id: o.query_id, group_id: null, query_hash: o.query_hash,
      status: o.status, pages_completed: o.pages_completed, next_cursor: o.next_cursor,
      reason_code: o.reason, credits_used: o.credits_used, retained_items: o.retained_items || 0,
      updated_at: nowIso,
    }));
  }
  return patches;
}

/**
 * 初始化采集参数、时间窗口与执行环境。
 * @private
 */
function initCollectionEnv(specOrOptions) {
  const spec = specOrOptions.xRunSpec || specOrOptions;
  const config = resolveConfig(spec.config);
  const slot = spec.slot;
  const now = spec.now instanceof Date ? spec.now : new Date(spec.now || Date.now());
  const nowIso = now.toISOString();
  const runId = spec.run_id || spec.runId || `x-${now.getTime()}`;
  const runKind = spec.run_kind || spec.runKind || 'scheduled';
  const apiKey = spec.xApiKey || spec.apiKey || xApiKeyOf(spec);
  return { spec, config, slot, now, nowIso, runId, runKind, apiKey };
}

/**
 * 构建错误/快速退出情况下的空 XRunResult。
 * @private
 */
function buildQuickExitResult(runId, runKind, errorReason, slot = 'hot') {
  return {
    platform: 'x', run_id: runId, run_kind: runKind, window: null, status: 'failed',
    items: [], account_groups: [], discovery_queries: [],
    credits: createBudgetLedger(slot === 'cold' ? 'cold' : 'hot').toCreditsDto(),
    diagnostics: { error: errorReason }, checkpoint_patches: [],
  };
}

/**
 * 校验采集必要条件并构造前置快速退出结果。
 * @private
 */
function checkPreconditions(env) {
  const { config, apiKey, slot, runId, runKind } = env;
  if (config.collection?.enabled !== true) return buildQuickExitResult(runId, runKind, 'collection_disabled', slot);
  if (!apiKey) return buildQuickExitResult(runId, runKind, 'missing_api_key', slot);
  if (slot !== 'hot' && slot !== 'cold') return buildQuickExitResult(runId, runKind, 'invalid_or_missing_slot', 'hot');
  return null;
}

/**
 * 执行尾部重查子阶段（若启用）。
 * @private
 */
async function executeTailPhase({ spec, accountGroups, slot, window, now, nowIso, client, budgetLedger, context }) {
  if (spec.tail_recheck?.enabled !== true) {
    return { tailResult: null, tailObservations: [] };
  }

  const tailRecheckWindow = spec.tail_recheck.since_bjt
    ? spec.tail_recheck
    : resolveTailRecheckWindow(slot, window.business_date || beijingDayKey(now));
  const tailResult = await executeTailRecheck({
    accountGroups,
    tailRecheckWindow,
    client,
    budgetLedger,
  });

  const tailObservations = [];
  for (const tailOutcome of tailResult.outcomes) {
    const recoveredCount = await processOutcomeItems([tailOutcome], 'account_group', {
      window_id: tailRecheckWindow.source_window_id || tailRecheckWindow.window_id,
      since_unix: tailRecheckWindow.since_unix,
      until_unix: tailRecheckWindow.until_unix,
    }, context);
    tailObservations.push({
      recorded_at: nowIso,
      half: slot,
      group_id: tailOutcome.group_id,
      recovered_new_count: recoveredCount,
      credits_used: tailOutcome.credits_used,
      recovered_approved_count: 0,
    });
  }
  return { tailResult, tailObservations };
}

/**
 * 执行 Discovery 关键词发现子阶段。
 * @private
 */
async function executeDiscoveryPhase({ spec, config, window, client, budgetLedger, context }) {
  const discoveryQueries = Array.isArray(spec.discovery_queries)
    ? spec.discovery_queries
    : (spec.account_groups ? [] : (Array.isArray(config.keywords?.x_discovery_queries) ? config.keywords.x_discovery_queries : []));
  if (discoveryQueries.length === 0) {
    return { outcomes: [], items: [], status: 'complete' };
  }

  const discResult = await executeDiscoveryQueries({
    discoveryQueries,
    window,
    client,
    budgetLedger,
    bucketKey: 'discovery',
  });
  await processOutcomeItems(discResult.outcomes, 'discovery', window, context);
  return discResult;
}

/**
 * 初始化客户端、预算账本与推文处理上下文。
 * @private
 */
function initExecutionContext(spec, config, env) {
  const { apiKey, slot, runId, nowIso } = env;
  const budgetLedger = createBudgetLedger(slot, spec.budget_caps || config.budget_caps || {});
  const client = createAdvancedSearchClient({
    apiKey,
    baseUrl: config.collection?.twitter_api_base_url,
    fetchImpl: spec.fetchImpl,
    timeoutMs: config.collection?.request_timeout_ms,
    maxRetries: config.collection?.max_retries,
    retryBaseMs: config.collection?.retry_base_ms,
  });
  const diagnostics = {
    delayed: Boolean(spec.delayed),
    excluded_interaction_counts: { reply: 0, repost: 0, unknown: 0 },
    article_failures: [],
    errors: [],
  };
  const dedupedItems = new Map();
  const context = { dedupedItems, runId, slot, nowIso, client, budgetLedger, diagnostics };
  return { budgetLedger, client, diagnostics, dedupedItems, context };
}

/**
 * X（TwitterAPI.io）Advanced Search 采集入口。
 * @param {object} specOrOptions xRunSpec 或平铺参数对象
 * @returns {Promise<object>} XRunResult
 */
async function collectXV2(specOrOptions = {}) {
  const env = initCollectionEnv(specOrOptions);
  const exitResult = checkPreconditions(env);
  if (exitResult) return exitResult;

  const { spec, config, slot, now, nowIso, runId, runKind } = env;
  const window = spec.window || resolveXCollectionWindow({
    slot,
    businessDate: spec.businessDate || beijingDayKey(now),
  });

  const { budgetLedger, client, diagnostics, dedupedItems, context } = initExecutionContext(spec, config, env);

  // 1. 调度 7 个账号组
  const accountGroups = Array.isArray(spec.account_groups)
    ? spec.account_groups
    : (Array.isArray(config.account_groups) ? config.account_groups : []);
  const accountResult = await executeAccountGroups({
    accountGroups,
    window,
    client,
    budgetLedger,
    bucketKey: 'account',
  });
  await processOutcomeItems(accountResult.outcomes, 'account_group', window, context);

  // 2. 尾部重查
  const { tailResult, tailObservations } = await executeTailPhase({
    spec, accountGroups, slot, window, now, nowIso, client, budgetLedger, context,
  });

  // 3. Discovery 关键词查询
  const discResult = await executeDiscoveryPhase({ spec, config, window, client, budgetLedger, context });

  // 4. 组装结果
  const finalItems = [...dedupedItems.values()];
  const status = deriveStatus(accountResult, discResult, tailResult, diagnostics, finalItems.length);
  const patches = buildPatches(accountResult.outcomes, discResult.outcomes, window, slot, nowIso);
  if (tailObservations.length > 0) patches.push(...tailObservations);

  return {
    platform: 'x', run_id: runId, run_kind: runKind, window, status, items: finalItems,
    account_groups: accountResult.outcomes, discovery_queries: discResult.outcomes,
    credits: budgetLedger.toCreditsDto(), diagnostics, checkpoint_patches: patches,
  };
}

module.exports = {
  collectXV2,
  resolveConfig,
  loadV2Config,
  normalizeXV2Tweet,
  extractArticleText,
  hasArticleSignal,
};
