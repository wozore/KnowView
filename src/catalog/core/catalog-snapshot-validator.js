'use strict';

const {
  AREAS,
  ALLOWED_FIELDS,
  DETAIL_KINDS,
  TOOL_CARD_KINDS,
  THEMES,
  SERIES_KINDS,
  GENERATION_STATES,
  VISIBILITIES,
  DATE_FIELDS,
  isHttpUrl,
  normalizeSnapshot,
} = require('./catalog-contract');
const { isModelKey, findModelKeyCollisions } = require('../../shared/model-key-contract');

function error(code, path, message) {
  return { code, path, message };
}

function checkUnique(area, items, errors) {
  const ids = new Set();
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(error('ITEM_INVALID', `${area}[${index}]`, '记录必须是对象'));
      return;
    }
    if (!item.id) errors.push(error('ID_REQUIRED', `${area}[${index}].id`, '缺少 id'));
    else if (ids.has(item.id)) errors.push(error('ID_DUPLICATE', `${area}[${index}].id`, `重复 id: ${item.id}`));
    ids.add(item.id);
  });
}

function checkAllowedFields(area, items, errors) {
  const allowed = new Set(ALLOWED_FIELDS[area]);
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    Object.keys(item).filter(field => !allowed.has(field)).forEach(field => {
      errors.push(error('FIELD_NOT_ALLOWED', `${area}[${index}].${field}`, '包含未允许字段'));
    });
  });
}

function checkRef(sourceArea, source, targetArea, targetIds, field, errors) {
  source.forEach((item, index) => {
    const refs = Array.isArray(item?.[field])
      ? item[field]
      : item?.[field]
        ? [item[field]]
        : [];
    refs.forEach((ref, refIndex) => {
      const path = `${sourceArea}[${index}].${field}[${refIndex}]`;
      if (!ref || ref.kind !== targetArea || !ref.id || !targetIds.has(ref.id)) {
        errors.push(error('REF_INVALID', path, `引用不存在或类型错误: ${ref?.id || 'unknown'}`));
      }
    });
  });
}

