import { request, listFrom } from '../api.js';
import { state, $, addText, clearChildren, showNotice } from '../state.js';

function bundleTitle(bundle) {
  return bundle?.series?.title || bundle?.candidate?.name || bundle?.bundle_id || 'SeriesBundle';
}

function bundleMembers(bundle) {
  return Array.isArray(bundle?.members) ? bundle.members : [];
}

function memberDiagnosis(member) {
  const error = member.enrichment_error;
  const status = member.enrichment_status;
  if (!error && !['failed', 'pending', 'running'].includes(status)) return null;
  const parts = [error?.code || (status === 'running' ? 'ENRICHMENT_RUNNING' : 'ENRICHMENT_PENDING')];
  const fields = member.missing_fields || error?.missing_fields || [];
  if (fields.length) parts.push(`缺字段：${fields.join('、')}`);
  const synthesis = (error?.synthesis_errors || []).map(item => item.code).filter(Boolean);
  if (synthesis.length) parts.push(`合成：${[...new Set(synthesis)].join('、')}`);
  const sourceCount = Number(member.official_source_count || error?.official_source_count || 0);
  if (sourceCount) parts.push(`记录过 ${sourceCount} 条来源；${member.has_reusable_research ? '研究正文可复用' : '研究正文未保存，重试需重新研究'}`);
  return `${member.name || member.model_key || '系列成员'}：${parts.join('；')}`;
}

function renderMemberDiagnostics(root, members) {
  for (const member of members || []) {
    const message = memberDiagnosis(member);
    if (message) addText(root, 'p', message, 'item-blocked');
  }
}

function limitsText(limits = {}) {
  return `搜索 ${Number(limits.search_queries || 0)}，正文页 ${Number(limits.pages || 0)}，responses ${Number(limits.responses_calls || 0)}，合成 ${Number(limits.synthesis_calls || 0)}`;
}

function preparationCountsText(result) {
  const counts = result.counts || {};
  const drafts = result.drafts || [];
  const ready = Number(counts.ready ?? drafts.filter(draft => draft.readiness?.status === 'ready').length);
  const blockedDrafts = Number(counts.blocked_drafts ?? drafts.filter(draft => draft.state === 'preview_blocked' || draft.readiness?.status !== 'ready').length);
  const blocked = Number(counts.blocked ?? blockedDrafts);
  const candidates = Number(counts.blocked_candidates ?? Math.max(0, blocked - blockedDrafts));
  return `准备结果：ready ${ready} 个；已保存 blocked Draft ${blockedDrafts} 个；未生成 Draft 的阻断候选 ${candidates} 个。`;
}

function invalidateBundlePlan() {
  state.catalogBundlePlan = null;
  state.catalogBundleEnrichmentToken = null;
  renderBundlePlan({ ok: false, code: '准备结果已更新，请重新生成 Bundle 计划。' });
  const prepare = $('#catalogBundlePrepareButton');
  if (prepare) prepare.disabled = true;
}

function warningsText(result) {
  const warnings = result.warnings || [];
  if (!warnings.length) return '';
  const details = warnings.map(item => {
    const name = item.name || item.candidate_key || '候选';
    const rawCode = String(item.code || 'BUNDLE_OUTCOME_SYNC_FAILED');
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(rawCode) ? rawCode : 'BUNDLE_OUTCOME_SYNC_FAILED';
    return `${name} · ${code}`;
  });
  return `状态同步警告：${details.join('；')}。`;
}

function renderUnmaterializedBlockers(result) {
  const root = $('#catalogBundlePlanPreview');
  if (!root) return;
  for (const item of result.blocked || []) {
    if (item.draft_id) continue;
    const name = item.candidate_name || item.name || item.candidate_key || '系列候选';
    const rawCode = String(item.code || 'BUNDLE_CANDIDATE_BLOCKED');
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(rawCode) ? rawCode : 'BUNDLE_CANDIDATE_BLOCKED';
    addText(root, 'p', `未生成 Draft：${name} · ${code}`, 'item-blocked');
  }
}

async function reportBlockedBundleResult(result, onRefreshAll) {
  invalidateBundlePlan();
  showNotice(`${preparationCountsText(result)}${warningsText(result)}下方列出逐成员和候选原因。`, 'warning');
  renderUnmaterializedBlockers(result);
  if (typeof onRefreshAll === 'function') await onRefreshAll();
}

function renderBundleReviewBlocked(draft, row, review) {
  const content = row.querySelector('.item-content');
  if (!content) return;
  const old = content.querySelector('.bundle-review');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.className = 'bundle-review';
  addText(panel, 'p', `审核预览被阻断：${review?.code || 'BUNDLE_BLOCKED'}`, 'item-blocked');
  for (const blocker of review?.blockers || []) addText(panel, 'p', String(blocker), 'item-blocked');
  const projected = review?.draft || draft;
  renderMemberDiagnostics(panel, projected.members || []);
  content.appendChild(panel);
}

