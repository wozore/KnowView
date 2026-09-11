/**
 * pipeline-schedule.js —— 热点管线 v2 的配置加载、调度闸与采集运行记录构造。
 *
 * 职责：
 *   - loadV2Config / isCollectionEnabled：news-config-v2.json 懒加载与采集总开关；
 *   - isYoutubeDue / readScheduleState / writeScheduleState：YouTube 72h 调度到期闸；
 *   - normalizeNow / resolveXWindow：参考时间规范化与 X 采集时间窗；
 *   - buildLastRunRecord：采集运行记录（last-run.json 的内存形状，写盘由 runMin 决定）。
 */

'use strict';

const { beijingMidnightIso, beijingDayKey } = require('../../shared/beijing-time');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');
const { resolveXCollectionWindow } = require('../collectors/x-search');

/** YouTube 调度采集默认最小间隔（小时）；config.schedule.youtube_interval_hours 可覆盖。 */
const DEFAULT_YOUTUBE_INTERVAL_HOURS = 72;

/** news-config-v2.json 不可读时退回默认关闭的最小兜底配置。 */
const EMPTY_V2_CONFIG = {
  schema_version: 1,
  collection: { enabled: false },
  keywords: { ai_keywords: [] },
  review: {},
  scoring: {},
};

let cachedV2Config = null;

/** 懒加载 news-config-v2.json；不可读时退回默认关闭的最小兜底配置。 */
function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  cachedV2Config = readJson(NEWS_FILES.configV2, null) || EMPTY_V2_CONFIG;
  return cachedV2Config;
}

/** 热点采集总开关：仅严格布尔 true 启用；缺失或类型错误均安全关闭。 */
function isCollectionEnabled(config) {
  return config?.collection?.enabled === true;
}

/**
 * YouTube 到期判定（纯函数）：距上次「调度触发」的成功采集 ≥ interval 小时才算到期。
 * 背景：GitHub cron 的日期步进按月历日触发（1,4,…,28,31），月末出现 31→1 背靠背；
 * 改为每日 cron + 管线内到期闸后，滚动间隔不再受月界与 GitHub 调度延迟影响。
 * 状态缺失 / 时间戳非法 / 时钟倒挂（未来时间）均视为到期——宁可多采不可漏采。
 */
function isYoutubeDue(config, scheduleState, now) {
  const intervalHours = Math.max(1, Number(config?.schedule?.youtube_interval_hours) || DEFAULT_YOUTUBE_INTERVAL_HOURS);
  const raw = scheduleState && scheduleState.youtube_last_collected_at;
  const lastAt = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(lastAt)) return true;
  const nowMs = normalizeNow(now).getTime();
  if (lastAt > nowMs) return true;
  return (nowMs - lastAt) / 3600000 >= intervalHours;
}

function readScheduleState() {
  return readJson(NEWS_FILES.scheduleState, null);
}

function writeScheduleState(state, runId) {
  writeJsonAtomic(NEWS_FILES.scheduleState, state, runId);
}

