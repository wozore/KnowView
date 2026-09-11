/**
 * checkpoint-contract.js —— Checkpoint Schema 与尾部重查指标计算（T2 纯领域模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §9 与 §13.2 契约：
 * 1. 唯一键：${window_id}::${query_kind}::${query_id}::${query_hash}
 * 2. 账号组：query_id 与 group_id 均为组 ID；发现查询：query_id 为查询 ID，group_id 为 null
 * 3. 30 天滚动记录 tail_recheck_observations
 * 4. 14 天尾部观察指标汇总计算（recovered_new_count, recheck_hit_rate, credits_per_recovered 等）
 */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 生成 Checkpoint 唯一主键：${window_id}::${query_kind}::${query_id}::${query_hash}
 */
function checkpointKeyOf({ window_id, query_kind, query_id, query_hash }) {
  if (!window_id || !query_kind || !query_id || !query_hash) {
    throw new Error('checkpointKeyOf requires window_id, query_kind, query_id, and query_hash');
  }
  return `${window_id}::${query_kind}::${query_id}::${query_hash}`;
}

/**
 * 构造符合 Schema v1 的 Checkpoint 记录对象。
 */
function buildCheckpointRecord({
  window_id,
  half,
  query_kind,
  query_id,
  group_id = null,
  query_hash,
  status = 'partial',
  pages_completed = 0,
  next_cursor = null,
  reason_code = null,
  credits_used = 0,
  retained_items = 0,
  updated_at = null,
} = {}) {
  if (!window_id || !half || !query_kind || !query_id || !query_hash) {
    throw new Error('buildCheckpointRecord missing required identifiers');
  }

  const resolvedGroupId = query_kind === 'account_group'
    ? (group_id || query_id)
    : null;

  return {
    schema_version: 1,
    window_id,
    half,
    query_kind,
    query_id,
    group_id: resolvedGroupId,
    query_hash,
    status,
    pages_completed: Math.max(0, Number(pages_completed) || 0),
    next_cursor: next_cursor ? String(next_cursor) : null,
    reason_code: reason_code ? String(reason_code) : null,
    credits_used: Math.max(0, Number(credits_used) || 0),
    retained_items: Math.max(0, Number(retained_items) || 0),
    updated_at: updated_at || new Date().toISOString(),
  };
}

/**
 * 滚动修剪 30 天以前的尾部重查观察记录。
 * @param {object[]} observations
 * @param {string|Date} nowIso
 * @param {number} [retentionDays=30]
 * @returns {object[]}
 */
function pruneTailRecheckObservations(observations, nowIso, retentionDays = 30) {
  if (!Array.isArray(observations)) return [];
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) return observations;

  const cutoffMs = nowMs - retentionDays * DAY_MS;
  return observations.filter(obs => {
    const timeStr = obs.recorded_at || obs.timestamp || obs.updated_at;
    const itemMs = new Date(timeStr).getTime();
    return Number.isFinite(itemMs) && itemMs >= cutoffMs;
  });
}

/**
 * 计算最近 14 天尾部重查汇总指标。
 * @param {object[]} observations
 * @param {string|Date} nowIso
 * @param {number} [windowDays=14]
 * @returns {object}
 */
/**
 * 构造尾部重查指标空对象。
 * @private
 */
function createEmptyTailMetrics(windowDays) {
  return {
    window_days: windowDays,
    total_queries: 0,
    recovered_new_count: 0,
    recheck_hit_rate: 0,
    late_recovery_rate: 0,
    recheck_credits: 0,
    credits_per_recovered: null,
    recovered_approved_count: 0,
    recovered_approved_rate: null,
    by_half: { hot: { queries: 0, recovered: 0 }, cold: { queries: 0, recovered: 0 } },
    by_group: {},
  };
}

/**
 * 筛选属于统计时间窗口内的观察记录。
 * @private
 */
function filterObservationsInWindow(observations, nowIso, windowDays) {
  if (!Array.isArray(observations) || observations.length === 0) return [];
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) return [];

  const cutoffMs = nowMs - windowDays * DAY_MS;
  return observations.filter(obs => {
    const timeStr = obs.recorded_at || obs.timestamp || obs.updated_at;
    const itemMs = new Date(timeStr).getTime();
    return Number.isFinite(itemMs) && itemMs >= cutoffMs;
  });
}

/**
 * 聚合时间窗口内观察记录的基础计数值与分桶统计。
 * @private
 */
function aggregateTailObservations(inScope) {
  let totalRecovered = 0;
  let totalCredits = 0;
  let hitCount = 0;
  let totalApproved = 0;
  const byHalf = { hot: { queries: 0, recovered: 0 }, cold: { queries: 0, recovered: 0 } };
  const byGroup = {};

  for (const obs of inScope) {
    const recovered = Math.max(0, Number(obs.recovered_new_count) || 0);
    const credits = Math.max(0, Number(obs.credits_used) || 0);
    const approved = Math.max(0, Number(obs.recovered_approved_count) || 0);

    totalRecovered += recovered;
    totalCredits += credits;
    if (recovered > 0) hitCount += 1;
    totalApproved += approved;

    const half = obs.half === 'cold' ? 'cold' : 'hot';
    byHalf[half].queries += 1;
    byHalf[half].recovered += recovered;

    const gId = obs.group_id || 'unknown';
    if (!byGroup[gId]) byGroup[gId] = { queries: 0, recovered: 0, credits: 0 };
    byGroup[gId].queries += 1;
    byGroup[gId].recovered += recovered;
    byGroup[gId].credits += credits;
  }

  return { totalRecovered, totalCredits, hitCount, totalApproved, byHalf, byGroup };
}

/**
 * 根据聚合结果计算尾部重查汇总率值与成本指标。
 * @private
 */
function calculateTailMetrics(windowDays, totalQueries, aggregates) {
  const { totalRecovered, totalCredits, hitCount, totalApproved, byHalf, byGroup } = aggregates;
  const hitRate = totalQueries > 0 ? Number((hitCount / totalQueries).toFixed(4)) : 0;
  const creditsPerRecovered = totalRecovered > 0
    ? Number((totalCredits / totalRecovered).toFixed(2))
    : null;
  const approvedRate = totalRecovered > 0
    ? Number((totalApproved / totalRecovered).toFixed(4))
    : null;

  return {
    window_days: windowDays,
    total_queries: totalQueries,
    recovered_new_count: totalRecovered,
    recheck_hit_rate: hitRate,
    late_recovery_rate: hitRate,
    recheck_credits: totalCredits,
    credits_per_recovered: creditsPerRecovered,
    recovered_approved_count: totalApproved,
    recovered_approved_rate: approvedRate,
    by_half: byHalf,
    by_group: byGroup,
  };
}

/**
 * 计算最近 14 天尾部重查汇总指标。
 * @param {object[]} observations
 * @param {string|Date} nowIso
 * @param {number} [windowDays=14]
 * @returns {object}
 */
function computeTailRecheckMetrics(observations, nowIso, windowDays = 14) {
  const inScope = filterObservationsInWindow(observations, nowIso, windowDays);
  if (inScope.length === 0) {
    return createEmptyTailMetrics(windowDays);
  }

  const aggregates = aggregateTailObservations(inScope);
  return calculateTailMetrics(windowDays, inScope.length, aggregates);
}

module.exports = {
  checkpointKeyOf,
  buildCheckpointRecord,
  pruneTailRecheckObservations,
  computeTailRecheckMetrics,
};
