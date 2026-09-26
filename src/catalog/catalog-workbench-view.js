'use strict';

/**
 * catalog-workbench-view.js — catalog-workbench 的 Draft 视图层
 *
 * 职责（纯函数，无 I/O）：
 *   - 恢复诊断：从 Draft 的 last_error / coverage 推导 recoveryKind、recoveryMode、
 *     缺失字段与给维护者的可读原因（recoveryDiagnostic）；
 *   - DTO 投影：把存储态 Draft 投影为浏览器安全的面板对象（projectDraft，脱敏本地路径）；
 *   - 恢复选项归一化：白名单键 + 数值范围校验（normalizeRecoveryOptions）；
 *   - 稳定 plan 哈希与带 code 的错误构造（planHashOf / codeError）。
 * catalog-workbench.js 是维护者操作协调器，面板展示与诊断细节收敛在本模块。
 */

const crypto = require('crypto');
const { DIRS } = require('../shared/paths');
const { getProvider } = require('../shared/providers');
const { redact } = require('../shared/ai-transport');
const assistant = require('./draft/index');
const { inferModality } = require('./core');

const RETRYABLE_ERROR_CODES = new Set([
  'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR',
  'SYNTHESIS_INCOMPLETE', 'SYNTHESIS_EMPTY', 'SYNTHESIS_FAILED', 'SYNTHESIS_RESUME_FAILED', 'SYNTHESIS_PROVENANCE_INVALID',
  'OUTPUT_INVALID', 'SCHEMA_INVALID', 'LAYER_PATCH_INVALID',
  'WEB_SEARCH_FALLBACK_FAILED', 'OFFICIAL_SOURCE_FETCH_FAILED',
  'TAVILY_SEARCH_FAILED', 'TAVILY_EXTRACT_FAILED', 'TAVILY_SEARCH_RATE_LIMITED', 'TAVILY_EXTRACT_RATE_LIMITED',
  'ZHIPU_WEB_SEARCH_FAILED', 'ZHIPU_WEB_SEARCH_RATE_LIMITED', 'ZHIPU_WEB_SEARCH_NETWORK_ERROR',
  'ZHIPU_WEB_SEARCH_TIMEOUT', 'ZHIPU_WEB_SEARCH_OUTPUT_INVALID',
  'RESEARCH_FAILED', 'RESEARCH_DISCOVER_FAILED', 'RESEARCH_ACQUIRE_FAILED', 'RESEARCH_RESUME_FAILED', 'PLANNER_FAILED',
]);

const PROJECT_ROOT = DIRS.project;

const RECOVERY_OPTION_KEYS = Object.freeze([
  'provider', 'model', 'protocol', 'search_provider', 'search_fallback_provider', 'extract_provider', 'extract_fallback_provider', 'search_engine', 'access_mode', 'timeout_ms',
  'max_search_queries', 'max_pages', 'max_responses_calls', 'max_synthesis_calls',
  'search_depth', 'max_search_results', 'extract_depth', 'chunks_per_source',
]);
const RECOVERY_OPTION_LIMITS = Object.freeze({
  timeout_ms: [1000, 600000], max_search_queries: [1, 20], max_pages: [1, 100],
  max_responses_calls: [1, 50], max_synthesis_calls: [1, 5], max_search_results: [1, 20], chunks_per_source: [1, 10],
});

function normalizeRecoveryOptions(input, defaults) {
  if (input === undefined) return assistant.normalizeGeneratorOptions(defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw codeError('RECOVERY_OPTIONS_INVALID');
  const unknown = Object.keys(input).filter(key => !RECOVERY_OPTION_KEYS.includes(key));
  if (unknown.length) throw codeError('RECOVERY_OPTIONS_INVALID');
  for (const field of ['model', 'provider', 'protocol', 'search_provider', 'search_fallback_provider', 'extract_provider', 'extract_fallback_provider', 'search_engine', 'access_mode']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw codeError(field === 'model' ? 'MODEL_REQUIRED' : 'RECOVERY_OPTIONS_INVALID');
  }
  for (const [key, range] of Object.entries(RECOVERY_OPTION_LIMITS)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) throw codeError('RECOVERY_OPTIONS_INVALID');
  }
  if (input.access_mode !== undefined && !['keyed', 'keyless'].includes(String(input.access_mode))) throw codeError('RECOVERY_OPTIONS_INVALID');
  for (const field of ['search_provider', 'search_fallback_provider']) {
    if (input[field] !== undefined && !['tavily', 'zhipu_web_search'].includes(input[field])) throw codeError('RECOVERY_OPTIONS_INVALID');
  }
  if (input.extract_provider !== undefined && input.extract_provider !== 'direct_fetch') throw codeError('RECOVERY_OPTIONS_INVALID');
  if (input.extract_fallback_provider !== undefined && input.extract_fallback_provider !== 'tavily') throw codeError('RECOVERY_OPTIONS_INVALID');
  const normalizedInput = { ...input };
  for (const key of Object.keys(RECOVERY_OPTION_LIMITS)) {
    if (normalizedInput[key] !== undefined) normalizedInput[key] = Number(normalizedInput[key]);
  }
  const merged = assistant.normalizeGeneratorOptions({ ...defaults, ...normalizedInput });
  if (!merged.model || typeof merged.model !== 'string') throw codeError('MODEL_REQUIRED');
  const provider = getProvider(merged.provider);
  if (!provider || provider.protocol !== merged.protocol
    || !['tavily', 'zhipu_web_search'].includes(merged.searchProvider)
    || merged.extractProvider !== 'direct_fetch'
    || merged.extractFallbackProvider !== 'tavily'
    || !['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'].includes(merged.searchEngine)) throw codeError('RECOVERY_OPTIONS_INVALID');
  return merged;
}

