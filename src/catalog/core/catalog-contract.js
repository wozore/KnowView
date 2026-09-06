'use strict';

const AREAS = Object.freeze([
  'vendor-card',
  'tool-card',
  'vendor-level1',
  'vendor-level2',
  'tool-level3',
]);

const VENDOR_CARD_FIELDS = Object.freeze([
  'id', 'vendor_key', 'title', 'icon', 'summary', 'feature_preview',
  'access_level', 'price_badge', 'search_terms', 'level1_ref',
]);
const TOOL_CARD_FIELDS = Object.freeze([
  'id', 'tool_key', 'vendor_key', 'title', 'vendor_label', 'icon', 'summary', 'theme',
  'scenes', 'best_for_preview', 'not_for_preview', 'price_badge',
  'access_level', 'search_terms', 'detail_ref', 'detail_kind',
  'model_key', 'visibility', 'historical_since',
]);
const VENDOR_LEVEL1_FIELDS = Object.freeze([
  'id', 'vendor_key', 'title', 'icon', 'official_url',
  'description', 'status', 'features', 'level2_refs',
]);
const VENDOR_LEVEL2_FIELDS = Object.freeze([
  'id', 'level1_ref', 'vendor_key', 'title', 'official_url', 'summary', 'status',
  'detail_refs',
  'series_kind', 'generation_state',
]);
const TOOL_LEVEL3_FIELDS = Object.freeze([
  'id', 'vendor_key', 'detail_kind', 'theme', 'title', 'vendor_label', 'icon', 'official_url',
  'status', 'summary', 'one_m_context', 'api_pricing', 'plan',
  'applicable_scenarios', 'inapplicable_scenarios', 'sources',
  'release_date', 'last_updated_date',
  'model_key', 'visibility', 'historical_since',
]);

const DATE_FIELDS = Object.freeze(['release_date', 'last_updated_date']);

// 统一模型键/系列字段枚举（阶段反哺与系列聚合契约）：model_key 只经
// src/shared/model-key-contract 算法生成；visibility/series_kind/generation_state
// 为条件字段（存在才校验，存量数据缺失合法）。
const SERIES_KINDS = Object.freeze(['model_series', 'subscription_series', 'tool_series']);
const GENERATION_STATES = Object.freeze(['newest', 'previous']);
const VISIBILITIES = Object.freeze(['visible', 'hidden_history']);

// 各层级条件字段：不做无条件必填检查，存在才校验（存量兼容）。
const CONDITIONAL_FIELDS = Object.freeze({
  'tool-level3': Object.freeze(['model_key', 'visibility', 'historical_since']),
  'tool-card': Object.freeze(['model_key', 'visibility', 'historical_since']),
  'vendor-level2': Object.freeze(['series_kind', 'generation_state']),
});

const ALLOWED_FIELDS = Object.freeze({
  'vendor-card': VENDOR_CARD_FIELDS,
  'tool-card': TOOL_CARD_FIELDS,
  'vendor-level1': VENDOR_LEVEL1_FIELDS,
  'vendor-level2': VENDOR_LEVEL2_FIELDS,
  'tool-level3': TOOL_LEVEL3_FIELDS,
});

const DETAIL_KINDS = Object.freeze(['tool', 'api_model', 'subscription_plan', 'product_variant']);
const TOOL_CARD_KINDS = Object.freeze(['tool', 'api_model', 'product_variant']);
const THEMES = Object.freeze(['general', 'dev', 'vision', 'media']);

const REF_TARGETS = Object.freeze({
  'vendor-card.level1_ref': 'vendor-level1',
  'vendor-level1.level2_refs': 'vendor-level2',
  'vendor-level2.detail_refs': 'tool-level3',
  'tool-card.detail_ref': 'tool-level3',
});

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function areaItems(snapshot, area) {
  const value = snapshot && snapshot[area];
  return Array.isArray(value) ? value : [];
}

function emptySnapshot() {
  return Object.fromEntries(AREAS.map(area => [area, []]));
}

function normalizeSnapshot(snapshot) {
  const normalized = emptySnapshot();
  for (const area of AREAS) normalized[area] = areaItems(snapshot, area);
  return normalized;
}

module.exports = {
  AREAS,
  ALLOWED_FIELDS,
  DETAIL_KINDS,
  TOOL_CARD_KINDS,
  THEMES,
  SERIES_KINDS,
  GENERATION_STATES,
  VISIBILITIES,
  CONDITIONAL_FIELDS,
  DATE_FIELDS,
  REF_TARGETS,
  isHttpUrl,
  emptySnapshot,
  normalizeSnapshot,
};
