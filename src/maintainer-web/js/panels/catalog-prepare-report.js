import { request } from '../api.js';
import { state, $, addText, clearChildren, showNotice } from '../state.js';

const PHASE_LABELS = Object.freeze({
  source_resolution: '官方来源解析',
  identity_verification: '身份核验',
  series_routing: '系列分流',
  candidate_conversion: '候选转换',
  placement: '模型系列放置',
  draft_plan: 'Draft 规划',
  draft_generation: 'Draft 生成',
  catalog_prepare: '批次准备',
});

const CODE_REASONS = Object.freeze({
  IDENTITY_EVIDENCE_MISSING: '没有取得可验证的官方来源或正文。',
  IDENTITY_AI_UNAVAILABLE: '身份建议调用失败或返回内容无效。',
  IDENTITY_VENDOR_UNRESOLVED: '厂商身份未通过厂商政策校验。',
  IDENTITY_VENDOR_MISMATCH: '身份建议的厂商与登记的官方厂商不一致。',
  IDENTITY_VENDOR_DOMAIN_UNVERIFIED: '命中正文的域名未在厂商政策或官方登记中确认。',
  IDENTITY_CANDIDATE_MISMATCH: '官方正文支持的身份与待审核候选名不一致。',
  IDENTITY_NAME_NOT_IN_BODY: '官方正文没有命中候选模型名称。',
  IDENTITY_EVIDENCE_CONFLICT: '不同官方来源之间出现身份冲突。',
  IDENTITY_BUDGET_EXHAUSTED: '身份核验成本预算已用完。',
  PLACEMENT_MANUAL_REQUIRED: '系列位置需要人工确认。',
  PLACEMENT_REQUIRED_FOR_API_MODEL: 'API 模型缺少有效的系列位置。',
  SERIES_VERIFIED_USE_BUNDLE: '该候选被判定为系列，请走 SeriesBundle 流程。',
});

function blockerReason(item) {
  return String(item.reason || CODE_REASONS[item.code] || '未返回更具体的失败原因。');
}

function blockerPhase(item) {
  if (PHASE_LABELS[item.phase]) return PHASE_LABELS[item.phase];
  const code = String(item.code || '');
  if (code.startsWith('IDENTITY_')) return PHASE_LABELS.identity_verification;
  if (code.startsWith('PLACEMENT_')) return PHASE_LABELS.placement;
  if (code.startsWith('SERIES_')) return PHASE_LABELS.series_routing;
  if (code.startsWith('PENDING_')) return PHASE_LABELS.candidate_conversion;
  if (code.startsWith('SOURCE_') || code.startsWith('VENDOR_') || code.startsWith('TAVILY_')) return PHASE_LABELS.source_resolution;
  if (code.startsWith('DRAFT_')) return PHASE_LABELS.draft_generation;
  return PHASE_LABELS.catalog_prepare;
}

export function renderCatalogPrepareReport(payload = null) {
  const root = $('#catalogPrepareReport');
  if (!root) return;
  clearChildren(root);
  if (!payload) {
    addText(root, 'p', '准备后显示成功 Draft 与逐卡阻断原因。', 'muted');
    return;
  }
  const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
  const completed = Array.isArray(payload.completed) ? payload.completed : [];
  const blocked = Array.isArray(payload.blocked) ? payload.blocked : [];
  addText(root, 'p', `本次准备：生成或复用 ${drafts.length} 个，已在目录 ${completed.length} 个，阻断 ${blocked.length} 个。`, blocked.length ? 'item-blocked' : 'item-summary');
  for (const draft of drafts) {
    addText(root, 'p', `${draft.candidate_name || draft.candidate_key || 'Draft'}：${draft.reused ? '已复用' : '已生成'}`, 'item-summary');
  }
  for (const item of completed) addText(root, 'p', `${item.name || item.candidate_key || '候选'}：已在目录中，无需生成 Draft`, 'item-summary');
  for (const item of blocked) {
    const row = document.createElement('article');
    row.className = 'queue-item';
    const content = document.createElement('div');
    content.className = 'item-content';
    addText(content, 'h3', item.name || item.candidate_key || '未命名候选', 'item-title');
    addText(content, 'p', `${blockerPhase(item)} · ${item.code || 'DRAFT_BLOCKED'}`, 'item-blocked');
    addText(content, 'p', blockerReason(item), 'muted');
    row.appendChild(content);
    root.appendChild(row);
  }
}

