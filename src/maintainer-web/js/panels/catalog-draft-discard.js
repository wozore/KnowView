import { request, ApiError } from '../api.js';
import { state, addText, showNotice } from '../state.js';

// Draft 丢弃控件：从 catalog-panel 拆出（check-standards 单文件 400 行上限）。
// 走正式 POST /catalog/drafts/:id/discard，服务端按状态白名单裁决。
export function discardButtonFor(draft, host, onRefreshAll) {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'button button-quiet';
  discard.textContent = '丢弃 Draft';
  discard.addEventListener('click', () => discardCatalogDraft(draft, discard, onRefreshAll));
  toolbar.appendChild(discard);
  host.appendChild(toolbar);
}
export async function discardCatalogDraft(draft, button, onRefreshAll) {
  button.disabled = true;
  try {
    const result = await request(`catalog/drafts/${encodeURIComponent(draft.draft_id)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: state.revisions.catalog }),
    });
    if (!result?.ok) throw new Error(result?.code || 'Draft 丢弃被拒绝');
    state.catalogRecovery.delete(draft.draft_id);
    showNotice(`${draft.candidate_name || 'Draft'} 已丢弃。`, 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    const code = error.code || error.payload?.code || error.payload?.error;
    let msg = error.message || 'Draft 丢弃失败。';
    if (code === 'REVISION_CONFLICT') msg = 'Catalog 正式数据已发生变更，请点击顶部“刷新数据”后再试。';
    else if (code === 'DRAFT_RECOVERY_IN_PROGRESS') msg = '该 Draft 正在恢复中，完成或刷新后再丢弃。';
    else if (code === 'DRAFT_DISCARD_FORBIDDEN') msg = `该 Draft 当前状态（${error.payload?.state || 'unknown'}）不允许丢弃。`;
    showNotice(msg, 'error');
  } finally {
    button.disabled = false;
  }
}
