/**
 * window.js —— X Advanced Search 采集时间窗与半开区间裁决（T2 纯领域模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §3 与 §13.2 契约：
 * 1. hot: [前一日 20:00:00+08:00, 当日 08:00:00+08:00)
 * 2. cold: [当日 08:00:00+08:00, 当日 20:00:00+08:00)
 * 3. 半开区间 [since, until) 本地最终裁决（published_at === until 必须排除）
 * 4. 尾部重查：hot 重查上一 cold 尾部 60 分钟，cold 重查上一 hot 尾部 60 分钟
 * 5. 延迟判断：排队超过 6 小时标记 delayed
 */

'use strict';

const { beijingDayKey } = require('../../../shared/beijing-time');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** 将 'YYYY-MM-DD' 解析并返回前一日 'YYYY-MM-DD' 字符串。 */
function getPreviousDateString(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const prevUtc = new Date(Date.UTC(year, month - 1, day - 1));
  const y = prevUtc.getUTCFullYear();
  const m = String(prevUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(prevUtc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 格式化标准北京时间 ISO 字符串。 */
function formatBjtIso(dateStr, timeStr) {
  return `${dateStr}T${timeStr}+08:00`;
}

/** 将 ISO 字符串转为 Unix 秒级时间戳。 */
function toUnixSeconds(isoStr) {
  const ms = Date.parse(isoStr);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ISO date string for unix conversion: ${isoStr}`);
  }
  return Math.floor(ms / 1000);
}

/**
 * 解析主采集时间窗口。
 * @param {object} params
 * @param {'hot'|'cold'} [params.slot]
 * @param {string} [params.businessDate] 'YYYY-MM-DD'，缺省为北京时间当天
 * @param {object} [params.manualWindow] 手动覆盖窗口
 * @returns {object} XWindow
 */
function resolveXCollectionWindow({ slot, businessDate, manualWindow } = {}) {
  if (manualWindow && typeof manualWindow === 'object') {
    const sinceBjt = manualWindow.since_bjt || (manualWindow.window_id ? manualWindow.window_id.split('__')[0] : null);
    const untilBjt = manualWindow.until_bjt || (manualWindow.window_id ? manualWindow.window_id.split('__')[1] : null);
    if (!sinceBjt || !untilBjt) {
      throw new Error('manualWindow must specify since_bjt and until_bjt or a valid window_id');
    }
    const sinceUnix = manualWindow.since_unix ?? toUnixSeconds(sinceBjt);
    const untilUnix = manualWindow.until_unix ?? toUnixSeconds(untilBjt);
    const windowId = manualWindow.window_id || `${sinceBjt}__${untilBjt}`;
    return {
      window_id: windowId,
      since_bjt: sinceBjt,
      until_bjt: untilBjt,
      since_unix: sinceUnix,
      until_unix: untilUnix,
      slot: manualWindow.slot || slot || 'manual',
      business_date: manualWindow.business_date || businessDate || beijingDayKey(new Date()),
    };
  }

  if (slot !== 'hot' && slot !== 'cold') {
    throw new Error(`Invalid collection slot: ${slot}; must be 'hot' or 'cold'`);
  }

  const bDate = typeof businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    ? businessDate
    : beijingDayKey(new Date());

  let sinceBjt;
  let untilBjt;

  if (slot === 'hot') {
    const prevDate = getPreviousDateString(bDate);
    sinceBjt = formatBjtIso(prevDate, '20:00:00');
    untilBjt = formatBjtIso(bDate, '08:00:00');
  } else {
    sinceBjt = formatBjtIso(bDate, '08:00:00');
    untilBjt = formatBjtIso(bDate, '20:00:00');
  }

  const sinceUnix = toUnixSeconds(sinceBjt);
  const untilUnix = toUnixSeconds(untilBjt);
  const windowId = `${sinceBjt}__${untilBjt}`;

  return {
    window_id: windowId,
    since_bjt: sinceBjt,
    until_bjt: untilBjt,
    since_unix: sinceUnix,
    until_unix: untilUnix,
    slot,
    business_date: bDate,
  };
}

/**
 * 严格半开区间 [since, until) 判定：
 * published_at >= since && published_at < until。
 * published_at === until 必须排除。
 */
function inWindow(publishedAt, window) {
  if (!publishedAt || !window) return false;
  const ms = typeof publishedAt === 'number' ? publishedAt : new Date(publishedAt).getTime();
  if (!Number.isFinite(ms)) return false;

  const sinceMs = window.since_unix != null
    ? window.since_unix * 1000
    : Date.parse(window.since_bjt);
  const untilMs = window.until_unix != null
    ? window.until_unix * 1000
    : Date.parse(window.until_bjt);

  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return false;
  return ms >= sinceMs && ms < untilMs;
}

/**
 * 解析尾部重查时间窗口与 source_window_id：
 * - hot run 重查上一 cold 窗口（前一日 19:00:00 至 20:00:00）
 * - cold run 重查上一 hot 窗口（当日 07:00:00 至 08:00:00）
 */
function resolveTailRecheckWindow(currentSlot, currentBusinessDate) {
  if (currentSlot !== 'hot' && currentSlot !== 'cold') {
    throw new Error(`Invalid currentSlot for tail recheck: ${currentSlot}`);
  }

  const bDate = typeof currentBusinessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(currentBusinessDate)
    ? currentBusinessDate
    : beijingDayKey(new Date());

  let sourceWindowId;
  let sinceBjt;
  let untilBjt;

  if (currentSlot === 'hot') {
    const prevDate = getPreviousDateString(bDate);
    const prevColdSince = formatBjtIso(prevDate, '08:00:00');
    const prevColdUntil = formatBjtIso(prevDate, '20:00:00');
    sourceWindowId = `${prevColdSince}__${prevColdUntil}`;
    sinceBjt = formatBjtIso(prevDate, '19:00:00');
    untilBjt = formatBjtIso(prevDate, '20:00:00');
  } else {
    const prevDate = getPreviousDateString(bDate);
    const prevHotSince = formatBjtIso(prevDate, '20:00:00');
    const prevHotUntil = formatBjtIso(bDate, '08:00:00');
    sourceWindowId = `${prevHotSince}__${prevHotUntil}`;
    sinceBjt = formatBjtIso(bDate, '07:00:00');
    untilBjt = formatBjtIso(bDate, '08:00:00');
  }

  return {
    enabled: true,
    source_window_id: sourceWindowId,
    since_bjt: sinceBjt,
    until_bjt: untilBjt,
    since_unix: toUnixSeconds(sinceBjt),
    until_unix: toUnixSeconds(untilBjt),
  };
}

/**
 * 判定采集是否延迟启动（超过 6 小时）。
 */
function checkDelayed(scheduledAt, actualStartedAt) {
  const schedMs = new Date(scheduledAt).getTime();
  const actualMs = new Date(actualStartedAt).getTime();
  if (!Number.isFinite(schedMs) || !Number.isFinite(actualMs)) {
    return false;
  }
  return actualMs - schedMs > SIX_HOURS_MS;
}

module.exports = {
  resolveXCollectionWindow,
  inWindow,
  resolveTailRecheckWindow,
  checkDelayed,
};