function renderBundleReview(draft, row, review, onRefreshAll) {
  const content = row.querySelector('.item-content');
  if (!content) return;
  const old = content.querySelector('.bundle-review');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.className = 'bundle-review';
  addText(panel, 'p', `预览已锁定：Catalog revision ${review.current_revision}`, 'item-id');
  addText(panel, 'p', `${bundleMembers(review.draft).length} 个成员；请核对后再确认写入。`, 'item-summary');
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'button button-danger';
  apply.textContent = 'Apply Bundle';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'button button-quiet';
  discard.textContent = '丢弃 Bundle';
  toolbar.append(apply, discard);
  panel.appendChild(toolbar);
  content.appendChild(panel);
  apply.addEventListener('click', () => applyBundle(review, apply, onRefreshAll));
  discard.addEventListener('click', () => discardBundle(review, discard, onRefreshAll));
}

async function reviewBundle(draft, row, onRefreshAll) {
  const id = draft.draft_id;
  const action = row.querySelector('[data-bundle-review]');
  if (action) action.disabled = true;
  try {
    const review = await request(`catalog/bundles/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({}) });
    if (!review?.ok) {
      renderBundleReviewBlocked(draft, row, review);
      showNotice(`Bundle 预览被阻断：${review?.code || 'BUNDLE_BLOCKED'}`, 'error');
      return;
    }
    state.catalogBundleReviews.set(id, review);
    renderBundleReview(draft, row, review, onRefreshAll);
  } catch (error) {
    renderBundleReviewBlocked(draft, row, error?.payload || { code: error?.code || 'BUNDLE_REVIEW_FAILED', draft });
    showNotice(error.message || 'Bundle 审核失败。', 'error');
  } finally {
    if (action) action.disabled = false;
  }
}

async function applyBundle(review, button, onRefreshAll) {
  button.disabled = true;
  try {
    const result = await request('catalog/apply-bundle', {
      method: 'POST',
      body: JSON.stringify({ draft_id: review.draft_id, expected_revision: review.current_revision, bundle_token: review.bundle_token, confirm: review.confirmation }),
    });
    if (!result?.ok) throw new Error(result?.code || 'Bundle Apply 被拒绝');
    state.catalogBundleOutcome = result;
    const suffix = result.cleanup_only ? 'cleanup-only 恢复待处理' : result.cleanup_pending ? 'Draft 清理待处理' : result.outcome_pending ? 'pending outcome warning' : '';
    showNotice(`Bundle 已应用，目标 revision：${result.target_revision || '未返回'}。${suffix ? `（${suffix}）` : ''}`, result.outcome_pending || result.cleanup_pending ? 'conflict' : 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || 'Bundle Apply 失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

async function discardBundle(review, button, onRefreshAll) {
  button.disabled = true;
  try {
    const result = await request(`catalog/bundles/${encodeURIComponent(review.draft_id)}/discard`, {
      method: 'POST', body: JSON.stringify({ expected_revision: review.current_revision, confirm: review.discard_confirmation }),
    });
    if (!result?.ok) throw new Error(result?.code || 'Bundle 丢弃被拒绝');
    showNotice('Bundle 已丢弃。', 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || 'Bundle 丢弃失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

function renderBundlePlan(payload) {
  const root = $('#catalogBundlePlanPreview');
  if (!root) return;
  clearChildren(root);
  if (!payload?.ok) {
    addText(root, 'p', payload?.code || 'Bundle 计划被阻断。', 'item-blocked');
    return;
  }
  const retry = payload.retry_summary;
  if (retry) {
    if (retry.projection_repair) {
      addText(root, 'p', `原位恢复 Draft ${retry.draft_ids.length} 个：成员富化结果已完成，只需重建 Bundle 投影。`, 'item-summary');
      addText(root, 'p', '本次不会重新搜索、抓取或合成。', 'item-summary');
      return;
    }
    const reusable = retry.failed_members.filter(member => member.has_research).length;
    addText(root, 'p', `原位恢复 Draft ${retry.draft_ids.length} 个：失败成员 ${retry.failed_members.length} 个，可复用研究 ${reusable} 个。`, 'item-summary');
    for (const member of retry.failed_members) {
      const parts = [member.error?.code || member.status || 'ENRICHMENT_FAILED'];
      if (member.missing_fields?.length) parts.push(`缺字段：${member.missing_fields.join('、')}`);
      if (member.official_source_count) parts.push(`来源 ${member.official_source_count} 条，${member.has_research ? '可复用正文' : '需重新研究'}`);
      addText(root, 'p', `${member.name}：${parts.join('；')}`, 'item-blocked');
    }
    const deferred = payload.deferred_candidates || [];
    if (deferred.length) addText(root, 'p', `新候选暂缓：${deferred.map(item => item.name).join('、')}`, 'item-id');
    if (retry.requires_confirmation) addText(root, 'p', `需新增确认额度：${limitsText(retry.incremental_limits)}。`, 'item-summary');
    else addText(root, 'p', '将使用这些成员原先已确认的剩余额度。', 'item-summary');
    return;
  }
  const resolution = payload.cost_plan || payload.resolution || {};
  addText(root, 'p', `身份核验：搜索上限 ${Number(resolution.verification_search_upper_bound || 0)}（备用 ${Number(resolution.verification_search_fallback_upper_bound || 0)}），正文提取备用 ${Number(resolution.verification_extract_upper_bound || 0)}，responses 上限 ${Number(resolution.verification_responses_upper_bound || 0)}。`, 'item-summary');
  addText(root, 'p', payload.enrichment_cost?.message || '成员富化成本将在 prepare 阶段按成员上限计入。', 'item-summary');
  addText(root, 'p', `本次 ${Number(payload.candidates?.length || 0)} 个系列候选需要确认身份核验与成员富化成本。`, 'item-id');
}

export async function planBundle(button) {
  button.disabled = true;
  try {
    const plan = await request('catalog/bundle-plan');
    state.catalogBundlePlan = plan;
    state.catalogBundleEnrichmentToken = null;
    if (plan?.catalog_revision) state.revisions.catalog = plan.catalog_revision;
    renderBundlePlan(plan);
    const prepare = $('#catalogBundlePrepareButton');
    const projectionRepair = plan?.retry_summary?.projection_repair;
    if (prepare) prepare.disabled = !plan?.ok || (!projectionRepair && !$('#catalogBundleCostConfirm')?.checked);
    const message = projectionRepair
      ? 'Bundle 投影修复计划已生成：复用已完成的成员资料，不产生新增研究成本。'
      : plan?.retry_summary
      ? `恢复计划已生成：失败成员 ${plan.retry_summary.failed_members.length} 个；${plan.retry_summary.requires_confirmation ? '需要确认额外额度。' : '沿用已确认额度。'}`
      : 'Bundle 计划已生成，请确认身份核验与成员富化成本。';
    showNotice(plan?.ok ? message : (plan?.code || '当前没有可进入 Bundle 的系列候选。'), plan?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || 'Bundle 计划失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function prepareBundle(button, onRefreshAll) {
  const plan = state.catalogBundlePlan;
  if (!plan?.ok || (!plan.retry_summary?.projection_repair && !$('#catalogBundleCostConfirm')?.checked)) {
    showNotice('请先生成 Bundle 计划并确认显示的成本上限。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const payload = { pending_revision: plan.pending_revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, confirm_cost: true };
    if (state.catalogBundleEnrichmentToken) payload.enrichment_confirmation_token = state.catalogBundleEnrichmentToken;
    const result = await request('catalog/bundle-prepare', { method: 'POST', body: JSON.stringify(payload) });
    if (result?.code === 'ENRICHMENT_COST_CONFIRMATION_REQUIRED' || result?.status === 'enrichment_cost_confirmation_required') {
      state.catalogBundleEnrichmentToken = result.enrichment_confirmation_token;
      const limits = result.retry_incremental_limits || result.enrichment_hard_limits || {};
      showNotice(`请再次确认富化额度：${limitsText(limits)}。`, 'warning');
      return;
    }
    if (result?.status === 'bundles_blocked' || (!result?.ok && result?.counts?.blocked)) {
      await reportBlockedBundleResult(result, onRefreshAll);
      return;
    }
    if (!result?.ok) throw new Error(result?.code || 'Bundle Draft 准备失败。');
    invalidateBundlePlan();
    if (result.status === 'bundles_mixed') {
      showNotice(`${preparationCountsText(result)}${warningsText(result)}下方列出阻断原因。`, 'warning');
      renderUnmaterializedBlockers(result);
    } else if (result.warnings?.length) {
      showNotice(`Bundle Draft 已准备：ready ${Number(result.counts?.ready || result.drafts?.length || 0)} 个。${warningsText(result)}`, 'warning');
    } else showNotice(`Bundle Draft 已准备：ready ${Number(result.counts?.ready || result.drafts?.length || 0)} 个。`, 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    const payload = error?.payload;
    if (payload?.status === 'bundles_blocked') {
      await reportBlockedBundleResult(payload, onRefreshAll);
      return;
    }
    if (error?.code === 'ENRICHMENT_COST_CONFIRMATION_REQUIRED' || payload?.code === 'ENRICHMENT_COST_CONFIRMATION_REQUIRED') {
      state.catalogBundleEnrichmentToken = payload?.enrichment_confirmation_token || error?.enrichment_confirmation_token;
      const limits = payload?.retry_incremental_limits || payload?.enrichment_hard_limits || {};
      showNotice(`请再次确认富化额度：${limitsText(limits)}。`, 'warning');
      return;
    }
    showNotice(error.message || 'Bundle Draft 准备失败。', 'error');
  } finally {
    button.disabled = !state.catalogBundlePlan?.ok || (!state.catalogBundlePlan.retry_summary?.projection_repair && !$('#catalogBundleCostConfirm')?.checked);
  }
}

export function renderCatalogBundles(payload, onRefreshAll) {
  state.catalogBundles = listFrom(payload, ['items', 'bundles']);
  state.catalogBundleReviews.clear();
  if (payload?.catalog_revision) state.revisions.catalog = payload.catalog_revision;
  const root = $('#catalogBundleList');
  const stateNode = $('#catalogBundleState');
  if (stateNode) stateNode.textContent = `${state.catalogBundles.length} 条`;
  if (!root) return;
  clearChildren(root);
  const outcome = state.catalogBundleOutcome;
  if (outcome && (outcome.outcome_pending || outcome.cleanup_pending || outcome.cleanup_only)) {
    addText(root, 'p', `上次 Apply 状态：${outcome.cleanup_only ? 'cleanup-only 恢复待处理' : outcome.cleanup_pending ? 'Draft 清理待处理' : 'pending outcome warning'}。请保留此状态并刷新确认。`, 'item-blocked');
  }
  for (const error of payload?.selection_errors || []) {
    addText(root, 'p', `Draft 选择被阻断：${error.candidate_key || error.draft_id || '候选'} · ${error.code || 'BUNDLE_DRAFT_DUPLICATE'}。请先解决重复版本冲突。`, 'item-blocked');
  }
  if (!state.catalogBundles.length) {
    addText(root, 'p', payload?.selection_errors?.length ? '存在无法安全选择的 Bundle，当前不提供审核或 Apply 操作。' : '当前没有待审核 SeriesBundle。', 'empty-state');
    return;
  }
  for (const bundle of state.catalogBundles) renderBundleCard(root, bundle, payload, onRefreshAll);
}

function renderBundleCard(root, bundle, payload, onRefreshAll) {
  const row = document.createElement('article');
  row.className = 'queue-item';
  const content = document.createElement('div');
  content.className = 'item-content';
  addText(content, 'h3', bundleTitle(bundle), 'item-title');
  addText(content, 'p', `状态：${bundle.state || bundle.readiness?.status || 'unknown'}；成员 ${bundleMembers(bundle).length}`, 'item-summary');
  renderMemberDiagnostics(content, bundleMembers(bundle));
  if (Array.isArray(bundle.deferred_models) && bundle.deferred_models.length) addText(content, 'p', `延后成员：${bundle.deferred_models.length}`, 'item-blocked');
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  if (bundle.state === 'cleanup_pending' || bundle.state === 'outcome_pending') {
    addText(content, 'p', '正式 Catalog 已写入，仅待完成清理。', 'item-blocked');
    const cleanup = document.createElement('button');
    cleanup.type = 'button'; cleanup.className = 'button button-quiet'; cleanup.textContent = '执行 Bundle cleanup-only 清理';
    toolbar.appendChild(cleanup);
    cleanup.addEventListener('click', () => applyBundle({ draft_id: bundle.draft_id, current_revision: state.revisions.catalog || payload.catalog_revision, bundle_token: bundle.bundle_token, confirmation: `APPLY CATALOG BUNDLE ${bundle.bundle_token}` }, cleanup, onRefreshAll));
  } else if (bundle.state === 'enriching') {
    addText(content, 'p', '成员富化正在运行；请刷新查看已保存进度。', 'item-summary');
  } else {
    const review = document.createElement('button');
    review.type = 'button'; review.className = 'button button-quiet'; review.dataset.bundleReview = 'true'; review.textContent = '审核预览';
    const discard = document.createElement('button');
    discard.type = 'button'; discard.className = 'button button-quiet'; discard.textContent = '丢弃 Bundle';
    toolbar.append(review, discard);
    review.addEventListener('click', () => reviewBundle(bundle, row, onRefreshAll));
    discard.addEventListener('click', () => discardBundle({ draft_id: bundle.draft_id, current_revision: state.revisions.catalog || payload.catalog_revision, bundle_token: bundle.bundle_token, discard_confirmation: bundle.discard_confirmation || `DISCARD CATALOG BUNDLE ${bundle.bundle_token}` }, discard, onRefreshAll));
  }
  if (toolbar.childElementCount) content.appendChild(toolbar);
  row.append(document.createElement('span'), content);
  root.appendChild(row);
}

export { renderBundlePlan };
