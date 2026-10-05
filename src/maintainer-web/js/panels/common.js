import { request, writeRequest, revisionFrom, ApiError } from '../api.js';
import {
  state,
  $,
  text,
  first,
  itemId,
  zhLocalized,
  VERDICT_ZH,
  addText,
  addBadge,
  clearChildren,
  setLoadState,
  showNotice,
  updateRevisionNote,
  uiHelpers,
} from '../state.js';

export function itemTitle(item, extraKeys = []) {
  const zhTitle = zhLocalized(item, 'title') || zhLocalized(item, 'summary') || zhLocalized(item, 'full_name') || zhLocalized(item, 'term');
  if (zhTitle) return zhTitle;
  return first(item, ['title', 'product_name', 'name', 'term', 'label', ...extraKeys], '未命名条目');
}

export function itemMeta(item) {
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const isKeyword = Boolean(item && typeof item.word === 'string');
  const rawStatus = isKeyword ? '待采纳' : first(item, ['status', 'review_status', 'state'], 'pending');
  const blocked = item && (item.blocked === true || item.is_blocked === true);
  const tone = blocked || String(rawStatus).toLowerCase() === 'blocked' ? 'blocked' : String(rawStatus).toLowerCase();
  const displayStatus = tone === 'blocked' ? 'blocked' : rawStatus;
  addBadge(meta, displayStatus, tone);
  const source = first(item, ['source', 'product_name', 'platform', 'vendor', 'category'], '');
  if (source) addText(meta, 'span', isKeyword ? `${source}类关键词` : source);
  const date = first(item, ['published_at', 'created_at', 'date', 'updated_at'], '');
  if (date) addText(meta, 'span', date);
  const id = itemId(item);
  if (id && !isKeyword) addText(meta, 'span', `ID ${id}`, 'item-id');
  return { meta, status: tone, id };
}

