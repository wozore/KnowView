'use strict';

const { validatePlannedRecords } = require('../core/catalog-record-completeness');
const { fieldCoverageOf } = require('../core/catalog-synthesis');
const { inferModality } = require('../core');

const RETRYABLE_CODES = new Set([
  'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR',
  'WEB_SEARCH_FALLBACK_FAILED', 'OFFICIAL_SOURCE_FETCH_FAILED',
  'SYNTHESIS_INCOMPLETE', 'SYNTHESIS_EMPTY', 'SYNTHESIS_FAILED', 'SYNTHESIS_RESUME_FAILED', 'SYNTHESIS_PROVENANCE_INVALID',
  'OUTPUT_INVALID', 'SCHEMA_INVALID', 'COST_BUDGET_EXHAUSTED', 'LAYER_PATCH_INVALID',
  'TAVILY_SEARCH_FAILED', 'TAVILY_EXTRACT_FAILED', 'TAVILY_SEARCH_RATE_LIMITED', 'TAVILY_EXTRACT_RATE_LIMITED',
  'ZHIPU_WEB_SEARCH_FAILED', 'ZHIPU_WEB_SEARCH_RATE_LIMITED', 'ZHIPU_WEB_SEARCH_TIMEOUT', 'ZHIPU_WEB_SEARCH_NETWORK_ERROR', 'ZHIPU_WEB_SEARCH_OUTPUT_INVALID',
  'RESEARCH_FAILED', 'RESEARCH_DISCOVER_FAILED', 'RESEARCH_ACQUIRE_FAILED', 'RESEARCH_RESUME_FAILED', 'PLANNER_FAILED',
]);
const CONFIG_CODES = new Set([
  'MODEL_REQUIRED', 'AUTH_REQUIRED', 'ENDPOINT_INVALID', 'AI_PROVIDER_UNSUPPORTED',
  'AI_PROTOCOL_MISMATCH', 'RETRIEVAL_PROVIDER_UNSUPPORTED', 'SEARCH_PROVIDER_UNSUPPORTED', 'SEARCH_ENGINE_UNSUPPORTED',
  'TAVILY_AUTH_REQUIRED', 'TAVILY_SEARCH_AUTH_REQUIRED', 'TAVILY_EXTRACT_AUTH_REQUIRED', 'TAVILY_ACCESS_MODE_REQUIRED',
  'ZHIPU_WEB_SEARCH_AUTH_REQUIRED', 'ZHIPU_WEB_SEARCH_ENGINE_INVALID', 'ZHIPU_WEB_SEARCH_QUERY_REQUIRED',
  'SEARCH_FALLBACK_PROVIDER_UNSUPPORTED', 'EXTRACT_PROVIDER_UNSUPPORTED', 'EXTRACT_FALLBACK_PROVIDER_UNSUPPORTED',
  'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED',
]);
const PROFILE_CODES = new Set(['PROFILE_MISMATCH_SUSPECTED', 'DRAFT_PROFILE_MODALITY_MISMATCH', 'PLACEMENT_MANUAL_REQUIRED', 'PLACEMENT_AI_FAILED', 'SEED_INVALID']);
const EVIDENCE_CODES = new Set(['SYNTHESIS_COVERAGE_INCOMPLETE', 'SOURCE_ID_INVALID', 'PATCH_PROVENANCE_MISSING', 'OFFICIAL_SOURCE_REQUIRED']);

// 网关阶段码形如 SYNTHESIS_SCHEMA_INVALID；传输类码由 ai-transport 按当前 provider 拼
// 前缀（如 ZHIPU_TIMEOUT），必须按后缀归一，否则非 deepseek provider 的传输失败会被
// 误判 manual_required，Draft 在面板上永久失去恢复入口。DEEPSEEK_* 为历史 Draft 存量
// 码，读取时迁移到现行码。
const STAGE_COLLAPSE_RE = /^(?:RESEARCH|SYNTHESIS)_(OUTPUT_INVALID|SCHEMA_INVALID)$/;
const LEGACY_STAGE_RE = /^DEEPSEEK_(?:(?:RESEARCH|SYNTHESIS)_)?(OUTPUT_INVALID|SCHEMA_INVALID|SYNTHESIS_EMPTY|SYNTHESIS_INCOMPLETE|SYNTHESIS_FAILED)$/;
const PROVIDER_ERROR_SUFFIX_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(TIMEOUT|RATE_LIMITED|PROVIDER_ERROR|NETWORK_ERROR|AUTH_REQUIRED|ENDPOINT_INVALID|OUTPUT_INVALID|SCHEMA_INVALID)$/;
function normalizeGatewayErrorCode(code) {
  const raw = String(code || '');
  const stage = raw.match(STAGE_COLLAPSE_RE) || raw.match(LEGACY_STAGE_RE);
  if (stage) return stage[1];
  // Preserve retrieval-provider codes: recovery mode uses them to decide whether
  // official-source research itself must be resumed.
  if (raw.startsWith('TAVILY_') || raw.startsWith('ZHIPU_WEB_SEARCH_')) return raw;
  const providerError = raw.match(PROVIDER_ERROR_SUFFIX_RE);
  if (providerError) return providerError[1];
  return raw;
}

