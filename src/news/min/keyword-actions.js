/**
 * keyword-actions.js —— 新闻关键词维护 mutation（纯本地、无 CLI/网络依赖）
 *
 * 关键词清单只允许维护者从 candidates 中选择 adopted_keywords 或丢弃（加入
 * keywords.excluded_keywords 黑名单，防止下次再被 AI 建议）；落盘时只改变
 * config.keywords.ai_keywords / excluded_keywords，并以 config revision 拒绝陈旧写入。
 */

'use strict';

const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');

const KEYWORD_PURPOSES = Object.freeze({
  content: Object.freeze({
    purpose: 'content',
    fileName: 'keyword-refine.json',
    targetField: 'content_keywords',
    excludedField: 'excluded_content_keywords',
    label: '内容识别词',
  }),
  youtube: Object.freeze({
    purpose: 'youtube',
    fileName: 'youtube-queries-refine.json',
    targetField: 'youtube_queries',
    excludedField: 'excluded_youtube_queries',
    label: 'YouTube 查询',
  }),
  x_discovery: Object.freeze({
    purpose: 'x_discovery',
    fileName: 'x-queries-refine.json',
    targetField: 'x_discovery_queries',
    excludedField: 'excluded_x_discovery_queries',
    label: 'X 发现查询',
  }),
});

function resolvePurpose(purpose = 'content') {
  const def = KEYWORD_PURPOSES[purpose];
  if (!def) {
    const err = new Error(`未知关键词用途：${purpose}`);
    err.code = 'NEWS_INVALID_KEYWORD_PURPOSE';
    throw err;
  }
  return def;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function revisionOfConfig(config) {
  return crypto.createHash('sha256').update(stableStringify(config || {})).digest('hex');
}

function assertExpectedConfigRevision(config, expectedRevision) {
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    throw new Error('关键词 mutation 必须提供 expected revision');
  }
  const actualRevision = revisionOfConfig(config);
  if (actualRevision !== expectedRevision) {
    const error = new Error(`配置 revision 冲突：expected=${expectedRevision}，actual=${actualRevision}`);
    error.code = 'REVISION_CONFLICT';
    error.expected_revision = expectedRevision;
    error.actual_revision = actualRevision;
    throw error;
  }
  return actualRevision;
}

/**
 * 三用途关键词清单采纳规则：
 * 候选字段合法且唯一，采纳项必须从 candidates 反查（禁止客户端裸词直接写配置），
 * 采纳后幂等追加到对应的正式配置段（content_keywords / youtube_queries / x_discovery_queries）。
 */
