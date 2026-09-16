/**
 * pipeline-collect.js —— 热点管线 v2 的采集编排：双平台并行采集 + YouTube 调度到期闸
 * + 调度状态落盘。采集器失败降级返回空并记 coverage，不抛错。
 *
 * 分时采集（options.platforms）：只启动列表内平台的采集 Task；未启用平台的
 * coverage.collectors[platform] 保持初始 { status:'not_run', items:0, error:null }。
 * YouTube 到期闸仅调度运行生效（options.scheduled 由 CLI --scheduled 注入）；
 * 手动 dispatch / 本地运行不受闸、也不写调度状态——手动采集与调度节奏互不影响。
 */

'use strict';

const { collectYouTubeV2 } = require('../collectors/collector-youtube-v2');
const { collectXV2 } = require('../collectors/collector-x-v2');
const { isYoutubeDue, readScheduleState, resolveXWindow, writeScheduleState } = require('./pipeline-schedule');
const { beijingDayKey } = require('../../shared/beijing-time');
const { resolveXCollectionWindow } = require('../collectors/x-search');

/** 错误标签：防御 undefined 边界。 */
function errorLabel(error) {
  return (error && (error.message || error.code)) || String(error);
}

/**
 * 账号组结果压缩投影：只保留运行摘要，剥离 items 等原始 API 载荷，
 * 防止完整推文/作者资料（每轮 1MB+）泄入 coverage 与 last-run.json。
 * @private
 */
function compactAccountGroupOutcomes(groups) {
  if (!Array.isArray(groups)) return groups ?? null;
  return groups.map(group => ({
    group_id: group.group_id,
    status: group.status,
    pages_completed: group.pages_completed,
    retained_items: group.retained_items,
    credits_used: group.credits_used,
    reason: group.reason ?? null,
    errors: Array.isArray(group.errors) ? group.errors : [],
    query_hash: group.query_hash,
  }));
}

/**
 * 从 options 与参考时间推导 X 的 slot（hot/cold）与 run_kind。
 * @private
 */
function deriveXRunParams(options) {
  const slot = options.slot || options.xSlot;
  const runKind = options.run_kind || options.runKind || (options.scheduled === true ? 'scheduled' : 'manual_backfill');
  return { slot, runKind };
}

/**
 * 构造传递给 xCollector 的结构化 xRunSpec。
 * @private
 */
function buildXRunSpec({ options, config, now, runId, xWindow }) {
  const { slot, runKind } = deriveXRunParams(options);
  if (options.scheduled === true && !['hot', 'cold'].includes(slot)) {
    return { invalid: true, slot, runKind };
  }
  const resolvedWindow = (xWindow && xWindow.window_id)
    ? xWindow
    : resolveXCollectionWindow({
        slot,
        businessDate: options.businessDate || beijingDayKey(now),
        manualWindow: (xWindow && xWindow.sinceIso && xWindow.untilIso)
          ? { since_bjt: xWindow.sinceIso, until_bjt: xWindow.untilIso }
          : null,
      });

  return {
    platform: 'x',
    run_id: runId,
    run_kind: runKind,
    slot,
    window: resolvedWindow,
    tail_recheck: options.tail_recheck || { enabled: options.scheduled === true },
    config,
    xApiKey: options.xApiKey,
    apiKey: options.xApiKey,
    fetchImpl: options.fetchImpl,
    now,
    scheduled_at: options.scheduled_at,
    actual_started_at: now.toISOString(),
    account_groups: options.account_groups,
    discovery_queries: options.discovery_queries,
    budget_caps: options.budget_caps,
    sinceIso: xWindow ? xWindow.sinceIso : null,
    untilIso: xWindow ? xWindow.untilIso : null,
  };
}

/**
 * 调度 YouTube 采集任务。
 * @private
 */
async function runYoutubeTask({ options, config, now, coverage }) {
  const slot = coverage.collectors.youtube;
  const youtubeCollector = (options.collectors && options.collectors.youtube) || collectYouTubeV2;
  try {
    const result = await youtubeCollector({
      config,
      now,
      apiKey: options.youtubeApiKey,
      fetchImpl: options.fetchImpl,
    });
    const collected = result && Array.isArray(result.items) ? result.items : [];
    slot.items = collected.length;
    slot.status = (result && result.coverage && result.coverage.status) || 'success';
    slot.reason = (result && result.coverage && result.coverage.reason) || null;
    slot.quota = result && result.quota ? result.quota : null;
    return collected;
  } catch (error) {
    slot.status = 'failed';
    slot.error = errorLabel(error);
    return [];
  }
}

