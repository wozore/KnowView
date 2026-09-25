import { escapeHtml, safeExternalUrl, formatPrice, renderTimelinessBadge, renderTaskTypeBadges } from '../ui/ui-helpers.js';
import { getToolDateDisplay } from '../ui/date-display.mjs';
import { ICON_ARROW_LEFT, ICON_EXTERNAL } from '../ui/ui-icons.js';
import { brandIconHtml } from '../ui/brand-icons.js';
import { getCatalogItems } from '../data/data-catalog.js';

function notApplicableHtml(title, value) {
  return value?.status === 'not_applicable'
    ? '<div class="intelligence-not-applicable"><b>' + escapeHtml(title) + '：</b>不适用<p>' + escapeHtml(value.reason || '未提供原因') + '</p></div>'
    : '';
}

const FREE_TIER_LABELS = { available: null, none: '无', unknown: '待核验' };
const CHINESE_SUPPORT_LABELS = { supported: '支持', partial: '部分支持', unsupported: '不支持', unknown: '待核验' };

// 免费额度展示：available 带 quota（+conditions）；none/unknown 中性陈述；not_applicable 复用不适用模式。
function renderFreeTier(freeTier) {
  if (!freeTier || typeof freeTier !== 'object') return '';
  if (freeTier.status === 'not_applicable') return notApplicableHtml('免费额度', freeTier);
  if (freeTier.status === 'available' && freeTier.quota) {
    const conditions = freeTier.conditions ? '（' + escapeHtml(freeTier.conditions) + '）' : '';
    return '<div class="intelligence-profile"><b>免费额度：</b>' + escapeHtml(freeTier.quota) + conditions + '</div>';
  }
  const label = FREE_TIER_LABELS[freeTier.status];
  return label
    ? '<div class="intelligence-profile' + (freeTier.status === 'unknown' ? ' intelligence-unknown' : '') + '"><b>免费额度：</b>' + label + '</div>'
    : '';
}

// 中文支持展示：supported/partial/unsupported/unknown；not_applicable 复用不适用模式。
function renderChineseSupport(chineseSupport) {
  if (!chineseSupport || typeof chineseSupport !== 'object') return '';
  if (chineseSupport.status === 'not_applicable') return notApplicableHtml('中文支持', chineseSupport);
  const label = CHINESE_SUPPORT_LABELS[chineseSupport.status];
  if (!label) return '';
  const conditions = chineseSupport.conditions ? '（' + escapeHtml(chineseSupport.conditions) + '）' : '';
  const unknownClass = chineseSupport.status === 'unknown' ? ' intelligence-unknown' : '';
  return '<div class="intelligence-profile' + unknownClass + '"><b>中文支持：</b>' + label + conditions + '</div>';
}

function renderScenario(title, items) {
  if (items?.status === 'not_applicable') return notApplicableHtml(title, items);
  if (!Array.isArray(items) || !items.length) return '';
  const invalid = items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !item.title || !item.description);
  if (invalid) return '<div class="intelligence-scenarios data-invalid"><h5>' + escapeHtml(title) + '</h5><p>资料结构异常，需重新生成后才能展示。</p></div>';
  return '<div class="intelligence-scenarios"><h5>' + escapeHtml(title) + '</h5>' + items.map(item =>
    '<div><b>' + escapeHtml(item.title) + '：</b>' + escapeHtml(item.description) + '</div>'
  ).join('') + '</div>';
}

function renderRateCard(rate) {
  if (Array.isArray(rate.metrics) && rate.metrics.length) {
    return '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b><div class="rate-grid">' + rate.metrics.map(metric =>
      '<span>' + escapeHtml(metric.label) + '<strong>' + formatPrice(metric.amount, rate.currency) + '</strong><small> / ' + escapeHtml(metric.unit) + '</small></span>'
    ).join('') + '</div><small>' + escapeHtml(rate.pricing_basis || '') + ' · ' + escapeHtml(rate.conditions || '') + '</small></div>';
  }
  return '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b><div class="rate-grid"><span>输入（缓存命中）<strong>' + formatPrice(rate.input_cached, rate.currency) + '</strong></span><span>输入（缓存未命中）<strong>' + formatPrice(rate.input_uncached, rate.currency) + '</strong></span><span>输出<strong>' + formatPrice(rate.output, rate.currency) + '</strong></span></div><small>单位：每百万 tokens · ' + escapeHtml(rate.conditions || '') + '</small></div>';
}