export async function planCatalog(button) {
  button.disabled = true;
  renderCatalogPrepareReport(null);
  try {
    state.catalogPlan = await request('catalog/plan');
    state.revisions.catalog = state.catalogPlan.catalog_revision || '';
    const prepareButton = $('#catalogPrepareButton');
    if (prepareButton) prepareButton.disabled = !state.catalogPlan.ok;
    const cost = state.catalogPlan.cost_plan || {};
    const costSummary = `厂商搜索 ≤${Number(cost.vendor_search_primary_upper_bound || 0)} 次（备用 ≤${Number(cost.vendor_search_fallback_upper_bound || 0)}）；身份搜索 ≤${Number(cost.verification_search_primary_upper_bound || 0)} 次（备用 ≤${Number(cost.verification_search_fallback_upper_bound || 0)}）；身份正文提取备用 ≤${Number(cost.verification_extract_upper_bound || 0)} 次；Catalog 正文提取备用 ≤${Number(cost.extract_fallback_upper_bound || 0)} 次；身份 responses ≤${Number(cost.verification_responses_upper_bound || 0)} 次；研究搜索总上限 ≤${Number(cost.search_queries || 0)} 次、页面 ≤${Number(cost.pages || 0)}、responses ≤${Number(cost.responses_calls || 0)}、合成 ≤${Number(cost.synthesis_calls || 0)}；placement AI ≤${Number(cost.placement_ai_calls_upper_bound || 0)} 次`;
    showNotice(state.catalogPlan.ok ? `Catalog 计划已生成。成本上限：${costSummary}。请确认后准备。` : '当前没有可进入 Catalog 的已批准待补卡。', state.catalogPlan.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || 'Catalog 计划失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function prepareCatalog(button, onRefreshAll) {
  const plan = state.catalogPlan;
  if (!plan || !$('#catalogCostConfirm').checked) {
    showNotice('请先生成计划并确认 Catalog 成本。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('catalog/prepare', {
      method: 'POST',
      body: JSON.stringify({ pending_revision: plan.pending_revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, confirm_cost: true }),
    });
    renderCatalogPrepareReport(result);
    if (!result?.ok) throw new Error(result?.code || 'Catalog Draft 准备被阻断');
    const blockedCount = Array.isArray(result.blocked) ? result.blocked.length : 0;
    const completedCount = Array.isArray(result.completed) ? result.completed.length : 0;
    showNotice(blockedCount
      ? `Catalog Draft 部分完成：生成或复用 ${result.drafts?.length || 0} 个，已在目录 ${completedCount} 个，阻断 ${blockedCount} 个；请查看逐卡原因。`
      : completedCount && !result.drafts?.length
        ? `本批 ${completedCount} 个候选已在目录中，无需生成 Draft。`
        : `Catalog Draft 已准备 ${result.drafts?.length || 0} 个，仍需逐项审核后 Apply。`, blockedCount ? 'warning' : 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    const blocked = error.payload?.blocked;
    renderCatalogPrepareReport(Array.isArray(blocked)
      ? error.payload
      : { drafts: [], blocked: [{ name: 'Catalog 批次', phase: 'catalog_prepare', code: error.code || 'DRAFT_BLOCKED', reason: error.payload?.blocking_reasons?.join('；') || error.message || 'Catalog Draft 准备失败。' }] });
    const msg = (error.code || error.message) === 'PREPARE_IN_PROGRESS'
      ? '已有一轮 Catalog Draft 准备在执行中，请等待完成后点击“刷新数据”查看进度。'
      : (Array.isArray(blocked) && blocked.length
        ? `Catalog Draft 准备受阻：${blocked.slice(0, 3).map(item => `${item.name || item.candidate_key || '候选'}（${item.code || 'DRAFT_BLOCKED'}）`).join('；')}`
        : (error.message || 'Catalog Draft 准备失败。'));
    showNotice(msg, 'error');
  } finally {
    button.disabled = false;
  }
}