function failureCodeOf(failure) {
  const code = normalizeGatewayErrorCode(failure?.code) || 'DRAFT_BLOCKED';
  if (code === 'OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure?.error || ''))) return 'MODEL_REQUIRED';
  return code;
}

function isRetryableSynthesisProvenanceFailure(failure) {
  if (String(failure?.code || '') !== 'SYNTHESIS_INVALID') return false;
  return /派生字段必须引用至少一个官方来源|来源不存在:|provenance.*(?:source|来源)/i.test(String(failure?.error || ''));
}

function classifyFailure(research, synthesis) {
  const failure = !research?.ok ? research : !synthesis?.ok ? synthesis : null;
  if (!failure && Array.isArray(synthesis?.coverage?.missing) && synthesis.coverage.missing.length) {
    return { recovery_kind: 'evidence_required', error_code: 'SYNTHESIS_COVERAGE_INCOMPLETE' };
  }
  if (!failure) return { recovery_kind: 'manual_required', error_code: 'DRAFT_BLOCKED' };
  const error_code = isRetryableSynthesisProvenanceFailure(failure)
    ? 'SYNTHESIS_PROVENANCE_INVALID'
    : failureCodeOf(failure);
  if (CONFIG_CODES.has(error_code)) return { recovery_kind: 'config_required', error_code };
  if (RETRYABLE_CODES.has(error_code)) return { recovery_kind: 'retryable', error_code };
  if (EVIDENCE_CODES.has(error_code) || Array.isArray(synthesis?.coverage?.missing)) return { recovery_kind: 'evidence_required', error_code };
  if (PROFILE_CODES.has(error_code)) return { recovery_kind: 'seed_or_profile_required', error_code };
  return { recovery_kind: 'manual_required', error_code };
}

function missingFieldsOf(research, synthesis) {
  const fields = Array.isArray(synthesis?.coverage?.missing) ? synthesis.coverage.missing : [];
  return [...new Set(fields.map(item => `${item.layer}.${item.field}`))];
}

function missingConfigFieldsOf(failure, errorCode) {
  if (errorCode === 'MODEL_REQUIRED') return ['model'];
  if (errorCode === 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED') return ['max_search_queries'];
  if (errorCode === 'COST_BUDGET_EXHAUSTED') {
    const budgetOptions = {
      search_queries: 'max_search_queries',
      pages: 'max_pages',
      responses_calls: 'max_responses_calls',
      synthesis_calls: 'max_synthesis_calls',
    };
    if (budgetOptions[failure?.category]) return [budgetOptions[failure.category]];
    if (/search_queries|搜索请求/i.test(String(failure?.error || ''))) return ['max_search_queries'];
  }
  if (errorCode === 'AI_PROTOCOL_MISMATCH') return ['protocol'];
  if (['RETRIEVAL_PROVIDER_UNSUPPORTED', 'SEARCH_PROVIDER_UNSUPPORTED'].includes(errorCode)) return ['search_provider'];
  if (errorCode === 'SEARCH_FALLBACK_PROVIDER_UNSUPPORTED') return ['search_fallback_provider'];
  if (errorCode === 'EXTRACT_PROVIDER_UNSUPPORTED') return ['extract_provider'];
  if (errorCode === 'EXTRACT_FALLBACK_PROVIDER_UNSUPPORTED') return ['extract_fallback_provider'];
  if (errorCode === 'SEARCH_ENGINE_UNSUPPORTED') return ['search_engine'];
  if (['TAVILY_ACCESS_MODE_REQUIRED', 'TAVILY_SEARCH_AUTH_REQUIRED', 'TAVILY_EXTRACT_AUTH_REQUIRED'].includes(errorCode)) return ['access_mode'];
  return Array.isArray(failure?.missing_config_fields) ? failure.missing_config_fields.filter(field => typeof field === 'string') : [];
}

function suggestedDetailKindOf(failure) {
  return typeof failure?.suggested_detail_kind === 'string' ? failure.suggested_detail_kind : null;
}

function envelopeBlockingReasons(research, synthesis) {
  if (!research?.ok) return [research?.error || research?.code || '研究失败'];
  if (!synthesis?.ok) {
    if (Array.isArray(synthesis?.errors) && synthesis.errors.length) return synthesis.errors.map(item => `${item.path || item.code}: ${item.message || item.code}`);
    return [synthesis?.error || synthesis?.code || '目录合成失败'];
  }
  const missing = (synthesis?.coverage?.missing || []).map(item => `${item.layer}.${item.field}`);
  if (missing.length) return [`缺少必需目录字段: ${[...new Set(missing)].join(', ')}`];
  return [];
}

function failureDetailsOf(research, synthesis, fallbackError) {
  const failure = !research?.ok ? research : !synthesis?.ok ? synthesis : null;
  const classification = classifyFailure(research, synthesis);
  if (!failure) return {
    code: classification.error_code,
    recovery_kind: classification.recovery_kind,
    error: fallbackError,
    missing_fields: missingFieldsOf(research, synthesis),
    missing_config_fields: [],
    suggested_detail_kind: null,
  };
  const details = {
    code: classification.error_code,
    recovery_kind: classification.recovery_kind,
    error: classification.error_code === 'MODEL_REQUIRED' ? '合成模型配置缺失' : (failure.error || fallbackError),
    missing_fields: missingFieldsOf(research, synthesis),
    missing_config_fields: missingConfigFieldsOf(failure, classification.error_code),
    suggested_detail_kind: suggestedDetailKindOf(failure),
  };
  for (const key of ['response_status', 'incomplete_reason', 'output_types', 'output_preview', 'output_keys', 'category', 'requested', 'remaining']) {
    if (failure[key] !== undefined) details[key] = failure[key];
  }
  return details;
}

function buildCatalogDraftEnvelope({ seed, baseRevision, researchPlan, research, synthesis }) {
  const blockingReasons = envelopeBlockingReasons(research, synthesis);
  const ready = blockingReasons.length === 0 && synthesis?.ok === true;
  return {
    schema_version: 4,
    state: ready ? 'preview_ready' : research?.ok ? 'preview_blocked' : 'failed_retryable',
    base_revision: baseRevision,
    seed,
    research_plan: researchPlan,
    research: {
      ok: research?.ok === true,
      official_sources: research?.official_sources || [],
      warnings: research?.warnings || [],
    },
    research_progress: research?.research_progress || null,
    coverage: synthesis?.coverage || null,
    layer_patches: synthesis?.layer_patches || [],
    synthesis: synthesis?.synthesis || null,
    readiness: { status: ready ? 'ready' : 'blocked', blocking_reasons: blockingReasons, warnings: research?.warnings || [] },
    cost: synthesis?.cost || research?.cost || null,
    last_error: ready ? null : failureDetailsOf(research, synthesis, blockingReasons[0] || 'Draft blocked'),
  };
}

function validateCatalogDraftEnvelope(draft) {
  const errors = [];
  if (draft?.schema_version !== 4) return { ok: false, errors: [{ code: 'DRAFT_SCHEMA_UNSUPPORTED', path: 'schema_version', message: '只允许 schema_version=4 的 CatalogDraft Apply' }] };
  if (!draft.research_plan || !Array.isArray(draft.research_plan.research_scopes)) errors.push({ code: 'RESEARCH_PLAN_MISSING', path: 'research_plan', message: '缺少 ResearchPlan' });
  if (draft.seed?.detail_kind === 'api_model' && draft.research_plan?.profile?.modality) {
    const expectedModality = inferModality(draft.seed);
    if (draft.research_plan.profile.modality !== expectedModality) {
      errors.push({ code: 'DRAFT_PROFILE_MODALITY_MISMATCH', path: 'research_plan.profile.modality', message: `Draft 按 ${draft.research_plan.profile.modality} 规划，但候选应按 ${expectedModality} 处理` });
    }
  }
  const sources = draft.research?.official_sources || [];
  const sourceIds = new Set();
  for (const source of sources) {
    if (!source?.source_id || !source?.url || sourceIds.has(source.source_id)) errors.push({ code: 'SOURCE_ID_INVALID', path: 'research.official_sources', message: `source_id 缺失或重复: ${source?.source_id || ''}` });
    sourceIds.add(source?.source_id);
  }
  const recomputed = fieldCoverageOf(draft.synthesis, draft.research_plan);
  if (draft.readiness?.status === 'ready' && recomputed.missing.length) errors.push({ code: 'READINESS_MISMATCH', path: 'readiness.status', message: `仍缺少字段: ${recomputed.missing.map(item => `${item.layer}.${item.field}`).join(', ')}` });
  if (draft.readiness?.status === 'ready' && !Array.isArray(draft.layer_patches)) errors.push({ code: 'LAYER_PATCHES_MISSING', path: 'layer_patches', message: 'ready Draft 必须包含 LayerPatches' });
  const recordsByArea = {};
  for (const patch of draft.layer_patches || []) {
    if (patch.operation === 'noop') continue;
    if (!patch.record || patch.record.id !== patch.id) errors.push({ code: 'PATCH_RECORD_INVALID', path: `${patch.area}:${patch.id}`, message: 'Patch record 缺失或 id 不匹配' });
    else {
      (recordsByArea[patch.area] ||= []).push(patch.record);
      for (const field of Object.keys(patch.record)) if (!patch.provenance?.[field]) errors.push({ code: 'PATCH_PROVENANCE_MISSING', path: `${patch.area}:${patch.id}.${field}`, message: '字段缺少 provenance' });
    }
  }
  const strict = validatePlannedRecords(recordsByArea);
  errors.push(...strict.errors);
  return {
    ok: errors.length === 0,
    errors,
    recomputed_missing: [...new Set(recomputed.missing.map(item => `${item.layer}.${item.field}`))],
  };
}

module.exports = {
  buildCatalogDraftEnvelope,
  validateCatalogDraftEnvelope,
  classifyFailure,
  failureCodeOf,
  isRetryableSynthesisProvenanceFailure,
  normalizeGatewayErrorCode,
};
