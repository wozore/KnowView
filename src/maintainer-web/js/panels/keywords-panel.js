import { readResource, writeRequest, unwrap } from '../api.js';
import {
  state,
  $,
  $$,
  text,
  showNotice,
} from '../state.js';
import {
  renderQueue,
  bindSelection,
  handleMutationError,
  loadResource,
  runAction,
} from './common.js';

let activePurpose = 'content';

export function getActiveKeywordPurpose() {
  return activePurpose;
}

export function setActiveKeywordPurpose(purpose) {
  activePurpose = purpose || 'content';
}

export function renderKeywords(payload) {
  const value = unwrap(payload) || {};
  const all = Array.isArray(value.items) ? value.items : [];
  const pending = all.filter(item => !(item && (item.adopted === true || item.discarded === true)));
  renderQueue('keywords', 'keywordList', pending, 'keywordsState', {
    selectable: true,
    titleKeys: ['word', 'value', 'id'],
    empty: all.length > 0 ? '当前用途关键词候选已全部处理。' : '当前用途没有待处理关键词候选。',
  });
  const note = $('#keywordSourceNote');
  if (note) {
    const source = value.source;
    if (source && source.input_count != null) {
      note.textContent = `来源：共 ${source.source_count ?? '?'} 条 approved，读取评分前 ${source.input_count} 条生成候选。`;
    } else if (all.length === 0) {
      note.textContent = '当前用途尚未生成候选；可点击上方按钮生成。';
    } else {
      note.textContent = '';
    }
  }
}

export async function adoptKeywords(button, onRefreshAll) {
  const ids = [...state.selected.keywords];
  if (!ids.length) return;
  state.loading.add('keywords');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/keywords', 'keywords', { ids, purpose: activePurpose });
    state.selected.keywords.clear();
    showNotice(`已采纳 ${ids.length} 条 [${activePurpose}] 候选。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'keywords', 'keywordsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export async function discardKeywords(button, onRefreshAll) {
  const ids = [...state.selected.keywords];
  if (!ids.length) return;
  state.loading.add('keywords');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/keywords/discard', 'keywords', { ids, purpose: activePurpose });
    state.selected.keywords.clear();
    showNotice(`已丢弃 ${ids.length} 条 [${activePurpose}] 候选（加入对应黑名单）。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'keywords', 'keywordsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export async function generateKeywords(button, onRefreshAll, purpose = activePurpose) {
  activePurpose = purpose;
  updatePurposeTabStyles();
  await runAction('news/keywords/generate', button, '生成中…', result => {
    const count = Number(result?.candidates?.length || result?.candidate_count || 0);
    return `已生成 ${count} 条 [${purpose}] 候选。`;
  }, onRefreshAll, { purpose });
}

export function loadKeywords(purpose = activePurpose) {
  activePurpose = purpose;
  updatePurposeTabStyles();
  return loadResource('keywords', `news/keywords?purpose=${encodeURIComponent(activePurpose)}`, renderKeywords, {
    rootId: 'keywordList',
    stateId: 'keywordsState',
  });
}

function updatePurposeTabStyles() {
  const tabs = $$('#keywordPurposeTabs button[data-purpose]');
  for (const tab of tabs) {
    const p = tab.getAttribute('data-purpose');
    if (p === activePurpose) tab.classList.add('active');
    else tab.classList.remove('active');
  }
}

export function setupKeywordsPanel(onRefreshAll) {
  bindSelection('keywords', 'keywordList', 'keywordSelectAll');
  const tabs = $$('#keywordPurposeTabs button[data-purpose]');
  for (const tab of tabs) {
    tab.addEventListener('click', async event => {
      const p = event.currentTarget.getAttribute('data-purpose') || 'content';
      await loadKeywords(p);
    });
  }

  const genContentBtn = $('#keywordGenerateContentButton');
  if (genContentBtn) genContentBtn.addEventListener('click', e => generateKeywords(e.currentTarget, onRefreshAll, 'content'));
  const genYtBtn = $('#keywordGenerateYoutubeButton');
  if (genYtBtn) genYtBtn.addEventListener('click', e => generateKeywords(e.currentTarget, onRefreshAll, 'youtube'));
  const genXBtn = $('#keywordGenerateXButton');
  if (genXBtn) genXBtn.addEventListener('click', e => generateKeywords(e.currentTarget, onRefreshAll, 'x_discovery'));
  const genBtn = $('#keywordGenerateButton');
  if (genBtn) genBtn.addEventListener('click', e => generateKeywords(e.currentTarget, onRefreshAll, activePurpose));

  const adoptBtn = $('#keywordAdoptButton');
  if (adoptBtn) adoptBtn.addEventListener('click', e => adoptKeywords(e.currentTarget, onRefreshAll));
  const discardBtn = $('#keywordDiscardButton');
  if (discardBtn) discardBtn.addEventListener('click', e => discardKeywords(e.currentTarget, onRefreshAll));
}