function renderPlanPrices(plan) {
  const period = escapeHtml({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '周期待核验' }[plan.billing_period] || plan.billing_period);
  if (Array.isArray(plan.regional_prices) && plan.regional_prices.length) {
    return '<div class="plan-price-lines">' + plan.regional_prices.map(price =>
      '<p class="plan-price-line"><b>' + escapeHtml(price.region || '地区') + '：</b>' + formatPrice(price.amount, price.currency) + ' / ' + period + '</p>'
    ).join('') + '</div>';
  }
  return '<p class="plan-price-line"><b>' + formatPrice(plan.amount, plan.currency) + ' / ' + period + '</b></p>';
}

function renderSubscriptionPlans(detail, plans) {
  const linkedPlans = (detail.subscription_plan_refs || [])
    .map(ref => plans.find(item => item.id === ref.id))
    .filter(item => item?.detail_kind === 'subscription_plan');
  if (!linkedPlans.length) return '';
  return '<div class="intelligence-pricing linked-plans"><h5>套餐价格</h5>' + linkedPlans.map(item => {
    const plan = item.plan || {};
    const includedModels = plan.included_models_status === 'not_listed'
      ? '官方未列出'
      : plan.included_models?.length ? plan.included_models.map(escapeHtml).join('、') : '';
    return '<section class="plan-card"><h5>' + escapeHtml(item.title) + '</h5>' + renderPlanPrices(plan) +
      (plan.conditions ? '<p>' + escapeHtml(plan.conditions) + '</p>' : '') +
      (includedModels ? '<p><b>主要模型：</b>' + includedModels + '</p>' : '') +
      '<button class="plan-detail-link" type="button" onclick="openDetail(\'' + escapeHtml(item.id) + '\',null,this,\'' + escapeHtml(detail.id) + '\')">查看套餐详情</button></section>';
  }).join('') + '</div>';
}

