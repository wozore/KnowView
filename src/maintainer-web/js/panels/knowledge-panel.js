import { request, writeRequest, listFrom } from '../api.js';
import {
  state,
  $,
  addText,
  addBadge,
  clearChildren,
  setLoadState,
  showNotice,
} from '../state.js';
import {
  itemTitle,
  handleMutationError,
} from './common.js';

const PENDING_STATE_ZH = Object.freeze({
  pending_review: '待审核',
  approved_pending: '待生成',
  discarded: '已丢弃',
  completed: '已完成',
  approved: '待生成',
  bundle_review: 'Bundle 待 Apply',
});

const BLOCKING_ZH = Object.freeze({
  NOT_REVIEWED: '尚未审核',
  DISCARDED: '已丢弃',
  ALREADY_EXISTS: '正式知识库已存在',
});

const viewModes = { tools: 'active', concepts: 'active' };

export async function reviewPending(kind, candidateKey, decision, button, onRefreshAll) {
  const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
  const route = `feedback/${kind}/${encodeURIComponent(candidateKey)}/review`;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    await writeRequest(route, resource, { candidate_key: candidateKey, decision });
    showNotice(decision === 'approved' ? '待补卡已批准，可进入生成计划。' : '待补卡已丢弃，后续提取不会复活它。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, resource, kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', button);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export function renderPendingCards(kind, payload, onRefreshAll) {
  const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
  const root = $(`#${resource}List`);
  if (!root) return;
  clearChildren(root);

  const items = listFrom(payload, ['items']);
  const historyItems = listFrom(payload, ['history_items']);
  state.items[resource] = items;
  state.items[`${resource}_history`] = historyItems;

  const currentMode = viewModes[kind] || 'active';

  // 待办 / 历史 视图切换（默认待办，历史可查看已丢弃并重新批准）
  const tabContainer = document.createElement('div');
  tabContainer.className = 'pending-view-tabs toolbar';
  tabContainer.style.marginBottom = '8px';

  const activeTab = document.createElement('button');
  activeTab.type = 'button';
  activeTab.className = `button button-quiet ${currentMode === 'active' ? 'active' : ''}`;
  activeTab.id = `${resource}ActiveTab`;
  activeTab.textContent = `待办 (${items.length})`;
  activeTab.addEventListener('click', () => {
    viewModes[kind] = 'active';
    renderPendingCards(kind, payload, onRefreshAll);
  });

  const historyTab = document.createElement('button');
  historyTab.type = 'button';
  historyTab.className = `button button-quiet ${currentMode === 'history' ? 'active' : ''}`;
  historyTab.id = `${resource}HistoryTab`;
  historyTab.textContent = `历史 (${historyItems.length})`;
  historyTab.addEventListener('click', () => {
    viewModes[kind] = 'history';
    renderPendingCards(kind, payload, onRefreshAll);
  });

  tabContainer.appendChild(activeTab);
  tabContainer.appendChild(historyTab);
  root.appendChild(tabContainer);

  const displayList = currentMode === 'active' ? items : historyItems;

  if (!displayList.length) {
    addText(root, 'p', currentMode === 'active' ? '当前没有待补卡。' : '当前没有历史卡片。', 'empty-state');
  }

  for (const item of displayList) {
    const article = document.createElement('article');
    article.className = 'queue-item';
    const content = document.createElement('div');
    content.className = 'item-content';

    // 完整名称
    addText(content, 'h3', itemTitle(item), 'item-title');

    // 标签行：entity_type、detail_kind_hint、review_status、workflow_state
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (item.entity_type) {
      addBadge(meta, item.entity_type, 'entity-type');
    } else {
      addBadge(meta, kind === 'tools' ? 'tool' : 'concept', 'entity-type');
    }
    if (kind === 'tools' && item.detail_kind_hint) {
      addBadge(meta, item.detail_kind_hint, 'detail-kind');
    }
    addBadge(meta, item.review_status || 'pending', item.review_status || 'pending');
    const stateName = item.entity_type === 'series' && item.review_status === 'approved'
      ? '待 SeriesBundle v4'
      : PENDING_STATE_ZH[item.workflow_state] || item.workflow_state || '待审核';
    addBadge(meta, stateName, String(item.workflow_state || 'pending_review'));
    content.appendChild(meta);

    // candidate_key
    if (item.candidate_key) {
      addText(content, 'p', `candidate_key：${item.candidate_key}`, 'item-id');
    }

    // 提及次数
    addText(content, 'p', `提及次数：${item.mentioned_in_summaries ?? 1}`, 'item-mentions');

    // 目录近似卡
    if (kind === 'tools' && Array.isArray(item.similar_in_catalog) && item.similar_in_catalog.length) {
      addText(content, 'p', `目录近似卡：${item.similar_in_catalog.map(t => t.title || t.tool_key).join('、')}——请确认是否同一工具/型号`, 'item-summary');
    }

    // 阻塞原因
    const blockedText = (Array.isArray(item.blocking_reasons) ? item.blocking_reasons : [])
      .map(reason => BLOCKING_ZH[reason] || reason).join('；');
    if (blockedText) {
      addText(content, 'p', blockedText, 'item-blocked');
    }

    // 描述 / 简介（为空时明确显示“待补全”）
    const desc = String(item.description || item.definition || '').trim();
    const pendingDescription = item.workflow_state === 'bundle_review'
      ? '描述：已在 SeriesBundle 预览中补全'
      : item.entity_type === 'series'
        ? '系列候选请使用 SeriesBundle v4 准备；普通 Catalog Draft 不处理系列。'
        : '描述：将在 Draft 预览中补全';
    addText(content, 'p', desc ? `描述：${desc}` : pendingDescription, 'item-description');

    // 动作按钮
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (kind === 'tools' && item.entity_type === 'series' && item.review_status === 'approved') {
      const bundleRoute = document.createElement('button');
      bundleRoute.type = 'button';
      bundleRoute.className = 'button button-primary';
      bundleRoute.textContent = '生成 SeriesBundle 计划';
      bundleRoute.addEventListener('click', () => {
        const planButton = $('#catalogBundlePlanButton');
        if (!planButton) {
          showNotice('找不到 SeriesBundle v4 计划按钮，请刷新工作台。', 'error');
          return;
        }
        planButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
        planButton.focus({ preventScroll: true });
        planButton.click();
      });
      actions.appendChild(bundleRoute);
    }

    if (currentMode === 'active') {
      if (item.workflow_state !== 'completed') {
        if (item.review_status !== 'discarded') {
          const discard = document.createElement('button');
          discard.type = 'button';
          discard.className = 'button button-danger';
          discard.textContent = '丢弃';
          discard.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'discarded', discard, onRefreshAll));
          actions.appendChild(discard);
        }
        if (item.review_status !== 'approved') {
          const approve = document.createElement('button');
          approve.type = 'button';
          approve.className = 'button button-primary';
          approve.textContent = '批准';
          approve.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'approved', approve, onRefreshAll));
          actions.appendChild(approve);
        }
      }
    } else {
      // 历史视图：允许重新批准已丢弃卡
      if (item.review_status === 'discarded') {
        const reapprove = document.createElement('button');
        reapprove.type = 'button';
        reapprove.className = 'button button-primary';
        reapprove.textContent = '重新批准';
        reapprove.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'approved', reapprove, onRefreshAll));
        actions.appendChild(reapprove);
      }
    }

    if (actions.children.length > 0) {
      content.appendChild(actions);
    }

    article.appendChild(document.createElement('span'));
    article.appendChild(content);
    root.appendChild(article);
  }

  // 默认计数仅统计待办卡（不含历史卡）
  setLoadState(kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', `${items.length} 条`, 'success');
}

export async function extractKnowledge(button, onRefreshAll) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '提取中…';
  try {
    const result = await writeRequest('knowledge/extract', 'news', {});
    showNotice(`提取完成：新增/更新工具 ${Number(result?.tools_pending || 0)}、概念 ${Number(result?.concepts_pending || 0)}。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'news', 'knowledgeLoopState', button);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export function setupKnowledgePanel(onRefreshAll) {
  const extractBtn = $('#knowledgeExtractButton');
  if (extractBtn) {
    extractBtn.addEventListener('click', (event) => extractKnowledge(event.currentTarget, onRefreshAll));
  }
}
