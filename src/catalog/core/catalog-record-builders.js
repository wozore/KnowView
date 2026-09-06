'use strict';

const { TOOL_CARD_KINDS, THEMES, SERIES_KINDS, GENERATION_STATES, VISIBILITIES } = require('./catalog-contract');
const { isModelKey } = require('../../shared/model-key-contract');

function slugify(value, label) {
  const slug = String(value || '')
    .trim()
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!slug) throw new Error(`KEY_REQUIRED:${label}`);
  return slug;
}

function ref(kind, id) {
  return { kind, id };
}

// 统一模型键/可见性可选字段门禁：非法输入 fail-closed（错误码前缀见消息），
// undefined/null 不写入字段（存量记录零新字段、零漂移）。
function applyModelFields(record, { modelKey, visibility, historicalSince, detailKind, name }) {
  if (detailKind === 'api_model' && (modelKey === undefined || modelKey === null || String(modelKey).trim() === '')) {
    throw new Error(`MODEL_KEY_REQUIRED:${name}`);
  }
  if (detailKind !== 'api_model' && modelKey !== undefined && modelKey !== null) {
    throw new Error(`MODEL_KEY_NOT_APPLICABLE:${detailKind}`);
  }
  if (modelKey !== undefined && modelKey !== null && !isModelKey(String(modelKey))) {
    throw new Error(`MODEL_KEY_SYNTAX_INVALID:${modelKey}`);
  }
  if (visibility !== undefined && visibility !== null && !VISIBILITIES.includes(visibility)) {
    throw new Error(`VISIBILITY_INVALID:${visibility}`);
  }
  if (modelKey !== undefined && modelKey !== null) record.model_key = modelKey;
  if (visibility !== undefined && visibility !== null) record.visibility = visibility;
  if (historicalSince !== undefined && historicalSince !== null) record.historical_since = historicalSince;
}

function buildVendorCard({ vendorKey, title, icon, summary, featurePreview, accessLevel, priceBadge, searchTerms, level1Id }) {
  return {
    id: `vendor-card:${vendorKey}`,
    vendor_key: vendorKey,
    title,
    icon: icon || '',
    summary,
    feature_preview: featurePreview || [],
    access_level: accessLevel || '未知',
    price_badge: priceBadge || 'unknown',
    search_terms: searchTerms || [title, vendorKey].filter(Boolean),
    level1_ref: ref('vendor-level1', level1Id),
  };
}

function buildLevel1({ vendorKey, title, icon, officialUrl, description, status, features, level2Refs }) {
  return {
    id: `vendor-level1:${vendorKey}`,
    vendor_key: vendorKey,
    title,
    icon: icon || '',
    official_url: officialUrl || '',
    description,
    status: status || 'unknown',
    features: features || [],
    level2_refs: level2Refs || [],
  };
}

function buildLevel2({ vendorKey, level1Id, groupKey, title, officialUrl, summary, status, detailRefs, seriesKind, generationState }) {
  if (!seriesKind) throw new Error('SERIES_KIND_REQUIRED');
  if (!SERIES_KINDS.includes(seriesKind)) throw new Error(`SERIES_KIND_INVALID:${seriesKind}`);
  if (generationState !== undefined && generationState !== null && seriesKind !== 'model_series') {
    throw new Error(`GENERATION_STATE_NOT_APPLICABLE:${seriesKind}`);
  }
  if (generationState !== undefined && generationState !== null && !GENERATION_STATES.includes(generationState)) {
    throw new Error(`GENERATION_STATE_INVALID:${generationState}`);
  }
  const level2 = {
    id: `vendor-level2:${vendorKey}:${groupKey}`,
    level1_ref: ref('vendor-level1', level1Id),
    vendor_key: vendorKey,
    title,
    official_url: officialUrl || '',
    summary,
    status: status || 'unknown',
    detail_refs: detailRefs || [],
    series_kind: seriesKind,
  };
  if (generationState !== undefined && generationState !== null) level2.generation_state = generationState;
  return level2;
}

function buildDetail({ vendorKey, detailKind, theme, title, vendorLabel, icon, officialUrl, status, summary, oneMContext, apiPricing, plan, applicableScenarios, inapplicableScenarios, sources, releaseDate, lastUpdatedDate, modelKey, visibility, historicalSince }) {
  const detail = {
    vendor_key: vendorKey,
    detail_kind: detailKind,
    title,
    vendor_label: vendorLabel,
    icon: icon || '',
    official_url: officialUrl || '',
    status: status || 'unknown',
    summary,
    one_m_context: oneMContext ?? null,
    api_pricing: apiPricing ?? null,
    plan: plan ?? null,
    applicable_scenarios: applicableScenarios || [],
    inapplicable_scenarios: inapplicableScenarios || [],
    sources: sources || [],
    theme: theme || 'general',
  };
  if (detailKind === 'tool') detail.last_updated_date = lastUpdatedDate;
  if (detailKind === 'api_model' || detailKind === 'product_variant') detail.release_date = releaseDate;
  applyModelFields(detail, { modelKey, visibility, historicalSince, detailKind, name: title });
  return detail;
}

function buildToolCard({ toolKey, vendorKey, title, vendorLabel, icon, summary, theme, scenes, bestForPreview, notForPreview, priceBadge, accessLevel, searchTerms, detailId, detailKind, modelKey, visibility, historicalSince }) {
  if (!TOOL_CARD_KINDS.includes(detailKind)) throw new Error(`TOOL_CARD_KIND_INVALID:${detailKind}`);
  if (!THEMES.includes(theme)) throw new Error(`THEME_INVALID:${theme}`);
  const card = {
    id: `tool-card:${toolKey}`,
    tool_key: toolKey,
    vendor_key: vendorKey,
    title,
    vendor_label: vendorLabel,
    icon: icon || '',
    summary,
    theme,
    scenes: scenes || [],
    best_for_preview: bestForPreview || '',
    not_for_preview: notForPreview || '',
    price_badge: priceBadge || 'unknown',
    access_level: accessLevel || '未知',
    search_terms: searchTerms || [title, vendorLabel, toolKey].filter(Boolean),
    detail_ref: ref('tool-level3', detailId),
    detail_kind: detailKind,
  };
  applyModelFields(card, { modelKey, visibility, historicalSince, detailKind, name: title });
  return card;
}

function deriveKeys(seed) {
  const vendorKey = slugify(seed.vendor_key || seed.vendor_name, 'vendor_key');
  const toolKey = seed.tool_key ? slugify(seed.tool_key, 'tool_key') : slugify(seed.name, 'tool_key');
  const groupKey = slugify(seed.group_key || seed.placement?.new_group_title || seed.name, 'group_key').replace(/-models$/, '');
  const detailKey = seed.detail_key ? slugify(seed.detail_key, 'detail_key') : toolKey;
  return { vendorKey, toolKey, groupKey, detailKey };
}

module.exports = {
  slugify,
  ref,
  buildVendorCard,
  buildLevel1,
  buildLevel2,
  buildDetail,
  buildToolCard,
  deriveKeys,
};
