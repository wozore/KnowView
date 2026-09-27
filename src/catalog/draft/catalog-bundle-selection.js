'use strict';

function candidateKeyOf(draft) {
  return draft.bundle?.candidate?.candidate_key || draft.candidate?.candidate_key || draft.seed?.candidate_key || null;
}

function selectLatestCandidateDraft(drafts, candidateKey, baseRevision) {
  const related = drafts.filter(draft => candidateKeyOf(draft) === candidateKey
    && (baseRevision === undefined || draft.base_revision === baseRevision));
  const ordered = [...related].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (!ordered.length) return { ok: true, draft: null, superseded_draft_ids: [] };
  if (!ordered[0].updated_at || (ordered[1] && ordered[0].updated_at === ordered[1].updated_at)) {
    return { ok: false, code: 'BUNDLE_DRAFT_DUPLICATE', draft_ids: related.map(draft => draft.draft_id) };
  }
  return { ok: true, draft: ordered[0], superseded_draft_ids: ordered.slice(1).map(draft => draft.draft_id) };
}

module.exports = { candidateKeyOf, selectLatestCandidateDraft };