/** 脱敏本地路径，避免把绝对路径/临时路径泄露进浏览器 DTO。 */
function sanitizeReason(value) {
  if (typeof value !== 'string') return value;
  let out = redact(value);
  for (const root of [PROJECT_ROOT, PROJECT_ROOT.replace(/\\/g, '/'), PROJECT_ROOT.toLowerCase(), PROJECT_ROOT.replace(/\\/g, '/').toLowerCase()]) {
    out = out.split(root).join('<project>');
  }
  return out
    .replace(/(api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\s'"<>]*/g, '<path>')
    .slice(0, 320);
}

function blockerCodeFromReason(reason, fallback) {
  return String(reason || '').match(/^([A-Z][A-Z0-9_]+)(?=:|$)/)?.[1] || fallback;
}

function unresolvedPhase(reason) {
  const code = blockerCodeFromReason(reason, '');
  return ['PENDING_CANDIDATE_INVALID', 'PENDING_CANDIDATE_NAME_REQUIRED', 'PENDING_CANDIDATE_VAGUE', 'PENDING_DETAIL_KIND_INVALID'].includes(code)
    ? 'candidate_conversion'
    : 'source_resolution';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}
function codeError(code, message = code) {
  const error = new Error(message); error.code = code; return error;
}
function planHashOf(value) { return hash({ kind: 'catalog-workbench-plan', ...value }); }

function assertRequestFields(input, allowed, code, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    throw codeError(code, `${label} 请求字段无效`);
  }
}

function bundleReviewDto(result, draftId) {
  if (!result || result.ok !== true) return { ok: false, code: result?.code || 'BUNDLE_BLOCKED', draft_id: draftId, ...(result?.draft ? { draft: result.draft } : {}), ...(Array.isArray(result?.blockers) ? { blockers: result.blockers } : {}) };
  const previewHash = result.preview_hash || result.previewHash || result.draft?.preview_hash || null;
  const bundleToken = result.bundle_token || result.bundleToken || result.draft?.bundle_token || null;
  const currentRevision = result.current_revision || result.currentRevision || null;
  return { ok: true, status: 'review_ready', draft_id: draftId, current_revision: currentRevision, base_revision: result.draft?.base_revision || currentRevision, preview_hash: previewHash, bundle_token: bundleToken, confirmation: bundleToken ? `APPLY CATALOG BUNDLE ${bundleToken}` : null, discard_confirmation: bundleToken ? `DISCARD CATALOG BUNDLE ${bundleToken}` : null, draft: result.draft || null };
}

function bundleApplyDto(result, applyOptions = {}) {
  if (!result || result.ok !== true) return result || { ok: false, code: 'OPERATION_FAILED' };
  const cleanupPending = result.cleanup_pending === true || (Array.isArray(result.cleanup_pending) && result.cleanup_pending.length > 0);
  const outcomeWarning = result.outcome_warning || null;
  return { ok: true, status: result.status || 'committed', target_revision: result.target_revision || result.targetRevision || null, dist_requested: result.dist_requested === true, dist_built: result.dist_built === true, dist_pending: result.dist_pending === true, cleanup_pending: cleanupPending, cleanup_only: result.cleanup_only === true || result.cleanupOnly === true, outcome_pending: result.outcome_pending === true || Boolean(outcomeWarning), outcome_warning: outcomeWarning };
}

function recoveryDiagnostic(draft) {
  const modalityMismatch = draft?.seed?.detail_kind === 'api_model'
    && draft.research_plan?.profile?.modality
    && draft.research_plan.profile.modality !== inferModality(draft.seed);
  if (modalityMismatch) return {
    recoveryKind: 'seed_or_profile_required',
    recoveryMode: null,
    errorCode: 'DRAFT_PROFILE_MODALITY_MISMATCH',
    missingFields: [],
    missingConfigFields: [],
    suggestedDetailKind: null,
    reason: `Draft 使用 ${draft.research_plan.profile.modality} Profile，但候选名称对应 ${inferModality(draft.seed)} 模态；需重新准备。`,
  };
  if (draft?.readiness?.status === 'ready') return { recoveryKind: null, errorCode: null, missingFields: [], missingConfigFields: [], suggestedDetailKind: null, reason: null };
  const failure = draft?.last_error || {};
  const retryableProvenanceFailure = assistant.isRetryableSynthesisProvenanceFailure(failure);
  let errorCode = retryableProvenanceFailure ? 'SYNTHESIS_PROVENANCE_INVALID' : assistant.normalizeGatewayErrorCode(failure.code);
  if (errorCode === 'OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure.error || ''))) errorCode = 'MODEL_REQUIRED';
  const missingFields = [...new Set([
    ...(Array.isArray(failure.missing_fields) ? failure.missing_fields : []),
    ...(Array.isArray(draft?.coverage?.missing) ? draft.coverage.missing.map(item => `${item.layer}.${item.field}`) : []),
  ].filter(field => typeof field === 'string' && field.trim()))];
  const missingConfigFields = [...new Set((Array.isArray(failure.missing_config_fields) ? failure.missing_config_fields : []).filter(field => typeof field === 'string' && field.trim()))];
  // 存储 last_error 里的 recovery_kind 可能因既往误分类而失真（如 kind 段错误码被判成
  // manual_required），已知 retryable 码强制覆盖，否则该 Draft 在面板上永久丢失恢复入口。
  let recoveryKind = RETRYABLE_ERROR_CODES.has(errorCode) ? 'retryable' : (failure.recovery_kind || null);
  if (!recoveryKind) {
    if (errorCode === 'MODEL_REQUIRED' || ['AUTH_REQUIRED', 'ENDPOINT_INVALID', 'AI_PROVIDER_UNSUPPORTED', 'AI_PROTOCOL_MISMATCH', 'RETRIEVAL_PROVIDER_UNSUPPORTED', 'SEARCH_PROVIDER_UNSUPPORTED', 'SEARCH_FALLBACK_PROVIDER_UNSUPPORTED', 'EXTRACT_PROVIDER_UNSUPPORTED', 'EXTRACT_FALLBACK_PROVIDER_UNSUPPORTED', 'SEARCH_ENGINE_UNSUPPORTED', 'ZHIPU_WEB_SEARCH_AUTH_REQUIRED', 'ZHIPU_WEB_SEARCH_ENGINE_INVALID', 'ZHIPU_WEB_SEARCH_QUERY_REQUIRED', 'TAVILY_AUTH_REQUIRED', 'TAVILY_SEARCH_AUTH_REQUIRED', 'TAVILY_EXTRACT_AUTH_REQUIRED', 'TAVILY_ACCESS_MODE_REQUIRED', 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED'].includes(errorCode)) recoveryKind = 'config_required';
    else if (RETRYABLE_ERROR_CODES.has(errorCode)) recoveryKind = 'retryable';
    else if (errorCode === 'PROFILE_MISMATCH_SUSPECTED' || errorCode.startsWith('PLACEMENT_') || errorCode === 'SEED_INVALID') recoveryKind = 'seed_or_profile_required';
    else if (missingFields.length || errorCode === 'SYNTHESIS_COVERAGE_INCOMPLETE') recoveryKind = 'evidence_required';
    else recoveryKind = 'manual_required';
  }
  const suggestedDetailKind = typeof failure.suggested_detail_kind === 'string' ? failure.suggested_detail_kind : null;
  const researchComplete = draft?.research?.ok === true
    || (draft?.research?.ok !== false && Array.isArray(draft?.research?.official_sources) && draft.research.official_sources.length > 0 && !draft.research_progress?.failed_scope);
  const recoveryMode = researchComplete && ['config_required', 'retryable'].includes(recoveryKind)
    && !errorCode.startsWith('TAVILY_') && !errorCode.startsWith('ZHIPU_WEB_SEARCH_') ? 'synthesis_only' : 'research_resume';
  const reason = {
    MODEL_REQUIRED: '缺少 model 配置，请填写模型名后重试。',
    AUTH_REQUIRED: '缺少 AI provider 凭据，请在仓库根目录 .env 配置对应 key。',
    TAVILY_ACCESS_MODE_REQUIRED: '缺少 Tavily access mode 配置。',
    TAVILY_SEARCH_AUTH_REQUIRED: 'Tavily 搜索备用使用 keyed 模式但缺少 TAVILY_API_KEY；检查 key 或改用可用的 keyless 模式。',
    TAVILY_EXTRACT_AUTH_REQUIRED: 'Tavily 正文备用使用 keyed 模式但缺少 TAVILY_API_KEY；检查 key 或改用可用的 keyless 模式。',
    WEB_SEARCH_REQUEST_BUDGET_EXCEEDED: '首选 Web Search 的域名请求数超过当前搜索预算；提高 max_search_queries 后重试。',
    COST_BUDGET_EXHAUSTED: failure.category ? `${failure.category} 请求预算不足；调整对应预算后重试。` : '本次研究预算不足；检查成本计划并提高相应预算后重试。',
    SYNTHESIS_PROVENANCE_INVALID: `${sanitizeReason(failure.error || '合成输出引用的来源不在已抓取证据中。')}；可复用现有研究重新合成。`,
    DRAFT_PROFILE_MODALITY_MISMATCH: `Draft 模态与候选不一致，需重新准备。`,
    SYNTHESIS_COVERAGE_INCOMPLETE: missingFields.length ? `缺少官方证据字段：${missingFields.join('、')}` : '官方证据字段不完整。',
    PROFILE_MISMATCH_SUSPECTED: suggestedDetailKind ? `候选类型可能应为 ${suggestedDetailKind}，请修正候选资料。` : '候选类型或 Profile 不匹配。',
  }[errorCode] || (errorCode ? `恢复被阻断（${errorCode}）。` : 'Draft 当前不可恢复。');
  return { recoveryKind, recoveryMode, errorCode: errorCode || 'DRAFT_BLOCKED', missingFields, missingConfigFields: missingConfigFields.length ? missingConfigFields : (errorCode === 'MODEL_REQUIRED' ? ['model'] : []), suggestedDetailKind, reason };
}

function projectDraft(draft, extra = {}) {
  if (!draft) return null;
  const readiness = draft.readiness || {};
  const diagnostic = recoveryDiagnostic(draft);
  return {
    draft_id: draft.draft_id,
    candidate_name: String(draft.seed?.name || '').trim() || null,
    state: diagnostic.errorCode === 'DRAFT_PROFILE_MODALITY_MISMATCH' && draft.state === 'preview_ready' ? 'preview_blocked' : draft.state,
    base_revision: draft.base_revision || null,
    preview_hash: draft.preview_hash || null,
    readiness: diagnostic.errorCode === 'DRAFT_PROFILE_MODALITY_MISMATCH' ? 'blocked' : (readiness.status || null),
    recovery_kind: diagnostic.recoveryKind,
    recovery_mode: diagnostic.recoveryMode,
    error_code: diagnostic.errorCode,
    missing_fields: diagnostic.missingFields,
    missing_config_fields: diagnostic.missingConfigFields,
    suggested_detail_kind: diagnostic.suggestedDetailKind,
    blocking_reasons: diagnostic.reason ? [diagnostic.reason] : [],
    warnings: Array.isArray(readiness.warnings) ? readiness.warnings.slice(0, 5).map(sanitizeReason) : [],
    updated_at: draft.updated_at || null,
    ...extra,
  };
}

/** 汇总 prepare 的受阻清单：解析失败 / 核验受阻 / series 判定改道 Bundle / 计划期阻断。 */
function blockedEntriesOf(resolved, planned) {
  return [
    ...(resolved?.unresolved || []).map(item => ({ name: item.name, phase: unresolvedPhase(item.reason), code: blockerCodeFromReason(item.reason, 'SOURCE_RESOLUTION_FAILED'), reason: sanitizeReason(item.reason) })),
    ...(resolved?.verification_blocked || []).map(item => ({ name: item.name, phase: 'identity_verification', code: item.code || 'IDENTITY_VERIFICATION_BLOCKED', reason: sanitizeReason(item.reason) })),
    ...(resolved?.series_candidates || []).map(item => ({ name: item.name, phase: 'series_routing', code: 'SERIES_VERIFIED_USE_BUNDLE', reason: '官方身份核验判定为 series，应走 Series Bundle 入口' })),
    ...(planned?.blocked || []).map(item => ({ ...item, phase: item.phase || 'candidate_conversion', reason: sanitizeReason(item.reason) })),
  ];
}

module.exports = {
  normalizeRecoveryOptions,
  codeError,
  assertRequestFields,
  bundleReviewDto,
  bundleApplyDto,
  planHashOf,
  projectDraft,
  blockedEntriesOf,
  sanitizeReason,
};