function applyRefineKeywords(config, list, options = {}) {
  const rawAdopted = list?.adopted_candidate_ids ?? list?.adopted_keywords;
  if (!list || list.kind !== 'keyword_refine_candidates' || !Array.isArray(list.candidates) || !Array.isArray(rawAdopted)) {
    throw new Error('非法关键词清单：需要 kind=\'keyword_refine_candidates\'，且含 candidates 与 adopted 数组');
  }
  const purpose = list.purpose || options.purpose || 'content';
  const purposeDef = resolvePurpose(purpose);
  const targetField = purposeDef.targetField;

  const candidateMap = new Map(); // id -> candidate item
  for (const candidate of list.candidates) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('关键词清单含非法 candidates 条目');
    }
    if (candidate.category !== undefined && (typeof candidate.category !== 'string' || !candidate.category.trim())) {
      throw new Error('关键词清单含非法 candidates 条目（category 不能为空）');
    }
    const val = candidate.value || candidate.word;
    const cid = candidate.candidate_id || candidate.id || (typeof val === 'string' ? `${purpose}:${val.trim()}` : null);
    if (!cid || !val) {
      throw new Error('关键词候选需具备有效 candidate_id 与 value');
    }
    if (candidate.purpose && candidate.purpose !== purpose) {
      throw new Error(`候选用途与清单用途不匹配：${candidate.purpose} !== ${purpose}`);
    }
    const key = String(cid).trim().toLowerCase();
    if (candidateMap.has(key)) throw new Error(`关键词清单含重复候选：${cid}`);
    candidateMap.set(key, { ...candidate, candidate_id: cid, value: val });
  }

  const adoptedItems = [];
  const seenKeys = new Set();
  let duplicates = 0;
  for (const raw of rawAdopted) {
    const rawStr = typeof raw === 'string' ? raw.trim() : (raw && raw.candidate_id ? String(raw.candidate_id).trim() : null);
    if (!rawStr) throw new Error('采纳项只能包含非空字符串或有效候选 ID');
    const key = rawStr.toLowerCase();
    const candidate = candidateMap.get(key) || candidateMap.get(`${purpose}:${key}`.toLowerCase()) || [...candidateMap.values()].find(c => String(c.value).toLowerCase() === key);
    if (!candidate) throw new Error(`adopted_keywords 含不在 candidates 中的词：${rawStr}`);
    const uniqueKey = candidate.candidate_id.toLowerCase();
    if (seenKeys.has(uniqueKey)) {
      duplicates += 1;
      continue;
    }
    seenKeys.add(uniqueKey);
    adoptedItems.push(candidate);
  }

  const nextConfig = { ...(config || {}), keywords: { ...((config && config.keywords) || {}) } };
  const hasContentField = Array.isArray(nextConfig.keywords[targetField]);
  const hasAiKeywords = purpose === 'content' && Array.isArray(nextConfig.keywords.ai_keywords);
  const existingList = hasContentField
    ? nextConfig.keywords[targetField].slice()
    : (hasAiKeywords ? nextConfig.keywords.ai_keywords.slice() : []);
  const added = [];
  const alreadyExists = [];

  if (purpose === 'x_discovery') {
    const existingIds = new Set(existingList.map(item => (typeof item === 'object' && item ? String(item.id).trim().toLowerCase() : String(item).trim().toLowerCase())));
    for (const item of adoptedItems) {
      const objVal = typeof item.value === 'object' && item.value ? item.value : { id: item.candidate_id.replace(/^x_discovery:/, ''), query: item.value, max_pages: 1 };
      const idKey = String(objVal.id).trim().toLowerCase();
      if (existingIds.has(idKey)) {
        alreadyExists.push(objVal.id);
        continue;
      }
      existingList.push(objVal);
      existingIds.add(idKey);
      added.push(objVal.id);
    }
    nextConfig.keywords[targetField] = existingList;
  } else {
    const existingKeys = new Set(existingList.map(w => String(w).trim().toLowerCase()));
    for (const item of adoptedItems) {
      const valStr = String(item.value).trim();
      const valKey = valStr.toLowerCase();
      if (existingKeys.has(valKey)) {
        alreadyExists.push(valStr);
        continue;
      }
      existingList.push(valStr);
      existingKeys.add(valKey);
      added.push(valStr);
    }
    if (hasContentField || !hasAiKeywords) {
      nextConfig.keywords[targetField] = existingList;
    }
    if (hasAiKeywords) {
      nextConfig.keywords.ai_keywords = existingList;
    }
  }
  return {
    config: nextConfig,
    purpose,
    target_field: targetField,
    added,
    already_exists: alreadyExists,
    duplicates,
    changed: added.length > 0,
  };
}

/** 纯 mutation：expected revision 通过后才生成配置候选，不做 I/O。 */
function applyKeywordActions(config, list, options = {}) {
  assertExpectedConfigRevision(config, options.expectedRevision);
  const result = applyRefineKeywords(config, list, options);
  return {
    ...result,
    before_revision: options.expectedRevision,
    revision: revisionOfConfig(result.config),
  };
}

/**
 * 丢弃关键词（黑名单）：把维护者明确不要的词加入对应用途的 excluded 列表。
 * 大小写不敏感去重，幂等追加。
 */
