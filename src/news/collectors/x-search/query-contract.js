/**
 * query-contract.js —— 账号组与关键词 Advanced Search 查询构造契约（T2 纯领域模块）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §4 与 §13.2 契约：
 * 1. Handle 规范化：去 '@'、trim、toLowerCase，组内与全局无重复
 * 2. 账号组查询构造：(from:OpenAI OR from:AnthropicAI) since_time:<since> until_time:<until>
 * 3. 本地保守保护门禁：单条 query ≤ 768 字符、组 handles ≤ 16、OR 分支 ≤ 16，超限抛错阻断
 * 4. discovery query 统一追加逻辑窗口时间条件
 * 5. 稳定 sha256 query_hash 生成
 */

'use strict';

const crypto = require('node:crypto');

const MAX_QUERY_LENGTH = 768;
const MAX_GROUP_HANDLES = 16;
const MAX_OR_BRANCHES = 16;

/**
 * 规范化单个 Handle：去 '@'、trim、折叠为小写。
 */
function normalizeHandle(handle) {
  if (typeof handle !== 'string') return '';
  return handle.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * 构造账号组 Advanced Search 查询语句。
 * 形如：(from:OpenAI OR from:AnthropicAI) since_time:<since_unix> until_time:<until_unix>
 */
function buildAccountGroupQuery(group, window) {
  if (!group || typeof group !== 'object') {
    throw new Error('Invalid account group: group must be an object');
  }
  if (!Array.isArray(group.handles) || group.handles.length === 0) {
    throw new Error(`Account group "${group.id || 'unknown'}" has no handles`);
  }
  if (group.handles.length > MAX_GROUP_HANDLES) {
    throw new Error(`Account group "${group.id}" exceeds max handles limit of ${MAX_GROUP_HANDLES}: got ${group.handles.length}`);
  }

  const seen = new Set();
  const cleanedHandles = [];
  for (const raw of group.handles) {
    const cleaned = typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
    const norm = cleaned.toLowerCase();
    if (!norm) {
      throw new Error(`Account group "${group.id}" contains empty or invalid handle: "${raw}"`);
    }
    if (seen.has(norm)) {
      throw new Error(`Account group "${group.id}" contains duplicate handle: "${raw}"`);
    }
    seen.add(norm);
    cleanedHandles.push(cleaned);
  }

  if (cleanedHandles.length > MAX_OR_BRANCHES) {
    throw new Error(`Account group "${group.id}" exceeds max OR branches: ${cleanedHandles.length}`);
  }

  if (!window || window.since_unix == null || window.until_unix == null) {
    throw new Error('Invalid window: since_unix and until_unix are required');
  }

  const fromClauses = cleanedHandles.map(h => `from:${h}`).join(' OR ');
  const query = `(${fromClauses}) since_time:${window.since_unix} until_time:${window.until_unix}`;

  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Constructed query exceeds max length ${MAX_QUERY_LENGTH} (length=${query.length}): "${query}"`);
  }

  return query;
}

/**
 * 构造 Discovery 关键词查询语句：在原 query 后追加当前逻辑窗口时间条件。
 */
function buildDiscoveryQuery(discoveryItem, window) {
  if (!discoveryItem || typeof discoveryItem !== 'object') {
    throw new Error('Invalid discovery item: must be an object');
  }
  const rawQuery = typeof discoveryItem.query === 'string' ? discoveryItem.query.trim() : '';
  if (!rawQuery) {
    throw new Error(`Discovery item "${discoveryItem.id || 'unknown'}" query is empty`);
  }
  if (!window || window.since_unix == null || window.until_unix == null) {
    throw new Error('Invalid window: since_unix and until_unix are required');
  }

  const query = `${rawQuery} since_time:${window.since_unix} until_time:${window.until_unix}`;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Discovery query exceeds max length ${MAX_QUERY_LENGTH} (length=${query.length}): "${query}"`);
  }

  return query;
}

/**
 * 生成稳定的 sha256 截短 hash 字符串供 checkpoint 关联。
 */
function generateQueryHash(query, window, extraConfig = null) {
  const normQuery = typeof query === 'string' ? query.trim() : '';
  const payload = JSON.stringify({
    query: normQuery,
    since: window?.since_unix ?? null,
    until: window?.until_unix ?? null,
    extra: extraConfig || null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * 校验账号组配置整体有效性及与 expectedAccounts 的并集完全一致。
 */
function validateAccountGroups(groups, expectedAccounts = null) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('Account groups must be a non-empty array');
  }

  const groupIds = new Set();
  const allHandles = new Set();

  for (const g of groups) {
    if (!g.id || typeof g.id !== 'string') {
      throw new Error(`Group must have a non-empty string id: ${JSON.stringify(g)}`);
    }
    if (groupIds.has(g.id)) {
      throw new Error(`Duplicate group id: "${g.id}"`);
    }
    groupIds.add(g.id);

    if (!Array.isArray(g.handles) || g.handles.length === 0) {
      throw new Error(`Group "${g.id}" has no handles`);
    }
    if (g.handles.length > MAX_GROUP_HANDLES) {
      throw new Error(`Group "${g.id}" exceeds max handles limit of ${MAX_GROUP_HANDLES}`);
    }

    const groupSeen = new Set();
    for (const h of g.handles) {
      const norm = normalizeHandle(h);
      if (!norm) {
        throw new Error(`Group "${g.id}" contains empty handle: "${h}"`);
      }
      if (groupSeen.has(norm)) {
        throw new Error(`Group "${g.id}" has duplicate handle inside group: "${h}"`);
      }
      groupSeen.add(norm);

      if (allHandles.has(norm)) {
        throw new Error(`Handle "${h}" appears in multiple groups`);
      }
      allHandles.add(norm);
    }
  }

  if (Array.isArray(expectedAccounts)) {
    const expectedNorms = new Set(expectedAccounts.map(normalizeHandle).filter(Boolean));
    if (allHandles.size !== expectedNorms.size) {
      throw new Error(`Account groups union size (${allHandles.size}) does not match expected (${expectedNorms.size})`);
    }
    for (const norm of expectedNorms) {
      if (!allHandles.has(norm)) {
        throw new Error(`Missing expected account in groups: "${norm}"`);
      }
    }
  }

  return true;
}

module.exports = {
  normalizeHandle,
  buildAccountGroupQuery,
  buildDiscoveryQuery,
  generateQueryHash,
  validateAccountGroups,
};