function renderPricingDisclosure(detail) {
  const disclosure = detail.pricing_disclosure;
  if (!disclosure?.text) return '';
  const title = disclosure.status === 'external_usage_cost' ? '额外使用费用' : '公开单价';
  const sources = (disclosure.source_urls || []).map(url => {
    const source = detail.sources?.find(item => item.url === url);
    return source ? '<a href="' + escapeHtml(safeExternalUrl(url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>' : '';
  }).filter(Boolean);
  return '<div class="intelligence-pricing pricing-disclosure"><h5>' + title + '</h5><p>' + escapeHtml(disclosure.text) + '</p>' + (sources.length ? '<small>依据：' + sources.join(' · ') + '</small>' : '') + '</div>';
}

function renderToolLevel3(request = {}) {
  const { detail, toolKey = null, showCompare = false, compareSelected = false, backRef = null } = request;
  if (!detail) return '<div class="intelligence-unavailable">工具详情暂不可用。</div>';
  const allDetails = request.subscriptionPlans || getCatalogItems('tool-level3');
  const isTool = detail.detail_kind === 'tool';
  const kindLabel = detail.detail_kind === 'api_model' ? '模型' : detail.detail_kind === 'subscription_plan' ? '套餐' : detail.detail_kind === 'product_variant' ? '变体' : '工具';
  const dateDisplay = getToolDateDisplay(detail);
  const showCompareAction = showCompare && detail.detail_kind !== 'subscription_plan';
  const sourceHtml = (detail.sources || []).length
    ? '<div class="intelligence-sources"><b>资料来源：</b>' + detail.sources.map(source =>
      '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join(' · ') + (dateDisplay ? '<span>' + dateDisplay.label + ' ' + escapeHtml(dateDisplay.value) + '</span>' : '') + '</div>'
    : '';
  const context = detail.one_m_context;
  const contextHtml = isTool || detail.detail_kind === 'subscription_plan'
    ? ''
    : context?.status === 'not_applicable'
      ? notApplicableHtml('上下文窗口', context)
      : context
        ? '<div class="intelligence-context"><b>1M 上下文：</b>' + escapeHtml({ native: '原生支持 1M', conditional: '特定条件支持 1M', not_supported: '不支持 1M', unknown: '1M 支持情况待核验' }[context.status] || '资料待核验') + (context.tokens ? '（' + Number(context.tokens).toLocaleString('zh-CN') + ' tokens）' : '') + (context.conditions ? '<p>' + escapeHtml(context.conditions) + '</p>' : '') + '</div>'
        : '';
  const pricing = detail.api_pricing;
  const rates = pricing?.status === 'not_applicable' ? [] : pricing?.rate_cards || [];
  const pricingHtml = isTool || detail.detail_kind === 'subscription_plan'
    ? ''
    : pricing?.status === 'not_applicable'
      ? notApplicableHtml('API 价格', pricing)
      : rates.length
        ? '<div class="intelligence-pricing"><h5>API 价格</h5>' + rates.map(renderRateCard).join('') + '</div>'
        : '';
  const plan = detail.plan;
  const planHtml = isTool
    ? ''
    : plan?.status === 'not_applicable'
      ? notApplicableHtml('套餐信息', plan)
      : plan
        ? '<div class="plan-card"><h5>套餐信息</h5>' + renderPlanPrices(plan) + '<p>' + escapeHtml(plan.conditions || '') + '</p><p><b>主要模型：</b>' + (plan.included_models_status === 'not_listed' ? '官方未列出' : plan.included_models?.length ? plan.included_models.map(escapeHtml).join('、') : '官方资料待核验') + '</p></div>'
        : '';
  const linkedPlansHtml = isTool ? renderSubscriptionPlans(detail, allDetails) : '';
  const disclosureHtml = isTool ? renderPricingDisclosure(detail) : '';
  const compareHtml = showCompareAction
    ? '<div class="leaf-actions"><button class="compare-toggle ' + (compareSelected ? 'selected' : '') + '" onclick="toggleCompareRef(\'' + escapeHtml(detail.id) + '\',\'' + escapeHtml(detail.id) + '\',this)">' + (compareSelected ? '已选' : '+对比') + '</button></div>'
    : '';
  const backHtml = backRef
    ? '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="openDetail(\'' + escapeHtml(backRef) + '\')">' + ICON_ARROW_LEFT + '</button>'
    : '';
  const vendorHtml = detail.vendor_label
    ? escapeHtml(detail.vendor_label) + ' · '
    : '';
  const detailIcon = brandIconHtml({
    vendorKey: detail.vendor_key,
    toolKey,
    detailId: detail.id,
    detailKind: detail.detail_kind,
    emoji: detail.icon,
  });
  return '<div class="model-index-page model-leaf-page">' + backHtml +
    '<section class="node-overview model-index-overview"><h2>' + detailIcon + ' ' + escapeHtml(detail.title) + '</h2>' + renderTaskTypeBadges(detail.task_types) + '<div class="vendor">' + vendorHtml + '<a href="' + escapeHtml(safeExternalUrl(detail.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div></section>' +
    '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + kindLabel + '</span><h4>' + escapeHtml(detail.title) + '</h4>' + (dateDisplay?.freshnessEligible ? renderTimelinessBadge(dateDisplay.value) : '') + '</div>' + compareHtml + '</div>' +
    '<div class="intelligence-item-body"><p>' + escapeHtml(detail.summary || '') + '</p>' + contextHtml + renderFreeTier(detail.free_tier) + renderChineseSupport(detail.chinese_support) + pricingHtml + planHtml + linkedPlansHtml + disclosureHtml + renderScenario('适用场景及说明', detail.applicable_scenarios) + renderScenario('不适用场景及说明', detail.inapplicable_scenarios) + sourceHtml + '</div></div></div>';
}

export { renderToolLevel3, renderScenario, renderRateCard, renderFreeTier, renderChineseSupport, notApplicableHtml };
export default renderToolLevel3;
