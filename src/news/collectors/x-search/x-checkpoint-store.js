/**
 * x-checkpoint-store.js —— X 采集断点与尾部重查观察指标持久层（T3 Store 模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §9 与 §13.2 契约：
 * 1. 单文件读写 x-checkpoints.json（data/news/runtime/x-checkpoints.json）
 * 2. 读失败 fail-closed 阻断，严禁静默回退空对象覆盖
 * 3. 写盘采用 writeJsonAtomic 原子安全替换
 * 4. 断点增量合并：成功条目清理/压缩，未解决的 partial/failed 保留
 * 5. 尾部重查指标滚动修剪 30 天以前的历史记录
 */

'use strict';

const fs = require('fs');
const { readJson, writeJsonAtomic } = require('../../../shared/json-store');
const { NEWS_FILES } = require('../../../shared/paths');
const {
  checkpointKeyOf,
  buildCheckpointRecord,
  pruneTailRecheckObservations,
} = require('./checkpoint-contract');

const DEFAULT_STORE = Object.freeze({
  schema_version: 1,
  updated_at: null,
  checkpoints: Object.freeze({}),
  tail_recheck_observations: Object.freeze([]),
});

/**
 * 构造默认初始化的 Checkpoint Store 副本。
 * @returns {object}
 */
function createDefaultCheckpointStore() {
  return {
    schema_version: 1,
    updated_at: null,
    checkpoints: {},
    tail_recheck_observations: [],
  };
}

/**
 * 校验解析后的 Checkpoint Store 结构合法性（fail-closed 核心）。
 * @private
 */
function validateCheckpointStore(data, filePath) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid x-checkpoint store at ${filePath}: root must be an object`);
  }
  if (data.checkpoints !== undefined) {
    if (typeof data.checkpoints !== 'object' || data.checkpoints === null || Array.isArray(data.checkpoints)) {
      throw new Error(`Invalid x-checkpoint store at ${filePath}: checkpoints must be an object`);
    }
  }
  if (data.tail_recheck_observations !== undefined && !Array.isArray(data.tail_recheck_observations)) {
    throw new Error(`Invalid x-checkpoint store at ${filePath}: tail_recheck_observations must be an array`);
  }
}

/**
 * 读取 Checkpoint Store。
 * 文件不存在时返回默认结构；文件存在但损坏或格式非法时必须抛错（fail-closed）。
 * @param {string} [filePath=NEWS_FILES.xCheckpoints]
 * @returns {object}
 */
function readXCheckpointStore(filePath = NEWS_FILES.xCheckpoints) {
  if (!fs.existsSync(filePath)) return createDefaultCheckpointStore();
  const data = readJson(filePath, null);
  validateCheckpointStore(data, filePath);
  if (!Number.isInteger(data.schema_version) || data.schema_version < 1
    || !Object.prototype.hasOwnProperty.call(data, 'checkpoints')
    || !Object.prototype.hasOwnProperty.call(data, 'tail_recheck_observations')) {
    const error = new Error(`Invalid x-checkpoint store at ${filePath}: schema is incomplete`);
    error.code = 'NEWS_INVALID_CHECKPOINT_STORE';
    throw error;
  }
  return {
    schema_version: data.schema_version || 1,
    updated_at: data.updated_at || null,
    checkpoints: data.checkpoints ? { ...data.checkpoints } : {},
    tail_recheck_observations: Array.isArray(data.tail_recheck_observations)
      ? [...data.tail_recheck_observations]
      : [],
  };
}

/**
 * 原子写回 Checkpoint Store。
 * @param {object} store
 * @param {string} [runId='x-checkpoint']
 * @param {string} [filePath=NEWS_FILES.xCheckpoints]
 */
function writeXCheckpointStore(store, runId = 'x-checkpoint', filePath = NEWS_FILES.xCheckpoints) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('writeXCheckpointStore requires a valid store object');
  }
  writeJsonAtomic(filePath, store, runId);
}

/**
 * 从补丁结构中提取 checkpoint 记录列表。
 * @private
 */
function extractCheckpointList(patches) {
  if (Array.isArray(patches)) {
    return patches.filter(p => p && typeof p === 'object' && p.query_kind);
  }
  if (patches && typeof patches === 'object') {
    if (Array.isArray(patches.checkpoints)) {
      return patches.checkpoints;
    }
    if (patches.checkpoints && typeof patches.checkpoints === 'object') {
      return Object.values(patches.checkpoints);
    }
    return Object.values(patches).filter(p => p && typeof p === 'object' && p.query_kind);
  }
  return [];
}

/**
 * 从补丁结构中提取尾部重查观察记录列表。
 * @private
 */
function extractObservationList(patches) {
  if (Array.isArray(patches)) {
    return patches.filter(p => p && typeof p === 'object' && p.recovered_new_count !== undefined);
  }
  if (patches && typeof patches === 'object') {
    if (Array.isArray(patches.observations)) return patches.observations;
    if (Array.isArray(patches.tail_recheck_observations)) return patches.tail_recheck_observations;
  }
  return [];
}

/**
 * 应用 Checkpoint 补丁并修剪历史观察记录。
 * 1. 成功条目（complete/success）从 checkpoints 中清理/压缩移除
 * 2. 未解决的条目（partial/failed）写入 checkpoints 字典
 * 3. 滚动修剪 30 天以前的 tail_recheck_observations
 * 4. 更新 store.updated_at
 *
 * @param {object} store 现有 Checkpoint Store 对象
 * @param {Array|object} patches 补丁数组或对象
 * @param {string} [runId]
 * @param {string|Date} [now] 参考时间戳
 * @returns {object} 更新后的 store
 */
function applyCheckpointPatches(store, patches, runId = null, now = null) {
  if (!store || typeof store !== 'object') {
    throw new Error('applyCheckpointPatches requires a valid store object');
  }
  store.checkpoints = store.checkpoints || {};
  store.tail_recheck_observations = Array.isArray(store.tail_recheck_observations)
    ? store.tail_recheck_observations
    : [];

  const nowIso = (now ? new Date(now) : new Date()).toISOString();
  const cpRecords = extractCheckpointList(patches);
  const obsRecords = extractObservationList(patches);

  for (const rec of cpRecords) {
    let key = rec.key;
    if (!key && rec.window_id && rec.query_kind && rec.query_id && rec.query_hash) {
      key = checkpointKeyOf(rec);
    }
    if (!key) continue;

    if (rec.status === 'complete' || rec.status === 'success') {
      delete store.checkpoints[key];
    } else if (rec.status === 'partial' || rec.status === 'failed') {
      store.checkpoints[key] = buildCheckpointRecord({ ...rec, updated_at: nowIso });
    }
  }

  if (obsRecords.length > 0) {
    store.tail_recheck_observations.push(...obsRecords);
  }
  store.tail_recheck_observations = pruneTailRecheckObservations(
    store.tail_recheck_observations,
    nowIso,
    30
  );

  store.updated_at = nowIso;
  return store;
}

module.exports = {
  createDefaultCheckpointStore,
  readXCheckpointStore,
  writeXCheckpointStore,
  applyCheckpointPatches,
};
