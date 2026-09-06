'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SHARED_FILES } = require('./paths');
const { isModelKey, VENDOR_KEY_RE } = require('./model-key-contract');

/**
 * model-identity-bridge.js — 共享段 `model-identity-bridge.json` 校验接口
 *
 * 统一模型键 ↔ 目录实体的桥接投影：Catalog 事务提交路径唯一写入（publish 挂点）、
 * 反哺查重与系列审计只读。数据耦合（封装 + 只公开接口）：业务模块只调用
 * `readModelIdentityBridge`（读）/ `writeModelIdentityBridge`（写），不裸 fs；
 * 写路径逐条形状校验 fail-closed 防误篡改并内部重算 revision（原子写），读路径
 * 校验后冻结，缺失/损坏回退空 + validation_errors（不抛）。
 */

const REQUIRED_STRING_FIELDS = Object.freeze([
  'model_key',
  'title',
  'vendor_key',
  'detail_id',
  'tool_card_id',
  'series_id',
  'official_url',
  'content_hash',
  'verified_at',
  'catalog_revision',
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 对 entries 稳定序列化后计算 sha256 revision（键序无关、确定性）。 */
function bridgeRevisionOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return `sha256:${crypto.createHash('sha256').update(stableStringify(list)).digest('hex')}`;
}

/** bridge 单条 entry 形状校验（纯逻辑）；返回错误消息数组（空 = 合法）。 */
function validateModelIdentityBridgeEntries(entries) {
  if (!Array.isArray(entries)) return ['entries 必须是数组'];
  const errors = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = `entries[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${label} 应为对象`); continue; }
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(`${label}.${field} 缺失或非空字符串`);
    }
    if (typeof entry.model_key === 'string' && entry.model_key && !isModelKey(entry.model_key)) {
      errors.push(`${label}.model_key 语法非法: ${entry.model_key}`);
    }
    if (typeof entry.vendor_key === 'string' && entry.vendor_key && !VENDOR_KEY_RE.test(entry.vendor_key)) {
      errors.push(`${label}.vendor_key 必须为小写 slug: ${entry.vendor_key}`);
    }
    if (typeof entry.verified_at === 'string' && entry.verified_at && Number.isNaN(Date.parse(entry.verified_at))) {
      errors.push(`${label}.verified_at 应为可解析的 ISO 时间戳`);
    }
  }
  return errors;
}

/**
 * 读共享 model-identity-bridge（反哺查重/审计只读；固定共享路径，`file` 仅供测试注入）。
 * 缺失/损坏回退空（revision: null, entries: []），损坏时以 validation_errors
 * 携带逐条诊断；返回结构冻结，不抛。
 */
function readModelIdentityBridge(file = SHARED_FILES.modelIdentityBridge, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const empty = () => Object.freeze({ schema_version: 1, revision: null, entries: [] });
  const invalid = errors => Object.freeze({
    schema_version: 1,
    revision: null,
    entries: [],
    validation_errors: Object.freeze([...errors]),
  });
  try {
    if (!file || !fsImpl.existsSync(file)) return empty();
    let value;
    try {
      value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (error) {
      return invalid([`bridge JSON 无法解析: ${error.message}`]);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.entries)) {
      return invalid(['bridge 必须是包含 entries 数组的对象']);
    }
    const errors = validateModelIdentityBridgeEntries(value.entries);
    const expectedRevision = bridgeRevisionOf(value.entries);
    if ((value.entries.length > 0 || value.revision !== null) && value.revision !== expectedRevision) {
      errors.push('bridge.revision 与 entries 内容不一致');
    }
    if (errors.length) return invalid(errors);
    const entries = Object.freeze(value.entries.map(entry => Object.freeze({ ...entry })));
    return Object.freeze({ schema_version: 1, revision: value.revision ?? null, entries });
  } catch (error) {
    return invalid([`bridge 读取失败: ${error.message}`]);
  }
}

/**
 * 写共享 model-identity-bridge（Catalog 事务提交路径 publish 挂点唯一写者）。
 * 逐条形状校验 fail-closed：非法返回 {ok:false, code:'SHARED_MODEL_IDENTITY_BRIDGE_INVALID'} 不落盘；
 * revision 由本模块内部对 entries 重算（不信任调用方传入），原子写（临时文件 + rename）。
 * @returns {{ok: boolean, count?: number, revision?: string, code?: string, errors?: string[], error?: string}}
 */
function writeModelIdentityBridge(entries, file = SHARED_FILES.modelIdentityBridge, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const errors = validateModelIdentityBridgeEntries(entries);
  if (errors.length) return { ok: false, code: 'SHARED_MODEL_IDENTITY_BRIDGE_INVALID', errors };
  const revision = bridgeRevisionOf(entries);
  const dir = path.dirname(file);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  const payload = { schema_version: 1, revision, generated_at: new Date().toISOString(), entries };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch {}
    return { ok: false, code: 'SHARED_MODEL_IDENTITY_BRIDGE_WRITE_FAILED', error: error.message };
  }
  return { ok: true, count: entries.length, revision };
}

module.exports = {
  REQUIRED_STRING_FIELDS,
  bridgeRevisionOf,
  validateModelIdentityBridgeEntries,
  readModelIdentityBridge,
  writeModelIdentityBridge,
};