/**
 * 调度 X Advanced Search 采集任务。
 * @private
 */
async function runXTask({ options, config, now, runId, coverage, xWindow }) {
  const slot = coverage.collectors.x;
  const xCollector = (options.collectors && options.collectors.x) || collectXV2;
  const xRunSpec = buildXRunSpec({ options, config, now, runId, xWindow });
  if (xRunSpec.invalid) {
    slot.status = 'failed';
    slot.reason = 'NEWS_INVALID_OR_MISSING_SLOT';
    return [];
  }
  // 未来窗口 fail-closed：窗口起点晚于当前时间（容差 5 分钟）说明业务日期被
  // 延迟执行带偏，查询注定全空（09-16 冷跑曾因此白耗 225 credits），拒绝发请求。
  if (xRunSpec.window && Number.isFinite(xRunSpec.window.since_unix)
    && xRunSpec.window.since_unix > Math.floor(now.getTime() / 1000) + 300) {
    slot.status = 'failed';
    slot.reason = 'NEWS_FUTURE_WINDOW';
    slot.error = `window since ${xRunSpec.window.since_bjt} is in the future`;
    return [];
  }

  try {
    const result = await xCollector(xRunSpec);
    const collected = result && Array.isArray(result.items) ? result.items : [];
    slot.items = collected.length;
    slot.status = result?.status || result?.coverage?.status || 'success';
    slot.reason = result?.diagnostics?.error || result?.coverage?.reason || null;
    slot.credits = result?.credits || null;
    slot.account_groups = compactAccountGroupOutcomes(result?.account_groups);
    slot.discovery_queries = result?.discovery_queries || null;
    slot.checkpoint_patches = result?.checkpoint_patches || null;
    slot.diagnostics = result?.diagnostics || null;
    return collected;
  } catch (error) {
    slot.status = 'failed';
    slot.error = errorLabel(error);
    return [];
  }
}

/**
 * 执行采集阶段：按 options.platforms 并行采集，更新 coverage.collectors，
 * 并在「调度运行 + YouTube 实际采集（success/partial）」时刷新调度状态。
 * @returns {Promise<{ mergedRaw: Array, platforms: string[] }>}
 */
async function collectPlatforms({ options, config, now, runId, coverage, noteError }) {
  const platforms = Array.isArray(options.platforms) && options.platforms.length
    ? options.platforms
    : ['youtube', 'x'];
  const xWindow = resolveXWindow(options, now);

  // YouTube 到期闸：仅调度运行生效。
  const scheduledRun = options.scheduled === true;
  let youtubeDueFlag = true;
  if (platforms.includes('youtube') && scheduledRun) {
    let scheduleState = null;
    try {
      scheduleState = options.scheduleStateIn ? options.scheduleStateIn() : readScheduleState();
    } catch (error) {
      noteError('schedule_state_read', error);
      coverage.fatal_error = 'schedule_state_read';
      youtubeDueFlag = false;
      coverage.collectors.youtube = {
        status: 'failed', items: 0, error: errorLabel(error), reason: 'NEWS_SCHEDULE_STATE_READ_FAILED',
      };
    }
    if (youtubeDueFlag) youtubeDueFlag = isYoutubeDue(config, scheduleState, now);
    if (!youtubeDueFlag) {
      coverage.collectors.youtube = { status: 'not_due', items: 0, error: null, reason: 'not_due' };
    }
  }

  const collectTasks = [];
  if (platforms.includes('youtube') && youtubeDueFlag) {
    collectTasks.push(runYoutubeTask({ options, config, now, coverage }));
  }
  if (platforms.includes('x')) {
    collectTasks.push(runXTask({ options, config, now, runId, coverage, xWindow }));
  }

  const collectedArrays = await Promise.all(collectTasks);
  const mergedRaw = collectedArrays.flat();
  coverage.collected_total = mergedRaw.length;

  // 调度状态落盘：仅「调度运行 + YouTube 实际采集（success/partial）」刷新到期基准。
  if (platforms.includes('youtube') && scheduledRun && youtubeDueFlag
    && ['success', 'partial'].includes(coverage.collectors.youtube.status)) {
    try {
      const scheduleState = {
        schema_version: 1,
        youtube_last_collected_at: now.toISOString(),
        run_id: runId,
      };
      if (options.scheduleStateOut) options.scheduleStateOut(scheduleState, runId);
      else writeScheduleState(scheduleState, runId);
    } catch (error) {
      noteError('schedule_state_write', error);
      coverage.fatal_error = 'schedule_state_write';
    }
  }

  return { mergedRaw, platforms };
}

module.exports = { collectPlatforms };
