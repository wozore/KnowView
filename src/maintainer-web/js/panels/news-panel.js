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
let reviewPollTimer = null;

function scheduleReviewRefresh(onRefreshAll) {
  if (reviewPollTimer) window.clearTimeout(reviewPollTimer);
  reviewPollTimer = window.setTimeout(() => {
    reviewPollTimer = null;
    if (currentNewsFilter === 'pending' && !state.loading.has('news')) loadNewsReview(onRefreshAll);
  }, 10000);
}

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

function appendRepairButton(root, onRefreshAll) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary-button';
  btn.style.marginTop = '8px';
  btn.textContent = '手动重试 GLM 修复';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '正在 GLM 修复…';
    try {
      const result = unwrap(await request('news/repair', { method: 'POST', body: JSON.stringify({}) }));
      const repaired = Number(result?.repaired?.repairedReview || 0);
      showNotice(repaired > 0 ? `GLM 已补齐 ${repaired} 条初审结论。` : 'GLM 修复已结束，但没有补齐初审结论。', repaired > 0 ? 'success' : 'error');
      if (typeof onRefreshAll === 'function') await onRefreshAll();
    } catch (err) {
      showNotice(`GLM 修复失败：${err.message || err}`, 'error');
      btn.disabled = false;
      btn.textContent = '重试 GLM 修复';
    }
  });
  root.appendChild(btn);
}

function showFailedReviews(value, items, onRefreshAll) {
  const root = $('#newsList');
  const note = document.createElement('div');
  addText(note, 'p', value.message || 'AI 初审未完成，请检查候选错误。', 'error-state');
  appendRepairButton(note, onRefreshAll);
  root.prepend(note);
  const cards = root.querySelectorAll('.queue-item');
  items.forEach((item, index) => {
    if (item.review_status !== 'pending' || item.l1_review?.verdict || item.ai_advice?.verdict) return;
    const error = item.l1_review?.llm_error || item.ai_advice?.llm_error || '没有记录具体错误';
    addText(cards[index].querySelector('.item-content'), 'p', `上次记录的初审错误：${String(error).slice(0, 240)}`, 'error-state');
  });
  setLoadState('newsState', `${value.unreviewed_count} 条初审失败`, 'error');
}

async function exportFactCheckTasks(button) {
  button.disabled = true;
  try {
    const batch = unwrap(await request('news/fact-check/tasks?limit=10'));
    const blob = new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `news-fact-check-${batch.batch_id || 'batch'}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showNotice(batch.task_count ? `已导出 ${batch.task_count} 条查证任务；在 Codex 中使用 webSearchPrime 查证后导入结果。` : '当前没有待查证任务。', batch.task_count ? 'success' : 'error');
  } catch (error) {
    showNotice(`导出查证任务失败：${error.message || error}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function importFactCheckFile(input, onRefreshAll) {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  try {
    const payload = JSON.parse(await file.text());
    const result = unwrap(await request('news/fact-check/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }));
    showNotice(`已导入 ${result.imported || 0} 条查证结果；审核状态保持待人工决定。`, 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(`导入查证结果失败：${error.message || error}`, 'error');
  } finally {
    input.value = '';
    input.disabled = false;
  }
}

export function loadNewsReview(onRefreshAll) {
  const filter = currentNewsFilter;
  updateButtonVisibility(filter);
  return loadResource('news', `news/review?status=${encodeURIComponent(filter)}`, (payload) => {
    const value = unwrap(payload) || {};
    if (value.counts) updateTabCounts(value.counts);
    if (reviewPollTimer) window.clearTimeout(reviewPollTimer);
    reviewPollTimer = null;
    if (value.status === 'enriching') {
      const root = $('#newsList');
      clearChildren(root);
      addText(root, 'p', `🤖 ${value.message || 'GLM 正在进行 AI 初审分流与汉化，请稍候...'}`, 'panel-note');
      appendRepairButton(root, onRefreshAll);
      setLoadState('newsState', 'AI 初审中…', 'loading');
      updateSelectionControls('news');
      scheduleReviewRefresh(onRefreshAll);
      return;
    }
    const emptyMsg = filter === 'approved'
      ? '当前没有已批准的新闻。'
      : filter === 'discarded'
        ? '当前没有已丢弃的新闻。'
        : '当前没有待首审新闻。';
    const items = listFrom(payload, ['items', 'candidates', 'queue', 'news']);
    renderQueue('news', 'newsList', items, 'newsState', {
      selectable: true,
      empty: emptyMsg,
    });
    if (value.status === 'failed') showFailedReviews(value, items, onRefreshAll);
  }, { rootId: 'newsList', stateId: 'newsState' });
}

export function setupNewsPanel(onRefreshAll) {
  bindSelection('news', 'newsList', 'newsSelectAll');
  const exportButton = $('#newsFactCheckExportButton');
  if (exportButton) exportButton.addEventListener('click', () => exportFactCheckTasks(exportButton));
  const importInput = $('#newsFactCheckImportFile');
  if (importInput) importInput.addEventListener('change', () => importFactCheckFile(importInput, onRefreshAll));
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