/** 规范化 now：Date / ISO 字符串 / 非法值 → 回退当前时间。 */
function normalizeNow(now) {
  if (now == null) return new Date();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

/**
 * 解析 X 采集时间窗。
 * 1. options.xWindow = { since, until } 注入时使用之；
 * 2. options.slot = 'hot' | 'cold' 或 options.xSlot 注入时，构造标准 hot/cold 窗口；
 * 3. 缺省回退用「北京时间今天 0 点 → now」（保持既有基线测试兼容）。
 * @returns {object}
 */
function resolveXWindow(options, now) {
  if (options && options.xWindow) {
    const sinceIso = options.xWindow.since != null ? new Date(options.xWindow.since).toISOString() : null;
    const untilIso = options.xWindow.until != null ? new Date(options.xWindow.until).toISOString() : null;
    const res = { sinceIso, untilIso };
    if (options.xWindow.window_id || options.xWindow.since_bjt) {
      res.window_id = options.xWindow.window_id || (sinceIso && untilIso ? `${sinceIso}__${untilIso}` : null);
      res.since_bjt = options.xWindow.since_bjt || sinceIso;
      res.until_bjt = options.xWindow.until_bjt || untilIso;
      res.since_unix = options.xWindow.since_unix ?? (sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : null);
      res.until_unix = options.xWindow.until_unix ?? (untilIso ? Math.floor(Date.parse(untilIso) / 1000) : null);
      res.slot = options.slot || options.xSlot || 'hot';
    }
    return res;
  }

  const slot = (options && (options.slot === 'hot' || options.slot === 'cold'))
    ? options.slot
    : (options && (options.xSlot === 'hot' || options.xSlot === 'cold') ? options.xSlot : null);

  if (slot) {
    const normNow = normalizeNow(now);
    const win = resolveXCollectionWindow({ slot, businessDate: options.businessDate || beijingDayKey(normNow) });
    return {
      ...win,
      sinceIso: new Date(win.since_unix * 1000).toISOString(),
      untilIso: new Date(win.until_unix * 1000).toISOString(),
    };
  }

  return { sinceIso: beijingMidnightIso(now), untilIso: normalizeNow(now).toISOString() };
}

/**
 * 构造采集运行记录（内存形状）。这是"最后一次采集记录"的唯一权威来源
 * （hotspots coverage 会被 publish 覆盖），供 ai-top 判定
 * "最后一次采集是否有 YouTube"（cmd-min.hasYouTubeInLastRun）。
 * 记录 platforms、各平台 status/items，以及 X credits/请求账本。
 */
function buildLastRunRecord(coverage, { runId, now, platforms }) {
  const xSlot = coverage.collectors?.x || {};
  return {
    schema_version: 1,
    run_id: runId,
    collected_at: now.toISOString(),
    platforms,
    collectors: {
      youtube: {
        status: coverage.collectors?.youtube?.status || 'not_run',
        items: coverage.collectors?.youtube?.items || 0,
        error: coverage.collectors?.youtube?.error || null,
        reason: coverage.collectors?.youtube?.reason || null,
        quota: coverage.collectors?.youtube?.quota || null,
      },
      x: {
        status: xSlot.status || 'not_run',
        items: xSlot.items || 0,
        error: xSlot.error || null,
        reason: xSlot.reason || null,
        credits: xSlot.credits || null,
        account_groups: xSlot.account_groups || null,
        discovery_queries: xSlot.discovery_queries || null,
        diagnostics: xSlot.diagnostics || null,
      },
    },
  };
}

/**
 * 格式化采集运行记录为 Markdown 摘要（供 GitHub Actions Step Summary 或 CLI 展示）。
 * 按本次实际运行平台动态渲染 YouTube 与 X 的采集明细与配额消耗。
 * @param {object} run last-run.json 记录对象
 * @returns {string}
 */
function formatRunSummary(run) {
  if (!run || typeof run !== 'object') {
    return '## 热点采集摘要\n本次没有可用的采集记录。';
  }
  const lines = ['## 热点采集摘要 (Collection Summary)'];
  lines.push(`- run_id: ${run.run_id || 'unknown'}`);
  lines.push(`- 采集时间: ${run.collected_at || 'unknown'}`);
  const platforms = Array.isArray(run.platforms) && run.platforms.length > 0
    ? run.platforms
    : Object.keys(run.collectors || {});
  lines.push(`- 触发平台: ${platforms.join(', ') || 'none'}`);

  if (platforms.includes('youtube')) {
    const yt = run.collectors && run.collectors.youtube;
    lines.push('\n### 📹 YouTube 采集');
    if (!yt) {
      lines.push('本次运行未包含 YouTube 采集数据。');
    } else {
      lines.push(`- status: ${yt.status || 'unknown'}${yt.reason ? ` (${yt.reason})` : ''}`);
      lines.push(`- 采集条数: ${yt.items ?? 0}`);
      if (yt.error) lines.push(`- error: ${yt.error}`);
      if (yt.status === 'not_due') {
        lines.push('- 说明: 处于 72h 间隔保护期内，未到期跳过采集');
      }
      if (yt.quota) {
        const q = yt.quota;
        lines.push(`- API 调用: search=${q.search_calls || 0}, videos=${q.videos_calls || 0}, comments=${q.comments_calls || 0}, categories=${q.categories_calls || 0}`);
      }
    }
  }

  if (platforms.includes('x')) {
    const x = run.collectors && run.collectors.x;
    lines.push('\n### 💳 X 采集额度');
    if (!x) {
      lines.push('本次运行未包含 X 采集数据。');
    } else {
      const c = x.credits;
      lines.push(`- status: ${x.status || 'unknown'}${x.reason ? ` (${x.reason})` : ''}`);
      lines.push(`- 采集条数: ${x.items ?? 0}`);
      if (x.error) lines.push(`- error: ${x.error}`);
      if (!c) {
        lines.push('- 本次运行未写入 credits 记录。');
      } else {
        const r = c.requests || {};
        const budget = c.budget ?? c.total_budget ?? 0;
        lines.push(`- credits: ${c.used || 0}/${budget}`);
        if (c.tweets !== undefined) lines.push(`- billable tweets: ${c.tweets || 0}`);
        if (c.settled !== undefined) lines.push(`- settled: ${c.settled}, reserved: ${c.reserved || 0}, unknown: ${c.unknown_reserved || 0}`);
        if (c.articles !== undefined) lines.push(`- successful articles: ${c.articles || 0}`);
        lines.push(`- requests: ${r.total || 0} (tweet=${r.tweet ?? r.pages ?? 0}, article=${r.article ?? r.articles ?? 0}, retries=${r.retries || 0})`);
        if (c.overage > 0) lines.push(`- overage: ${c.overage}`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  DEFAULT_YOUTUBE_INTERVAL_HOURS,
  buildLastRunRecord,
  formatRunSummary,
  isCollectionEnabled,
  isYoutubeDue,
  loadV2Config,
  normalizeNow,
  readScheduleState,
  resolveXWindow,
  writeScheduleState,
};
