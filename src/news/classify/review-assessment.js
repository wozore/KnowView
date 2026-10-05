/** review-assessment.js —— 审核结构化判断维度的枚举校验。 */

'use strict';

const ASSESSMENT_ENUMS = Object.freeze({
  topic_relevance: new Set(['in_scope', 'out_of_scope', 'uncertain']),
  subject_clarity: new Set(['specific', 'broad', 'ambiguous']),
  information_value: new Set(['substantive', 'low', 'uncertain']),
  source_quality: new Set(['primary', 'credible_secondary', 'unknown', 'not_applicable']),
  evidence_status: new Set(['sufficient', 'needs_content', 'needs_source', 'needs_fact_check', 'inconclusive']),
  decision_basis: new Set([
    'clear_relevant_content', 'clear_off_topic', 'advertising_or_spam', 'duplicate',
    'clearly_low_value', 'political_context_only', 'insufficient_content', 'unverified_fact', 'uncertain',
  ]),
});

function normalizeReviewAssessment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const assessment = {};
  for (const [field, allowed] of Object.entries(ASSESSMENT_ENUMS)) {
    if (!allowed.has(raw[field])) return null;
    assessment[field] = raw[field];
  }
  return assessment;
}

function reviewAssessmentGate(verdict, assessment, factCheck, webVerification) {
  const normalized = normalizeReviewAssessment(assessment);
  if (!normalized) return { action: 'manual', reason: 'assessment_incomplete' };
  const hasSources = (Array.isArray(webVerification?.sources) && webVerification.sources.length > 0)
    || (Array.isArray(webVerification?.results) && webVerification.results.length > 0);
  const factSupported = webVerification?.status === 'completed'
    && webVerification.conclusion === 'supports' && hasSources;
  if (webVerification?.conclusion === 'contradicts') return { action: 'manual', reason: 'fact_check_contradicts' };
  if (factCheck?.needed === true && !factSupported) {
    return { action: 'manual', reason: webVerification?.conclusion === 'inconclusive' ? 'fact_check_inconclusive' : 'fact_check_required' };
  }

  const sufficient = normalized.evidence_status === 'sufficient'
    || (normalized.evidence_status === 'needs_fact_check' && factSupported);
  const approvalBasis = normalized.decision_basis === 'clear_relevant_content'
    || (factSupported && normalized.decision_basis === 'unverified_fact');
  if (verdict === 'approve'
    && normalized.topic_relevance === 'in_scope'
    && normalized.subject_clarity === 'specific'
    && normalized.information_value === 'substantive'
    && sufficient
    && approvalBasis) {
    return { action: 'approve_candidate', reason: 'criteria_satisfied' };
  }

  const clearDiscard = normalized.decision_basis === 'clear_off_topic'
    && normalized.topic_relevance === 'out_of_scope';
  const lowValueDiscard = ['advertising_or_spam', 'duplicate', 'clearly_low_value', 'political_context_only'].includes(normalized.decision_basis)
    && normalized.information_value === 'low';
  if (verdict === 'discard' && sufficient && (clearDiscard || lowValueDiscard)) {
    return { action: 'discard_candidate', reason: 'criteria_satisfied' };
  }
  return { action: 'manual', reason: 'criteria_not_satisfied' };
}

module.exports = { normalizeReviewAssessment, reviewAssessmentGate };
