'use strict';

const { selectLatestCandidateDraft } = require('./draft');

function listBundleDraftsForWorkbench({ listBundles, listDrafts, bundleOptions, projectBundleDraft, currentRevision }) {
  const listed = listBundles(bundleOptions);
  const listedIds = new Set((listed?.items || []).map(item => item.draft_id));
  const inFlight = listDrafts().filter(draft => draft.schema_version === 4 && draft.draft_kind === 'series_bundle' && !listedIds.has(draft.draft_id)).map(projectBundleDraft);
  const candidates = [...(listed?.items || []), ...inFlight];
  const candidateKeys = [...new Set(candidates.map(item => item.candidate?.candidate_key).filter(Boolean))];
  const selectionErrors = [...(listed?.selection_errors || [])];
  const selectedItems = [];
  for (const key of candidateKeys) {
    const current = selectLatestCandidateDraft(candidates, key, currentRevision);
    const selected = current.ok && !current.draft ? selectLatestCandidateDraft(candidates, key) : current;
    if (!selected.ok) {
      selectionErrors.push({ candidate_key: key, code: selected.code, draft_ids: selected.draft_ids || [] });
      continue;
    }
    if (selected.draft) selectedItems.push({ ...selected.draft, superseded_draft_ids: selected.superseded_draft_ids });
  }
  for (const item of candidates.filter(value => !value.candidate?.candidate_key)) {
    selectionErrors.push({ candidate_key: null, draft_id: item.draft_id, code: 'BUNDLE_CANDIDATE_KEY_MISSING' });
  }
  const items = selectedItems.map(value => {
    const item = value.bundle ? projectBundleDraft(value) : value;
    const isCleanup = item?.state === 'cleanup_pending';
    const isOutcome = item?.state === 'outcome_pending';
    return {
      ...item,
      ...(item?.bundle_token ? { discard_confirmation: `DISCARD CATALOG BUNDLE ${item.bundle_token}` } : {}),
      cleanup_pending: isCleanup,
      outcome_pending: isOutcome,
      cleanup_only: isCleanup || isOutcome,
      cleanup_action: (isCleanup || isOutcome) && item?.bundle_token ? { draft_id: item.draft_id, expected_revision: currentRevision, bundle_token: item.bundle_token, confirm: `APPLY CATALOG BUNDLE ${item.bundle_token}` } : null,
    };
  });
  return { ...(listed || {}), items, count: items.length, selection_errors: selectionErrors };
}

module.exports = { listBundleDraftsForWorkbench };
