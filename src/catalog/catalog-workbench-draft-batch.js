'use strict';

function candidateIdentityKeys(draft) {
  const seed = draft?.seed || {};
  const name = String(seed.name || '').trim().toLowerCase();
  return [...new Set([seed.candidate_key, name ? `${String(seed.vendor_key || '').toLowerCase()}:${name}` : null].filter(Boolean))];
}

function supersededStaleDraftsOf(drafts, currentRevision) {
  const replaceableStates = new Set(['preview_ready', 'preview_blocked', 'failed_retryable', 'rolled_back']);
  const currentReady = new Set((drafts || [])
    .filter(draft => draft.base_revision === currentRevision && draft.state === 'preview_ready' && draft.readiness?.status === 'ready')
    .flatMap(candidateIdentityKeys));
  return (drafts || []).filter(draft => draft.base_revision !== currentRevision
    && replaceableStates.has(draft.state)
    && candidateIdentityKeys(draft).some(key => currentReady.has(key)));
}

function supersedeStaleDraftFiles({ listDrafts, currentRevision, isCatalogDraft, deleteDraft }) {
  if (typeof deleteDraft !== 'function') return;
  const drafts = listDrafts().filter(isCatalogDraft);
  for (const draft of supersededStaleDraftsOf(drafts, currentRevision)) {
    try { deleteDraft(draft.draft_id); } catch { /* stale duplicates remain excluded from batch preview */ }
  }
}

function staleDraftProjection(draft, currentRevision, projectDraft) {
  return projectDraft(draft, {
    state: 'preview_blocked',
    readiness: 'blocked',
    recovery_kind: 'manual_required',
    recovery_mode: null,
    error_code: 'DRAFT_BASE_REVISION_STALE',
    blocking_reasons: [`Draft 基于 Catalog ${draft.base_revision || 'unknown'}；当前 Catalog 是 ${currentRevision}。请使用当前基线重新准备此候选。`],
    stale_base_revision: true,
  });
}

function createCatalogBatchPreview({ currentSnapshot, pendingRevision, listDrafts, reviewCatalogDraftBatch, isCatalogDraft, projectDraft }) {
  return function batchPreview() {
    const currentRevision = currentSnapshot().revision;
    const sourcePendingRevision = pendingRevision();
    const allDrafts = listDrafts().filter(draft => isCatalogDraft(draft) && draft.state !== 'cleanup_pending');
    const staleDrafts = allDrafts.filter(draft => draft.base_revision !== currentRevision);
    const currentDrafts = allDrafts.filter(draft => draft.base_revision === currentRevision);
    const blockedDrafts = currentDrafts.filter(draft => draft.readiness?.status !== 'ready');
    const drafts = currentDrafts.filter(draft => draft.readiness?.status === 'ready');
    const draftIds = drafts.map(draft => draft.draft_id).sort();
    const coveredCandidates = new Set(drafts.flatMap(candidateIdentityKeys));
    const staleBlockers = staleDrafts
      .filter(draft => !candidateIdentityKeys(draft).some(key => coveredCandidates.has(key)))
      .map(draft => staleDraftProjection(draft, currentRevision, projectDraft));
    const blockers = [...blockedDrafts.map(draft => projectDraft(draft)), ...staleBlockers];
    if (!draftIds.length) return { ok: false, code: 'DRAFTS_NOT_READY', status: 'blocked', draft_count: 0, source_pending_revision: sourcePendingRevision, blockers };
    const checked = reviewCatalogDraftBatch(draftIds, { sourcePendingRevision });
    if (!checked.ok) {
      const failedDraft = drafts.find(draft => draft.draft_id === checked.draft_id);
      return {
        ok: false,
        code: checked.code || 'DRAFT_BATCH_STALE',
        status: 'blocked',
        draft_count: draftIds.length,
        catalog_revision: currentRevision,
        source_pending_revision: sourcePendingRevision,
        blockers: [...blockers, {
          ...(checked.draft_id ? { draft_id: checked.draft_id } : {}),
          ...(failedDraft?.seed?.name ? { candidate_name: failedDraft.seed.name } : {}),
          code: checked.code || 'DRAFT_BATCH_STALE',
          blocking_reasons: [checked.code === 'REVISION_CONFLICT'
            ? `Draft 与当前 Catalog revision 不一致（当前 ${checked.currentRevision || currentRevision}）。`
            : checked.error || checked.code || '批量 Draft 审核检查失败。'],
        }],
      };
    }
    return {
      ok: true,
      status: 'review_ready',
      expected_revision: checked.currentRevision,
      source_pending_revision: sourcePendingRevision,
      draft_count: checked.draft_ids.length,
      draft_ids: checked.draft_ids,
      drafts: checked.reviews.map(review => projectDraft(review.draft, { change_preview: review.plan.changePreview })),
      change_preview: checked.plan.changePreview,
      batch_token: checked.batchToken,
      blockers,
    };
  };
}

module.exports = { createCatalogBatchPreview, staleDraftProjection, supersededStaleDraftsOf, supersedeStaleDraftFiles };
