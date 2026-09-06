'use strict';

/**
 * model-key-contract.js — 统一模型键（model_key）唯一算法与校验契约
 *
 * model_key = `${vendor_key}-${identity}`，identity 由 normalizeModelIdentity 生成：
 * trim → NFKC → 小写 → 空白/下划线/Unicode 破折号折叠为 '-' → '.' 仅当左右均为数字时
 * 保留（版本小数点，如 gpt-5.6），否则折叠为 '-' → 连续 '-' 收敛 → 去首尾 '-'/'.'。
 * 展示标题独立保存，不从 key 反推。
 * 不变量：model_key 只由本模块算法生成，任何模块不得手拼 `vendor + '-' + name`；
 * 非法输入 fail-closed 抛错（err.code = MODEL_IDENTITY_EMPTY / VENDOR_KEY_INVALID），不静默降级。
 */

const VENDOR_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// NFKC 不折叠的 Unicode 破折号/减号家族（含 U+2010-U+2015 与 U+FF0D 全角负号防御项）。
const UNICODE_DASH_RE = /[˗֊־᐀᠆‐-―⁃⁓⁻₋−⸺⸻〜〰﹘﹣－]/g;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function emptyIdentityError(value) {
  return fail('MODEL_IDENTITY_EMPTY', `模型身份不能为空: ${JSON.stringify(value)}`);
}

/**
 * 模型身份归一化（唯一算法）：trim → NFKC → 小写 → 空白/下划线/Unicode 破折号 → '-'；
 * '.' 仅当左右均为数字时保留，否则 → '-'；连续 '-' 收敛；去首尾 '-'/'.'；
 * 归一化后为空抛 MODEL_IDENTITY_EMPTY。幂等：对已归一化输入原样返回。
 */
function normalizeModelIdentity(value) {
  if (value === null || value === undefined) throw emptyIdentityError(value);
  let s = String(value).trim();
  if (!s) throw emptyIdentityError(value);
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/_/g, '-');
  s = s.replace(UNICODE_DASH_RE, '-');
  s = s.replace(/\.+/g, (dots, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : '';
    const after = offset + dots.length < str.length ? str[offset + dots.length] : '';
    return /\d/.test(before) && /\d/.test(after) ? dots : '-';
  });
  s = s.replace(/-+/g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  if (!s) throw emptyIdentityError(value);
  return s;
}

/**
 * 统一模型键生成（唯一入口）：vendor_key 必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 * （支持 black-forest-labs 这类含短横线厂商），否则抛 VENDOR_KEY_INVALID；
 * identity 经 normalizeModelIdentity 归一化（幂等）后拼接 `${vendor}-${identity}`。
 */
function modelKeyOf(vendorKey, identity) {
  if (typeof vendorKey !== 'string' || !VENDOR_KEY_RE.test(vendorKey)) {
    throw fail('VENDOR_KEY_INVALID', `vendor_key 必须为小写 slug: ${JSON.stringify(vendorKey)}`);
  }
  return `${vendorKey}-${normalizeModelIdentity(identity)}`;
}

/**
 * model_key 最长前缀切分：在 vendorKeys 中找作为 model_key 前缀（后跟 '-'）的最长厂商键，
 * 支持 black-forest-labs 这类含短横线厂商；无命中返回 null。
 * @returns {{vendor_key: string, identity: string} | null}
 */
function parseModelKey(modelKey, vendorKeys) {
  if (typeof modelKey !== 'string' || !modelKey || !Array.isArray(vendorKeys)) return null;
  const hits = [];
  for (const vendor of vendorKeys) {
    if (typeof vendor === 'string' && vendor && modelKey.startsWith(`${vendor}-`)) hits.push(vendor);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const vendor = hits[0];
  const identity = modelKey.slice(vendor.length + 1);
  if (!identity) return null;
  return { vendor_key: vendor, identity };
}

/** identity 是否已是合法归一化形态（round-trip 幂等判定）。 */
function isModelIdentity(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    return normalizeModelIdentity(value) === value;
  } catch {
    return false;
  }
}

/** model_key 语法判定：首段为合法 vendor slug，其余为合法 identity。 */
function isModelKey(value) {
  if (typeof value !== 'string') return false;
  const sep = value.indexOf('-');
  if (sep <= 0 || sep === value.length - 1) return false;
  return VENDOR_KEY_RE.test(value.slice(0, sep)) && isModelIdentity(value.slice(sep + 1));
}

/**
 * 跨记录 model_key 碰撞检测：entries 元素取 model_key 字段（缺失/非字符串跳过），
 * 标识取 id/detail_id（缺省回退 #index）。仅返回出现 ≥2 次的分组。
 * @returns {Array<{model_key: string, members: string[]}>}
 */
function findModelKeyCollisions(entries) {
  if (!Array.isArray(entries)) return [];
  const byKey = new Map();
  entries.forEach((entry, index) => {
    const key = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.model_key : null;
    if (typeof key !== 'string' || !key) return;
    const member = entry && (entry.id || entry.detail_id) ? String(entry.id || entry.detail_id) : `#${index}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(member);
  });
  return Array.from(byKey.entries())
    .filter(([, members]) => members.length > 1)
    .map(([modelKey, members]) => ({ model_key: modelKey, members }));
}

module.exports = {
  VENDOR_KEY_RE,
  normalizeModelIdentity,
  modelKeyOf,
  parseModelKey,
  isModelIdentity,
  isModelKey,
  findModelKeyCollisions,
};
