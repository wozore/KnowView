import { request, writeRequest, unwrap, listFrom } from '../api.js';
import {
  state,
  $,
  addText,
  clearChildren,
  setLoadState,
  showNotice,
} from '../state.js';
import {
  renderQueue,
  bindSelection,
  updateSelectionControls,
  handleMutationError,
  loadResource,
} from './common.js';

let currentNewsFilter = 'pending';

export async function reviewNews(decision, button, onRefreshAll) {
  const ids = [...state.selected.news];
  if (!ids.length) return;
  state.loading.add('news');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/review', 'news', { ids, decision, status: decision });
    state.selected.news.clear();
    const actionMsg = decision === 'approved'
      ? `已批准 ${ids.length} 条新闻候选。`
      : decision === 'discarded'
        ? `已丢弃 ${ids.length} 条新闻候选。`
        : `已将 ${ids.length} 条新闻回退为待审状态。`;
    showNotice(actionMsg);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'news', 'newsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

function updateTabCounts(counts = {}) {
  const p = $('#newsPendingCount'); if (p) p.textContent = counts.pending ?? 0;
  const a = $('#newsApprovedCount'); if (a) a.textContent = counts.approved ?? 0;
  const d = $('#newsDiscardedCount'); if (d) d.textContent = counts.discarded ?? 0;
  const t = $('#newsTotalCount'); if (t) t.textContent = counts.total ?? 0;
}

function updateButtonVisibility(filter) {
  const revertBtn = $('#newsRevertButton');
  const approveBtn = $('#newsApproveButton');
  const discardBtn = $('#newsDiscardButton');
  if (revertBtn) {
    revertBtn.style.display = filter === 'pending' ? 'none' : 'inline-block';
  }
  if (approveBtn) {
    approveBtn.textContent = filter === 'discarded' ? '重新批准所选' : '批准所选';
    approveBtn.style.display = 'inline-block';
  }
  if (discardBtn) {
    discardBtn.textContent = filter === 'approved' ? '转为丢弃所选' : '丢弃所选';
    discardBtn.style.display = 'inline-block';
  }
}

export function loadNewsReview(onRefreshAll) {
  const filter = currentNewsFilter;
  updateButtonVisibility(filter);
  return loadResource('news', `news/review?status=${encodeURIComponent(filter)}`, (payload) => {
    const value = unwrap(payload) || {};
    if (value.counts) updateTabCounts(value.counts);
    if (value.status === 'enriching') {
      const root = $('#newsList');
      clearChildren(root);
      addText(root, 'p', `🤖 ${value.message || '本地 Bonsai 正在进行 AI 初审分流与汉化，请稍候...'}`, 'panel-note');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary-button';
      btn.style.marginTop = '8px';
      btn.textContent = '立即运行双通道自愈修复';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '正在双通道修复…';
        try {
          await request('news/repair', { method: 'POST', body: JSON.stringify({}) });
          showNotice('双通道自愈修复已完成，正在刷新…', 'success');
          if (typeof onRefreshAll === 'function') onRefreshAll();
        } catch (err) {
          showNotice(`自愈修复失败：${err.message || err}`, 'error');
          btn.disabled = false;
          btn.textContent = '重试双通道自愈修复';
        }
      });
      root.appendChild(btn);
      setLoadState('newsState', 'AI 初审中…', 'loading');
      updateSelectionControls('news');
      return;
    }
    const emptyMsg = filter === 'approved'
      ? '当前没有已批准的新闻。'
      : filter === 'discarded'
        ? '当前没有已丢弃的新闻。'
        : '当前没有待首审新闻。';
    renderQueue('news', 'newsList', listFrom(payload, ['items', 'candidates', 'queue', 'news']), 'newsState', {
      selectable: true,
      empty: emptyMsg,
    });
  }, { rootId: 'newsList', stateId: 'newsState' });
}

export function setupNewsPanel(onRefreshAll) {
  bindSelection('news', 'newsList', 'newsSelectAll');
  const approveBtn = $('#newsApproveButton');
  if (approveBtn) {
    approveBtn.addEventListener('click', (event) => reviewNews('approved', event.currentTarget, onRefreshAll));
  }
  const discardBtn = $('#newsDiscardButton');
  if (discardBtn) {
    discardBtn.addEventListener('click', (event) => reviewNews('discarded', event.currentTarget, onRefreshAll));
  }
  const revertBtn = $('#newsRevertButton');
  if (revertBtn) {
    revertBtn.addEventListener('click', (event) => reviewNews('pending', event.currentTarget, onRefreshAll));
  }

  const tabContainer = $('#newsStatusTabs');
  if (tabContainer) {
    tabContainer.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-status]');
      if (!button) return;
      const status = button.dataset.status;
      if (status === currentNewsFilter) return;
      currentNewsFilter = status;
      for (const btn of tabContainer.querySelectorAll('button[data-status]')) {
        btn.classList.toggle('active', btn === button);
      }
      state.selected.news.clear();
      updateSelectionControls('news');
      loadNewsReview(onRefreshAll);
    });
  }
}