export function addAiAdvice(content, advice, label = 'AI 建议', item = null, options = {}) {
  if (!advice || typeof advice !== 'object') advice = {};
  const verdict = first(advice, ['verdict', 'decision'], '');
  const reasons = Array.isArray(advice.reasons) ? advice.reasons : (advice.reason ? [advice.reason] : []);
  if (!verdict && !reasons.length && options.showWithoutAdvice !== true) return;
  const box = document.createElement('div');
  box.className = 'ai-advice';
  const head = document.createElement('div');
  head.className = 'ai-advice-head';
  addText(head, 'span', verdict ? `${label} · ${VERDICT_ZH[verdict] || verdict}` : label);
  const confidenceDisplayValue = uiHelpers.confidenceDisplay(advice.confidence, advice.confidence_range, {
    tool: options.tool === true,
    verdict,
  });
  const confidenceLabel = document.createElement('span');
  confidenceLabel.className = 'ai-confidence';
  if (confidenceDisplayValue.prefix) addText(confidenceLabel, 'span', confidenceDisplayValue.prefix);
  const confidenceValue = addText(confidenceLabel, 'span', confidenceDisplayValue.value, 'ai-confidence-value');
  confidenceValue.dataset.tone = confidenceDisplayValue.tone;
  if (confidenceDisplayValue.suffix) addText(confidenceLabel, 'span', confidenceDisplayValue.suffix);
  head.appendChild(confidenceLabel);
  box.appendChild(head);
  if (item) {
    const materials = uiHelpers.reviewMaterials(item);
    const present = materials.present.length ? `已有${materials.present.join('、')}` : '没有可用材料';
    const truncation = materials.descriptionTruncated ? '；描述已截断' : '';
    addText(box, 'p', `审核材料：${present}${truncation}`, 'ai-advice-materials');
  }
  addReviewAssessment(box, advice.assessment, label);
  addAssessmentGatePreview(box, advice.assessment_gate_preview, 'L2 建议');
  for (const reason of reasons.slice(0, 3)) addText(box, 'p', reason, 'ai-advice-reason');
  const verification = advice.web_verification;
  if (verification && typeof verification === 'object') {
    const status = verification.status === 'awaiting_agent' ? '待 Codex 查证'
      : verification.status === 'completed' ? '已完成事实查证'
        : verification.status === 'failed' ? '查证未完成' : '';
    if (status) addText(box, 'p', status, 'ai-advice-materials');
    if (verification.claim) addText(box, 'p', `待核实事实：${verification.claim}`, 'ai-advice-reason');
    if (verification.conclusion) {
      const labels = { supports: '来源支持', contradicts: '来源反驳', inconclusive: '来源不足以判断' };
      addText(box, 'p', `查证结论：${labels[verification.conclusion] || verification.conclusion}${verification.summary ? `；${verification.summary}` : ''}`, 'ai-advice-reason');
    }
    for (const source of (Array.isArray(verification.sources) ? verification.sources : []).slice(0, 5)) {
      let parsed;
      try { parsed = new URL(source.url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const link = document.createElement('a');
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = String(source.title || parsed.hostname).slice(0, 200);
      box.appendChild(link);
      if (source.excerpt) addText(box, 'p', String(source.excerpt).slice(0, 500), 'ai-advice-materials');
    }
  }
  content.appendChild(box);
}

function addReviewAssessment(container, assessment, label) {
  if (!assessment || typeof assessment !== 'object') return;
  const values = [
    ['topic_relevance', { in_scope: '相关', out_of_scope: '不相关', uncertain: '相关性不确定' }],
    ['subject_clarity', { specific: '主题具体', broad: '主题宽泛', ambiguous: '主题有歧义' }],
    ['information_value', { substantive: '有实质信息', low: '信息价值低', uncertain: '信息价值不确定' }],
    ['source_quality', { primary: '一手来源', credible_secondary: '可信二手来源', unknown: '来源不明', not_applicable: '无需依赖来源' }],
    ['evidence_status', { sufficient: '现有证据足够', needs_content: '缺少内容', needs_source: '缺少来源', needs_fact_check: '需查证事实', inconclusive: '证据无法定论' }],
  ];
  const summary = values.map(([field, labels]) => labels[assessment[field]]).filter(Boolean);
  if (summary.length) addText(container, 'p', `${label}判断维度：${summary.join('；')}`, 'ai-advice-materials');
}

function addAssessmentGatePreview(container, preview, phase = 'L1 初审') {
  const labels = {
    approve_candidate: '符合自动通过条件',
    discard_candidate: '符合自动丢弃条件',
    manual: '保留人工审核',
  };
  const label = labels[preview?.action];
  if (label) {
    const prefix = phase === 'L1 初审' ? 'L1 正式分流判断' : `${phase}（不改审核状态）`;
    addText(container, 'p', `${prefix}：${label}`, 'ai-advice-materials');
  }
}

export function queueItem(item, resource, options = {}, onAction = null) {
  const isTool = Boolean(item && item.candidate_key !== undefined);
  const isKeyword = Boolean(item && typeof item.word === 'string');
  const id = itemId(item);
  const titleValue = itemTitle(item, options.titleKeys || []);
  const article = document.createElement('article');
  article.className = 'queue-item';
  const metaInfo = itemMeta(item);
  if (metaInfo.status === 'blocked') article.classList.add('is-blocked');

  const content = document.createElement('div');
  content.className = 'item-content';
  const title = addText(content, 'h3', titleValue, 'item-title');
  title.title = text(titleValue);
  content.appendChild(metaInfo.meta);
  if (isTool) {
    const dates = document.createElement('div');
    dates.className = 'item-dates';
    addText(dates, 'span', `原 ${text(item.previous_date) || '—'} → 拟 ${text(item.proposed_date) || '待定'}`);
    content.appendChild(dates);
    if (Array.isArray(item.blocked_reasons) && item.blocked_reasons.length) {
      uiHelpers.addBlockedReasons(content, item.blocked_reasons);
    }
  }
  const summary = zhLocalized(item, 'description') || first(item, ['summary', 'description', 'excerpt', 'rationale', 'reason'], '');
  if (summary) addText(content, 'p', summary, 'item-summary');
  if (isKeyword) {
    addText(content, 'p', `提及 ${item.count == null ? 0 : item.count} 次`, 'item-summary');
  }
  const hasZhDescription = Boolean(zhLocalized(item, 'description'));
  if (isTool && !hasZhDescription) {
    addText(content, 'p', '当前内容尚未汉化，请先运行工具审核本地化。', 'item-localization-pending');
  }
  uiHelpers.addSourceLink(content, first(item, ['url', 'source_url', 'official_url'], ''));
  const toolAdvice = isTool ? (item.ai_suggestion || item.review_decision || null) : null;
  const advice = isTool && hasZhDescription && toolAdvice
    ? { ...toolAdvice, reasons: [], reason: '' }
    : (isTool ? toolAdvice : item.ai_advice);
  const adviceLabel = isTool
    ? (item.ai_suggestion ? '审核建议（AI 复核）' : item.review_decision ? '审核建议（规则判定）' : '审核建议')
    : 'AI 建议';
  addAiAdvice(content, advice, adviceLabel, isTool ? null : item, { tool: isTool, showWithoutAdvice: isTool && !toolAdvice });
  if (!isTool) {
    addReviewAssessment(content, item.l1_review?.assessment, 'L1 初审');
    addAssessmentGatePreview(content, item.l1_review?.assessment_gate_preview, 'L1 初审');
    if (item.l1_review?.fact_check?.needed && item.l1_review.fact_check.claim) {
      addText(content, 'p', `L1 待核实事实：${item.l1_review.fact_check.claim}`, 'ai-advice-reason');
    }
  }
  if (isTool && !toolAdvice) {
    addText(content, 'p', '审核建议：当前未生成语义建议，请结合官方证据与状态信息判断。', 'ai-advice-materials');
  }

  if (options.selectable && id) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'item-check';
    check.dataset.selectResource = resource;
    check.dataset.itemId = id;
    check.checked = state.selected[resource].has(id);
    check.setAttribute('aria-label', `选择 ${text(titleValue)}`);
    article.insertBefore(check, article.firstChild);
  } else {
    const spacer = document.createElement('span');
    spacer.setAttribute('aria-hidden', 'true');
    article.insertBefore(spacer, article.firstChild);
  }

  if (options.actions && id && typeof onAction === 'function') {
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'button button-danger';
    reject.textContent = options.rejectLabel || '拒绝';
    reject.addEventListener('click', () => onAction(id, 'rejected', reject));
    actions.appendChild(reject);
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'button button-primary';
    approve.textContent = options.approveLabel || '批准';
    approve.disabled = metaInfo.status === 'blocked';
    if (approve.disabled) approve.title = 'blocked 条目不可批准';
    approve.addEventListener('click', () => onAction(id, 'approved', approve));
    actions.appendChild(approve);
    content.appendChild(actions);
  }
  article.appendChild(content);
  return article;
}

export function updateSelectionControls(resource) {
  const ids = { news: 'newsSelectionCount', keywords: 'keywordSelectionCount', top: 'topSelectionCount' };
  const buttons = { news: ['newsDiscardButton', 'newsApproveButton'], keywords: ['keywordDiscardButton', 'keywordAdoptButton'], top: ['topSaveButton'] };
  if (!ids[resource] || !buttons[resource]) return;
  const count = state.selected[resource].size;
  $(`#${ids[resource]}`).textContent = `${count} 条已选`;
  for (const id of buttons[resource]) $(`#${id}`).disabled = count === 0 || state.loading.has(resource);
}

export function renderQueue(resource, rootId, items, stateId, options = {}) {
  state.items[resource] = items;
  const root = $(`#${rootId}`);
  clearChildren(root);
  if (!items.length) {
    addText(root, 'p', options.empty || '当前没有待处理条目。', 'empty-state');
  } else {
    for (const item of items) root.appendChild(queueItem(item, resource, options, options.onAction));
  }
  setLoadState(stateId, `${items.length} 条`, 'success');
  updateSelectionControls(resource);
}

export function bindSelection(resource, listId, selectAllId) {
  const list = $(`#${listId}`);
  if (!list) return;
  list.addEventListener('change', (event) => {
    const target = event.target;
    if (!target.matches('input[data-select-resource]')) return;
    const id = target.dataset.itemId;
    if (target.checked) state.selected[resource].add(id);
    else state.selected[resource].delete(id);
    updateSelectionControls(resource);
  });
  const selectAll = $(`#${selectAllId}`);
  if (selectAll) {
    selectAll.addEventListener('change', (event) => {
      const boxes = list.querySelectorAll('input[data-select-resource]');
      for (const box of boxes) {
        box.checked = event.target.checked;
        if (box.checked) state.selected[resource].add(box.dataset.itemId);
        else state.selected[resource].delete(box.dataset.itemId);
      }
      updateSelectionControls(resource);
    });
  }
}

export function handleMutationError(error, resource, stateId, button) {
  if (button) button.disabled = false;
  state.loading.delete(resource);
  const conflict = error instanceof ApiError && error.status === 409;
  const timeout = error?.code === 'CLIENT_TIMEOUT' || error?.status === 504;
  const message = conflict
    ? '操作被拒绝：数据已被修改，请刷新后重新确认。'
    : (timeout
      ? '结果未确认，请先刷新状态；不要自动重复提交。'
      : (String(error?.message || '').trim() || '操作失败，请检查当前条件后重试。'));
  setLoadState(stateId, conflict ? '数据冲突' : (timeout ? '结果未确认' : '操作失败'), conflict ? 'conflict' : (timeout ? 'warning' : 'error'));
  showNotice(message, conflict ? 'conflict' : (timeout ? 'error' : 'error'));
  updateSelectionControls(resource);
}

export async function loadResource(resource, path, render, config) {
  state.loading.add(resource);
  setLoadState(config.stateId, '加载中…', 'loading');
  if (['news', 'keywords', 'top'].includes(resource)) updateSelectionControls(resource);
  try {
    const payload = await request(path);
    const revision = revisionFrom(payload);
    if (revision) state.revisions[resource] = revision;
    render(payload);
    updateRevisionNote();
  } catch (error) {
    const root = $(`#${config.rootId}`);
    clearChildren(root);
    const message = error instanceof ApiError && error.status === 409
      ? '数据已变化，请刷新后重新确认。'
      : '数据加载失败，请检查 token 与工作台 API。';
    addText(root, 'p', message, 'error-state');
    setLoadState(config.stateId, error instanceof ApiError && error.status === 409 ? '数据冲突' : '加载失败', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    showNotice(error instanceof ApiError && error.status === 409 ? '数据 revision 已变化，请刷新后再操作。' : '部分工作台数据加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  } finally {
    state.loading.delete(resource);
    if (['news', 'keywords', 'top'].includes(resource)) updateSelectionControls(resource);
  }
}

export async function runAction(path, button, loadingLabel, successText, onRefresh) {
  const originalLabel = button.textContent;
  button.textContent = loadingLabel;
  button.disabled = true;
  try {
    const result = await request(path, { method: 'POST', body: JSON.stringify({}) });
    showNotice(typeof successText === 'function' ? successText(result) : successText);
    if (typeof onRefresh === 'function') await onRefresh();
    return result;
  } catch (error) {
    showNotice(error.message || '操作失败，请检查当前条件后重试。', 'error');
    return null;
  } finally {
    button.textContent = originalLabel;
    button.disabled = false;
  }
}
