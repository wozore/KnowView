import { request, listFrom, ApiError } from '../api.js';
import { state, $, addText, addBadge, clearChildren, showNotice } from '../state.js';
import { discardButtonFor } from './catalog-draft-discard.js';
import { planCatalog, prepareCatalog } from './catalog-prepare-report.js';
import { planBundle, prepareBundle, renderCatalogBundles } from './catalog-bundle-panel.js';
export { planCatalog, prepareCatalog };
export { renderCatalogBundles };
export function recoveryControlsFor(draft, content, onRefreshAll) {
  if (!draft.recovery_kind || draft.readiness === 'ready') return;
  const panel = document.createElement('div');
  panel.className = 'recovery-panel';
  addText(panel, 'p', `${draft.error_code || 'DRAFT_BLOCKED'}：${(draft.blocking_reasons || []).join('；')}`, 'item-blocked');
  if (draft.error_code === 'DRAFT_BASE_REVISION_STALE') { addText(panel, 'p', '此旧 Draft 不会进入当前批次；请保留或丢弃它，并使用当前 Catalog 基线重新准备候选。', 'muted'); discardButtonFor(draft, panel, onRefreshAll); content.appendChild(panel); return; }
  if (draft.missing_fields?.length) addText(panel, 'p', `缺失官方字段：${draft.missing_fields.join('、')}`, 'item-blocked');
  if (draft.suggested_detail_kind) addText(panel, 'p', `建议候选类型：${draft.suggested_detail_kind}`, 'item-blocked');
  const researchCanResume = draft.recovery_mode === 'research_resume' && ['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind);
  if (draft.recovery_kind === 'manual_required' || (['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind) && !researchCanResume)) {
    addText(panel, 'p', '此 Draft 需要人工补充资料或修正候选信息，不能通过运行配置重试。', 'muted');
    discardButtonFor(draft, panel, onRefreshAll);
    content.appendChild(panel);
    return;
  }
  const controls = document.createElement('div');
  controls.className = 'recovery-controls';
  const configFields = Array.isArray(draft.missing_config_fields) ? draft.missing_config_fields : [];
  const inputs = new Map();
  const defaults = { model: 'glm-5.3-flash', provider: 'zhipu', protocol: 'messages', search_provider: 'zhipu_web_search', search_fallback_provider: 'tavily', extract_provider: 'direct_fetch', extract_fallback_provider: 'tavily', search_engine: 'search_std', access_mode: 'keyless', max_search_queries: 8, max_pages: 16, max_responses_calls: 16, max_synthesis_calls: 2 };
  const numericFields = {
    max_search_queries: { label: '搜索请求上限', min: 1, max: 20 },
    max_pages: { label: '官方正文页上限', min: 1, max: 100 },
    max_responses_calls: { label: 'AI responses 上限', min: 1, max: 50 },
    max_synthesis_calls: { label: '目录合成上限', min: 1, max: 5 },
  };
  const fieldLabels = { model: '模型', provider: 'AI 服务商', protocol: '协议', search_provider: '首选搜索', search_fallback_provider: '备用搜索', extract_provider: '正文获取', extract_fallback_provider: '备用正文提取', search_engine: '搜索引擎', access_mode: 'Tavily 访问模式' };
  for (const field of configFields) {
    if (!['model', 'provider', 'protocol', 'search_provider', 'search_fallback_provider', 'extract_provider', 'extract_fallback_provider', 'search_engine', 'access_mode', ...Object.keys(numericFields)].includes(field)) continue;
    const label = document.createElement('label');
    label.className = 'recovery-field';
    label.textContent = fieldLabels[field] || numericFields[field]?.label || field;
    const input = document.createElement('input');
    const numeric = numericFields[field];
    input.type = numeric ? 'number' : 'text';
    if (numeric) {
      input.min = String(numeric.min);
      input.max = String(numeric.max);
      input.step = '1';
    }
    input.value = String(defaults[field] || '');
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    controls.appendChild(label);
    inputs.set(field, input);
  }
  const cost = document.createElement('label');
  cost.className = 'cost-check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = true;
  cost.appendChild(checkbox);
  addText(cost, 'span', '确认本次增量 AI 成本');
  controls.appendChild(cost);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'button button-quiet';
  action.textContent = '生成恢复预览';
  controls.appendChild(action);
  const result = document.createElement('p');
  result.className = 'recovery-result';
  panel.appendChild(controls);
  panel.appendChild(result);
  discardButtonFor(draft, panel, onRefreshAll);
  action.addEventListener('click', () => recoverDraft(draft, { action, checkbox, inputs, result }, onRefreshAll));
  content.appendChild(panel);
}
export async function recoverDraft(draft, controls, onRefreshAll) {
  const id = draft.draft_id;
  controls.action.disabled = true;
  try {
    let plan = state.catalogRecovery.get(id);
    if (!plan) {
      const generatorOptions = {};
      for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
      const requestPlan = expectedRevision => request(`catalog/drafts/${encodeURIComponent(id)}/recovery-plan`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision: expectedRevision, generator_options: generatorOptions }),
      });
      try {
        plan = await requestPlan(state.revisions.catalog);
      } catch (error) {
        const code = error instanceof ApiError ? error.code || error.payload?.code || error.payload?.error : null;
        if (error.status !== 409 || code !== 'REVISION_CONFLICT') throw error;
        const latest = await request('catalog/drafts');
        const latestRevision = latest.catalog_revision;
        state.revisions.catalog = latestRevision || state.revisions.catalog;
        const latestDraft = (latest.items || []).find(item => item.draft_id === id);
        if (!latestDraft) {
          if (typeof onRefreshAll === 'function') await onRefreshAll();
          throw new Error('此 Draft 已不存在或已丢弃，列表已刷新。');
        }
        if (!latestRevision || latestDraft.base_revision !== latestRevision) {
          if (typeof onRefreshAll === 'function') await onRefreshAll();
          throw new Error('此 Draft 基于旧 Catalog，已刷新列表；需要重新准备候选。');
        }
        plan = await requestPlan(latestRevision);
      }
      state.catalogRecovery.set(id, plan);
      controls.checkbox.disabled = false;
      controls.action.textContent = '确认成本并恢复';
      const limits = plan.cost_plan?.hard_limits || {};
      controls.result.textContent = `恢复模式：${plan.recovery_mode}；搜索 ${limits.search_queries || 0} 次、抓取正文 ${limits.pages || 0} 页、responses ${limits.responses_calls || 0} 次、synthesis ${limits.synthesis_calls || 0} 次。`;
      return;
    }
    if (!controls.checkbox.checked) {
      controls.result.textContent = '请先勾选本 Draft 的增量成本确认。';
      return;
    }
    const generatorOptions = {};
    for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
    const response = await request(`catalog/drafts/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ expected_revision: plan.expected_revision, generator_options: generatorOptions, recovery_token: plan.recovery_token, confirm_cost: true }) });
    if (!response?.ok) throw new Error(response?.code || 'Draft 恢复被阻断');
    state.catalogRecovery.delete(id);
    showNotice(`${draft.candidate_name || 'Draft'} 已恢复，正在重新加载列表。`, 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      state.catalogRecovery.delete(id);
      controls.checkbox.checked = false;
      controls.checkbox.disabled = true;
      controls.action.textContent = '重新生成恢复预览';
      const code = error.code || error.payload?.code || error.payload?.error;
      let msg = '恢复已被阻断，请重新生成恢复预览。';
      if (code === 'RECOVERY_TOKEN_CHANGED') {
        msg = '恢复参数或凭据已变化，已重置，请重新生成恢复预览。';
      } else if (code === 'REVISION_CONFLICT') {
        msg = 'Catalog 再次发生变化，恢复计划未创建；请刷新后重试。';
      } else if (code === 'DRAFT_RECOVERY_IN_PROGRESS') {
        msg = '当前 Draft 正在恢复中，请勿重复操作。';
      }
      controls.result.textContent = msg;
      showNotice(msg, 'conflict');
    } else {
      const code = error.code || error.payload?.code || error.payload?.error;
      if (code === 'DRAFT_RECOVERY_FORBIDDEN') {
        controls.result.textContent = '该 Draft 当前状态不支持恢复，请点击顶部“刷新数据”后重试。';
        showNotice(controls.result.textContent, 'conflict');
        return;
      }
      controls.result.textContent = error.message || '恢复失败。';
      showNotice(controls.result.textContent, 'error');
    }
  } finally {
    controls.action.disabled = false;
  }
}
export async function cleanupCatalogDraft(draft, button, onRefreshAll) {
  const action = draft.cleanup_action;
  if (!action) {
    showNotice('该 Draft 缺少可验证的 cleanup-only 参数，请刷新工作台。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('catalog/cleanup', {
      method: 'POST',
      body: JSON.stringify(action),
    });
    if (!result?.ok) throw new Error(result?.code || 'Draft 清理被阻断');
    showNotice('Draft cleanup-only 清理完成。', 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || 'Draft 清理失败。', 'error');
  } finally {
    button.disabled = false;
  }
}
export function renderCatalogDrafts(payload, onRefreshAll) {
  state.catalogDrafts = listFrom(payload, ['items', 'drafts']);
  if (payload?.catalog_revision) state.revisions.catalog = payload.catalog_revision;
  state.catalogRecovery.clear();
  const root = $('#catalogDraftList');
  if (!root) return;
  clearChildren(root);
  if (!state.catalogDrafts.length) addText(root, 'p', '当前没有待审核 Draft。', 'empty-state');
  for (const draft of state.catalogDrafts) {
    const row = document.createElement('article');
    row.className = 'queue-item';
    const content = document.createElement('div');
    content.className = 'item-content';
    addText(content, 'h3', draft.candidate_name || '工具 / 模型 Draft', 'item-title');
    addText(content, 'p', `状态：${draft.state || draft.readiness || 'unknown'}`, 'item-summary');
    if (draft.reused) addBadge(content, '已复用', 'reused');
    if (draft.cleanup_pending || draft.state === 'cleanup_pending') {
      addText(content, 'p', '正式 Catalog 已提交，仅待完成 Draft 清理。', 'item-blocked');
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';
      const cleanup = document.createElement('button');
      cleanup.type = 'button';
      cleanup.className = 'button button-quiet';
      cleanup.textContent = '执行 cleanup-only 清理';
      toolbar.appendChild(cleanup);
      content.appendChild(toolbar);
      cleanup.addEventListener('click', () => cleanupCatalogDraft(draft, cleanup, onRefreshAll));
    } else {
      recoveryControlsFor(draft, content, onRefreshAll);
    }
    row.appendChild(document.createElement('span'));
    row.appendChild(content);
    root.appendChild(row);
  }
}
function renderBatchBlockers(root, blockers = []) {
  for (const blocker of blockers) {
    const label = blocker.candidate_name || blocker.candidate_key || blocker.draft_id || 'Draft';
    const reasons = Array.isArray(blocker.blocking_reasons) && blocker.blocking_reasons.length ? blocker.blocking_reasons.join('；') : blocker.error_code || blocker.code || '当前不可 Apply';
    addText(root, 'p', `阻断：${label}（${reasons}）`, 'item-blocked');
  }
}
export function renderCatalogBatchPreview(payload) {
  const root = $('#catalogBatchPreview');
  if (!root) return;
  clearChildren(root);
  state.catalogBatch = payload?.ok ? payload : null;
  if (!payload?.ok) {
    addText(root, 'p', payload?.code === 'DRAFTS_NOT_READY' ? '暂无可 Apply 的 Draft。' : '批次预览已阻断，请刷新数据后重试。', 'muted');
    renderBatchBlockers(root, payload.blockers);
    const applyBtn = $('#catalogApplyButton');
    if (applyBtn) applyBtn.disabled = true;
    return;
  }
  addText(root, 'p', `本批 ${Number(payload.draft_count || 0)} 个 Draft，将在一次事务中更新正式知识库。`, 'item-summary');
  addText(root, 'p', `Catalog revision：${payload.expected_revision}`, 'item-id');
  const changes = payload.change_preview || {};
  const creates = Object.values(changes.creates || {}).flat();
  const updates = Array.isArray(changes.updates) ? changes.updates : [];
  const noops = Array.isArray(changes.noops) ? changes.noops : [];
  addText(root, 'p', `新增 ${creates.length}，更新 ${updates.length}，无变化 ${noops.length}`, 'item-summary');
  for (const draft of payload.drafts || []) {
    const change = draft.change_preview || {};
    addText(root, 'p', `${draft.candidate_key || draft.draft_id}：新增 ${Object.values(change.creates || {}).flat().length}，更新 ${(change.updates || []).length}`, 'item-summary');
  }
  renderBatchBlockers(root, payload.blockers);
  const applyBtn = $('#catalogApplyButton');
  if (applyBtn) applyBtn.disabled = false;
}
export async function previewCatalogBatch(button) {
  button.disabled = true;
  try {
    const result = await request('catalog/batch-preview');
    renderCatalogBatchPreview(result);
    showNotice(result?.ok ? 'Catalog 批次预览已就绪，可核对后一键 Apply。' : (result?.code || '批次预览被阻断。'), result?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || 'Catalog 批次预览失败。', 'error');
  } finally {
    button.disabled = false;
  }
}
export async function applyCatalog(button, onRefreshAll) {
  const batch = state.catalogBatch;
  if (!batch?.ok || !batch.draft_ids?.length) {
    showNotice('请先生成并确认批次预览。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('catalog/apply-batch', {
      method: 'POST',
      body: JSON.stringify({
        draft_ids: batch.draft_ids,
        expected_revision: batch.expected_revision,
        batch_token: batch.batch_token,
        confirm: `APPLY CATALOG DRAFTS ${batch.batch_token}`,
      }),
    });
    if (!result?.ok) throw new Error(result?.code || 'Catalog Apply 被拒绝');
    state.catalogBatch = null;
    clearChildren($('#catalogBatchPreview'));
    addText($('#catalogBatchPreview'), 'p', '准备 Draft 后，可预览整批变更。', 'muted');
    showNotice(`批量写入完成：成功 ${Number(result.applied || 0)} 个 Draft。公开站点仍需显式重建 dist。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || '批量 Catalog Apply 失败。', 'error');
  } finally {
    button.disabled = false;
  }
}
export function setupCatalogPanel(onRefreshAll) {
  const bundlePlanBtn = $('#catalogBundlePlanButton');
  if (bundlePlanBtn) bundlePlanBtn.addEventListener('click', (event) => planBundle(event.currentTarget));
  const bundlePrepareBtn = $('#catalogBundlePrepareButton');
  if (bundlePrepareBtn) bundlePrepareBtn.addEventListener('click', (event) => prepareBundle(event.currentTarget, onRefreshAll));
  const bundleCostConfirm = $('#catalogBundleCostConfirm');
  if (bundleCostConfirm) bundleCostConfirm.addEventListener('change', () => {
    const prepare = $('#catalogBundlePrepareButton');
    if (prepare) prepare.disabled = !state.catalogBundlePlan?.ok || !bundleCostConfirm.checked;
  });
  const planBtn = $('#catalogPlanButton');
  if (planBtn) planBtn.addEventListener('click', (event) => planCatalog(event.currentTarget));
  const prepBtn = $('#catalogPrepareButton');
  if (prepBtn) prepBtn.addEventListener('click', (event) => prepareCatalog(event.currentTarget, onRefreshAll));
  const prevBtn = $('#catalogBatchPreviewButton');
  if (prevBtn) prevBtn.addEventListener('click', (event) => previewCatalogBatch(event.currentTarget));
  const applyBtn = $('#catalogApplyButton');
  if (applyBtn) applyBtn.addEventListener('click', (event) => applyCatalog(event.currentTarget, onRefreshAll));
  const costConfirm = $('#catalogCostConfirm');
  if (costConfirm) {
    costConfirm.addEventListener('change', () => {
      const pBtn = $('#catalogPrepareButton');
      if (state.catalogPlan && pBtn) pBtn.disabled = !state.catalogPlan.ok || !costConfirm.checked;
    });
  }
}