function checkUrl(value, path, errors) {
  if (value !== null && value !== undefined && value !== '' && !isHttpUrl(value)) {
    errors.push(error('URL_INVALID', path, '仅允许 HTTP/HTTPS URL'));
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// 系列/模型键条件字段校验：全部"存在才校验"，存量记录缺失新字段零新报错。
function checkSeriesFields(normalized, errors) {
  const level2 = normalized['vendor-level2'];
  const level3 = normalized['tool-level3'];
  const cards = normalized['tool-card'];

  level2.forEach((item, index) => {
    const path = `vendor-level2[${index}]`;
    if (item.series_kind !== undefined && item.series_kind !== null && !SERIES_KINDS.includes(item.series_kind)) {
      errors.push(error('SERIES_KIND_INVALID', `${path}.series_kind`, `无效 series_kind: ${item.series_kind}`));
    }
    if (item.generation_state !== undefined && item.generation_state !== null && !GENERATION_STATES.includes(item.generation_state)) {
      errors.push(error('GENERATION_STATE_INVALID', `${path}.generation_state`, `无效 generation_state: ${item.generation_state}`));
    }
  });

  level3.forEach((item, index) => {
    const path = `tool-level3[${index}]`;
    if (item.model_key !== undefined && item.model_key !== null && (typeof item.model_key !== 'string' || !isModelKey(item.model_key))) {
      errors.push(error('MODEL_KEY_SYNTAX_INVALID', `${path}.model_key`, `非法 model_key 语法: ${item.model_key}`));
    }
    if (item.visibility !== undefined && item.visibility !== null && !VISIBILITIES.includes(item.visibility)) {
      errors.push(error('VISIBILITY_INVALID', `${path}.visibility`, `无效 visibility: ${item.visibility}`));
    }
    if (item.visibility === 'hidden_history' && !isIsoDate(item.historical_since)) {
      errors.push(error('HISTORY_DATE_REQUIRED', `${path}.historical_since`, 'hidden_history 记录必须有 ISO historical_since'));
    }
  });

  for (const collision of findModelKeyCollisions(level3)) {
    errors.push(error('MODEL_KEY_DUPLICATE', `tool-level3.${collision.model_key}`, `model_key 跨三级详情重复: ${collision.model_key} (${collision.members.join(', ')})`));
  }

  const detailById = new Map(level3.map(item => [item?.id, item]));
  cards.forEach((item, index) => {
    const path = `tool-card[${index}]`;
    if (item.model_key !== undefined && item.model_key !== null && (typeof item.model_key !== 'string' || !isModelKey(item.model_key))) {
      errors.push(error('MODEL_KEY_SYNTAX_INVALID', `${path}.model_key`, `非法 model_key 语法: ${item.model_key}`));
    }
    const detail = detailById.get(item?.detail_ref?.id);
    if (typeof item.model_key === 'string' && detail && typeof detail.model_key === 'string' && item.model_key !== detail.model_key) {
      errors.push(error('CARD_MODEL_KEY_MISMATCH', `${path}.model_key`, `工具卡与三级详情 model_key 不一致: ${item.model_key} != ${detail.model_key}`));
    }
  });

  const hiddenHistoryIds = new Set(level3.filter(item => item.visibility === 'hidden_history').map(item => item.id));
  const referencedByLevel2 = new Set();
  level2.forEach((item, level2Index) => {
    (Array.isArray(item.detail_refs) ? item.detail_refs : []).forEach((detailRef, refIndex) => {
      const refId = detailRef?.id;
      if (!refId) return;
      referencedByLevel2.add(refId);
      if (hiddenHistoryIds.has(refId)) {
        errors.push(error('HISTORY_STILL_REFERENCED', `vendor-level2[${level2Index}].detail_refs[${refIndex}]`, `hidden_history 详情不得出现在 detail_refs: ${refId}`));
      }
    });
  });

  level3.forEach((item, index) => {
    if (item.visibility !== undefined && item.visibility !== null && item.visibility !== 'hidden_history' && !referencedByLevel2.has(item.id)) {
      errors.push(error('L3_ORPHAN', `tool-level3[${index}]`, `带 visibility 的三级详情缺少可见二级系列父级: ${item.id}`));
    }
  });
}

function checkLevel3(level3, cardsByDetail, errors) {
  level3.forEach((item, index) => {
    const path = `tool-level3[${index}]`;
    if (!DETAIL_KINDS.includes(item.detail_kind)) {
      errors.push(error('DETAIL_KIND_INVALID', `${path}.detail_kind`, `无效 detail_kind: ${item.detail_kind}`));
    }
    if (!item.title || !item.detail_kind || !item.vendor_key) {
      errors.push(error('REQUIRED_FIELD_MISSING', path, '缺少 title/detail_kind/vendor_key'));
    }
    checkUrl(item.official_url, `${path}.official_url`, errors);
    for (const field of DATE_FIELDS) {
      const value = item[field];
      if (value !== null && value !== undefined && value !== '' && !isIsoDate(value)) {
        errors.push(error('DATE_INVALID', `${path}.${field}`, '格式必须为真实日期 YYYY-MM-DD'));
      }
    }
    if (item.detail_kind === 'subscription_plan' && DATE_FIELDS.some(field => item[field] !== null && item[field] !== undefined && item[field] !== '')) {
      errors.push(error('DATE_NOT_APPLICABLE', path, 'subscription_plan 不应保存 release_date 或 last_updated_date'));
    }
    if (item.detail_kind !== 'subscription_plan' && !THEMES.includes(item.theme)) {
      errors.push(error('THEME_INVALID', `${path}.theme`, `无效 theme: ${item.theme}`));
    }
    if (item.detail_kind === 'subscription_plan' && cardsByDetail.has(item.id)) {
      errors.push(error('SUBSCRIPTION_TOOL_CARD_FORBIDDEN', path, 'subscription_plan 不应生成工具卡'));
    }
    if (item.detail_kind !== 'subscription_plan' && !cardsByDetail.has(item.id)) {
      errors.push(error('TOOL_CARD_MISSING', path, '非套餐三级详情必须有对应工具卡'));
    }
    const card = cardsByDetail.get(item.id);
    if (card && (!TOOL_CARD_KINDS.includes(card.detail_kind) || card.detail_kind !== item.detail_kind || card.theme !== item.theme)) {
      errors.push(error('CARD_DETAIL_MISMATCH', path, '三级详情与工具卡 detail_kind/theme 不一致'));
    }
    if (item.sources?.some(source => !source?.title || !isHttpUrl(source.url))) {
      errors.push(error('SOURCE_INVALID', `${path}.sources`, '来源必须包含 title 和 HTTP/HTTPS url'));
    }
    if (
      item.one_m_context?.source_refs ||
      item.api_pricing?.rate_cards?.some(rate => rate.source_refs) ||
      item.api_pricing?.additional_charges?.some(charge => charge.source_refs) ||
      item.plan?.source_refs
    ) {
      errors.push(error('NESTED_SOURCE_REFS_FORBIDDEN', path, '不允许嵌套 source_refs'));
    }
  });
}

function validateCatalogSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const errors = [];

  for (const area of AREAS) {
    checkUnique(area, normalized[area], errors);
    checkAllowedFields(area, normalized[area], errors);
  }

  const ids = Object.fromEntries(AREAS.map(area => [area, new Set(normalized[area].map(item => item?.id))]));
  checkRef('vendor-card', normalized['vendor-card'], 'vendor-level1', ids['vendor-level1'], 'level1_ref', errors);
  checkRef('vendor-level1', normalized['vendor-level1'], 'vendor-level2', ids['vendor-level2'], 'level2_refs', errors);
  checkRef('vendor-level2', normalized['vendor-level2'], 'tool-level3', ids['tool-level3'], 'detail_refs', errors);
  checkRef('tool-card', normalized['tool-card'], 'tool-level3', ids['tool-level3'], 'detail_ref', errors);

  const cardsByDetail = new Map(normalized['tool-card'].map(item => [item?.detail_ref?.id, item]));
  checkLevel3(normalized['tool-level3'], cardsByDetail, errors);
  checkSeriesFields(normalized, errors);

  normalized['vendor-card'].forEach((item, index) => {
    if (!item?.title || !item.vendor_key || !item.summary) errors.push(error('REQUIRED_FIELD_MISSING', `vendor-card[${index}]`, '缺少 title/vendor_key/summary'));
  });
  normalized['tool-card'].forEach((item, index) => {
    if (!item?.title || !item.tool_key || !item.detail_ref) errors.push(error('REQUIRED_FIELD_MISSING', `tool-card[${index}]`, '缺少 title/tool_key/detail_ref'));
    if (!TOOL_CARD_KINDS.includes(item.detail_kind)) errors.push(error('TOOL_CARD_KIND_INVALID', `tool-card[${index}].detail_kind`, `不允许作为工具卡: ${item.detail_kind}`));
    if (!THEMES.includes(item.theme)) errors.push(error('THEME_INVALID', `tool-card[${index}].theme`, `无效 theme: ${item.theme}`));
  });

  return { ok: errors.length === 0, errors, snapshot: normalized };
}

module.exports = { validateCatalogSnapshot, error };