function applyKeywordExclusions(config, words, options = {}) {
  assertExpectedConfigRevision(config, options.expectedRevision);
  const purpose = options.purpose || 'content';
  const purposeDef = resolvePurpose(purpose);
  const excludedField = purposeDef.excludedField;

  const list = Array.isArray(words) ? words : [];
  const normalized = [];
  const seen = new Set();
  for (const raw of list) {
    const word = typeof raw === 'string' ? raw.trim() : (raw && raw.value ? String(raw.value).trim() : null);
    if (!word) throw new Error('丢弃的关键词只能是非空字符串');
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(word);
  }

  const nextConfig = { ...(config || {}), keywords: { ...((config && config.keywords) || {}) } };
  const existing = Array.isArray(nextConfig.keywords[excludedField]) ? nextConfig.keywords[excludedField].slice() : [];
  const existingKeys = new Set(existing.map(w => String(w).trim().toLowerCase()));
  const added = [];
  for (const word of normalized) {
    if (existingKeys.has(word.toLowerCase())) continue;
    existing.push(word);
    existingKeys.add(word.toLowerCase());
    added.push(word);
  }
  nextConfig.keywords[excludedField] = existing;
  return {
    config: nextConfig,
    purpose,
    excluded_field: excludedField,
    added,
    already_exists: normalized.filter(w => !added.some(a => a.toLowerCase() === w.toLowerCase())),
    changed: added.length > 0,
    before_revision: options.expectedRevision,
    revision: revisionOfConfig(nextConfig),
  };
}

/** 配置 guarded commit：把丢弃词原子写回 config；无新增词时不写盘。 */
function commitKeywordExclusions(words, options = {}) {
  const configPath = options.configPath || NEWS_FILES.configV2;
  const current = options.config || readJson(configPath, {});
  const result = applyKeywordExclusions(current, words, { expectedRevision: options.expectedRevision });
  if (result.changed) {
    const latest = readJson(configPath, {});
    assertExpectedConfigRevision(latest, options.expectedRevision);
    const latestResult = applyKeywordExclusions(latest, words, { expectedRevision: options.expectedRevision });
    if (options.writeConfig) options.writeConfig(latestResult.config, options.runId || 'keyword-exclusions', { expectedRevision: options.expectedRevision });
    else writeJsonAtomic(configPath, latestResult.config, options.runId || 'keyword-exclusions');
    return { ...latestResult, written: true };
  }
  return { ...result, written: false };
}

/**
 * 配置 guarded commit：磁盘校验 expected revision 后原子写回；无新增词时不写盘。
 * configPath/writeConfig 仅为离线调用注入，不改变默认单一配置写者。
 */
function commitKeywordActions(list, options = {}) {
  const configPath = options.configPath || NEWS_FILES.configV2;
  const current = options.config || readJson(configPath, {});
  const expectedRevision = options.expectedRevision;
  const result = applyKeywordActions(current, list, { expectedRevision });
  if (result.changed) {
    const latest = readJson(configPath, {});
    assertExpectedConfigRevision(latest, expectedRevision);
    const latestResult = applyKeywordActions(latest, list, { expectedRevision });
    if (options.writeConfig) options.writeConfig(latestResult.config, options.runId || 'keyword-actions', { expectedRevision });
    else writeJsonAtomic(configPath, latestResult.config, options.runId || 'keyword-actions');
    return { ...latestResult, written: true };
  }
  return { ...result, written: false };
}

module.exports = {
  KEYWORD_PURPOSES,
  resolvePurpose,
  revisionOfConfig,
  assertExpectedConfigRevision,
  applyRefineKeywords,
  applyKeywordActions,
  applyKeywordSelection: applyKeywordActions,
  commitKeywordActions,
  applyKeywordExclusions,
  commitKeywordExclusions,
};
