'use strict';

const { ALLOWED_FIELDS, CONDITIONAL_FIELDS, DATE_FIELDS } = require('./catalog-contract');

const NOT_APPLICABLE_STATUS = 'not_applicable';
const FORBIDDEN_PLACEHOLDERS = new Set(['unknown', '未知', '资料状态未知', '待核验', 'n/a', 'na']);

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isExplicitValue(value) {
  return typeof value === 'string' && value.trim().length > 0 && !FORBIDDEN_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function walkDefaults(value, path, errors) {
  if (value === null || value === undefined) return addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止 null/undefined');
  if (typeof value === 'string') {
    if (!isExplicitValue(value) && value !== NOT_APPLICABLE_STATUS) addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止空值或 unknown/未知');
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止空数组');
    value.forEach((item, index) => walkDefaults(item, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value === 'object') Object.entries(value).forEach(([field, nested]) => walkDefaults(nested, `${path}.${field}`, errors));
}

// 条件字段规则：仅当字段出现在记录上（或触发条件成立）时校验，存量缺失不报错。
function checkConditionalFields(area, record, basePath, errors) {
  if ((area === 'tool-level3' || area === 'tool-card') && record.detail_kind === 'api_model' && !(typeof record.model_key === 'string' && record.model_key.trim())) {
    addError(errors, 'MODEL_KEY_REQUIRED', `${basePath}.model_key`, 'planned api_model 记录必须携带统一 model_key');
  }
  if (record.visibility === 'hidden_history' && !isIsoDate(record.historical_since)) {
    addError(errors, 'HISTORY_DATE_REQUIRED', `${basePath}.historical_since`, 'hidden_history 记录必须有 ISO historical_since');
  }
}

function validatePlannedRecords(recordsByArea) {
  const errors = [];
  Object.entries(recordsByArea || {}).forEach(([area, records]) => {
    const conditional = new Set(CONDITIONAL_FIELDS[area] || []);
    (records || []).forEach((record, index) => {
      const basePath = `${area}[${index}]`;
      (ALLOWED_FIELDS[area] || []).forEach(field => {
        if (DATE_FIELDS.includes(field)) return;
        if (conditional.has(field)) return; // 条件字段豁免无条件必填（存在才校验）
        if (!Object.prototype.hasOwnProperty.call(record, field)) addError(errors, 'GENERATED_FIELD_MISSING', `${basePath}.${field}`, '生成记录缺少契约字段');
      });
      checkConditionalFields(area, record || {}, basePath, errors);
      walkDefaults(record, basePath, errors);
    });
  });
  return { ok: errors.length === 0, errors };
}

module.exports = {
  NOT_APPLICABLE_STATUS,
  FORBIDDEN_PLACEHOLDERS,
  isExplicitValue,
  validatePlannedRecords,
};
