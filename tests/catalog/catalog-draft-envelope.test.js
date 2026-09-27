'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalogDraftEnvelope, validateCatalogDraftEnvelope, classifyFailure, normalizeGatewayErrorCode } = require('../../src/catalog/draft/index');

function plan() {
  return {
    schema_version: 1,
    seed: { detail_kind: 'api_model', modality: 'video', name: 'X', vendor_name: 'V' },
    research_scopes: [{ kind: 'detail', subject: { kind: 'detail', key: 'x' }, predicates: ['api_available'] }],
    layer_plan: { 'tool-level3': { area: 'tool-level3', id: 'tool-level3:x', operation: 'create' } },
    profile: { key: 'api_model:video', detail_kind: 'api_model', modality: 'video' },
    applicability: { one_m_context: 'not_applicable', api_pricing: 'required', plan: 'not_applicable' },
  };
}

function fullDetailFields() {
  return {
    summary: '可灵是视频生成平台。',
    official_url: 'https://kling.ai',
    detail_status: 'active',
    access_level: '开放',
    price_badge: 'usage_based',
    scenes: ['短视频生成'],
    best_for_preview: '适合短视频创作。',
    not_for_preview: '不适合超长视频。',
    api_pricing: { status: 'available', rate_cards: [{ label: '生成', pricing_basis: 'generation', currency: 'CREDIT', metrics: [{ label: '标准', amount: 1, unit: 'generation' }], conditions: '官方说明' }] },
    applicable_scenarios: [{ title: '短视频', description: '短视频创作。' }],
    inapplicable_scenarios: [{ title: '长视频', description: '超长视频不适合。' }],
    release_date: '2025-12-03',
  };
}

function research(sourceOverrides = {}) {
  return {
    ok: true,
    official_sources: [{ source_id: 's1', url: 'https://example.com', title: 'Official', excerpt: 'API is available.', content: 'API is available.', ...sourceOverrides }],
    warnings: [],
    cost: { limits: {}, spent: {}, remaining: {} },
  };
}

function synthesis(missing = []) {
  const detail = fullDetailFields();
  const provenance = {};
  for (const field of Object.keys(detail)) provenance[`detail.${field}`] = ['s1'];
  const missingFields = [];
  for (const field of missing) {
    delete detail[field];
    delete provenance[`detail.${field}`];
    missingFields.push(field);
  }
  return {
    ok: true,
    layer_patches: [{ area: 'tool-level3', id: 'tool-level3:x', operation: 'noop', record: null, provenance: {} }],
    synthesis: { layer_fields: { detail }, provenance },
    coverage: { entries: [], covered: [], missing: missingFields.map(field => ({ layer: 'detail', field })) },
    cost: { limits: {}, spent: {}, remaining: {} },
  };
}

test('draft envelope is ready only when field coverage and layer patches are valid', () => {
  const envelope = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research(), synthesis: synthesis() });
  assert.equal(envelope.schema_version, 4);
  assert.equal(envelope.state, 'preview_ready');
  assert.equal(envelope.readiness.status, 'ready');
  assert.equal(envelope.coverage.missing.length, 0);
  assert.equal(validateCatalogDraftEnvelope(envelope).ok, true);
});

test('field coverage gap creates preview_blocked envelope and cannot be relabeled ready', () => {
  const envelope = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research(), synthesis: synthesis(['access_level']) });
  assert.equal(envelope.state, 'preview_blocked');
  assert.equal(envelope.readiness.status, 'blocked');
  const forged = { ...envelope, readiness: { status: 'ready', blocking_reasons: [], warnings: [] } };
  const checked = validateCatalogDraftEnvelope(forged);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(error => error.code === 'READINESS_MISMATCH'));
  assert.ok(checked.recomputed_missing.includes('detail.access_level'));
});

test('ready Draft with a stale text profile cannot pass review after modality inference changes', () => {
  const ready = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research(), synthesis: synthesis() });
  const stale = {
    ...ready,
    seed: { ...ready.seed, name: 'StepAudio 3 ASR', modality: undefined },
    research_plan: {
      ...ready.research_plan,
      seed: { ...ready.research_plan.seed, name: 'StepAudio 3 ASR', modality: undefined },
      profile: { ...ready.research_plan.profile, key: 'api_model:text', modality: 'text' },
    },
  };
  const checked = validateCatalogDraftEnvelope(stale);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(error => error.code === 'DRAFT_PROFILE_MODALITY_MISMATCH'));
});

test('failed research preserves bounded failure diagnostics', () => {
  const envelope = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: {
      ...research(),
      ok: false,
      code: 'TAVILY_SEARCH_FAILED',
      error: 'Tavily 搜索失败',
      response_status: 'error',
      output_types: ['message'],
      output_preview: 'x'.repeat(1200),
    },
    synthesis: null,
  });
  assert.equal(envelope.last_error.code, 'TAVILY_SEARCH_FAILED');
  assert.equal(envelope.last_error.response_status, 'error');
  assert.equal(envelope.last_error.output_preview.length, 1200);
});

test('search auth and provider config failures remain config-recoverable', () => {
  for (const code of ['TAVILY_SEARCH_AUTH_REQUIRED', 'TAVILY_EXTRACT_AUTH_REQUIRED', 'ZHIPU_WEB_SEARCH_AUTH_REQUIRED', 'SEARCH_FALLBACK_PROVIDER_UNSUPPORTED']) {
    assert.equal(classifyFailure({ ok: false, code }, null).recovery_kind, 'config_required', code);
  }
});

test('provider transport and research/planner failures retain a recovery path', () => {
  for (const code of ['OPENROUTER_TIMEOUT', 'CUSTOM_GATEWAY_RATE_LIMITED', 'LOCAL_AI_PROVIDER_ERROR', 'OPENAI_COMPAT_SCHEMA_INVALID', 'RESEARCH_FAILED', 'RESEARCH_DISCOVER_FAILED', 'RESEARCH_ACQUIRE_FAILED', 'PLANNER_FAILED']) {
    assert.equal(classifyFailure({ ok: false, code }, null).recovery_kind, 'retryable', code);
  }
  assert.equal(normalizeGatewayErrorCode('OPENROUTER_TIMEOUT'), 'TIMEOUT');
  assert.equal(normalizeGatewayErrorCode('CUSTOM_GATEWAY_RATE_LIMITED'), 'RATE_LIMITED');
  assert.equal(normalizeGatewayErrorCode('OPENAI_COMPAT_SCHEMA_INVALID'), 'SCHEMA_INVALID');
  assert.equal(normalizeGatewayErrorCode('TAVILY_EXTRACT_RATE_LIMITED'), 'TAVILY_EXTRACT_RATE_LIMITED');
  assert.equal(classifyFailure({ ok: false, code: 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED' }, null).recovery_kind, 'config_required');

  const budgetBlocked = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: { ok: false, code: 'WEB_SEARCH_REQUEST_BUDGET_EXCEEDED', error: '搜索请求预算不足' },
    synthesis: null,
  });
  assert.equal(budgetBlocked.last_error.recovery_kind, 'config_required');
  assert.deepEqual(budgetBlocked.last_error.missing_config_fields, ['max_search_queries']);

  const pageBudgetBlocked = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: { ok: false, code: 'COST_BUDGET_EXHAUSTED', category: 'pages', requested: 2, remaining: 0, error: 'pages 成本预算不足' },
    synthesis: null,
  });
  assert.deepEqual(pageBudgetBlocked.last_error.missing_config_fields, ['max_pages']);
  assert.equal(pageBudgetBlocked.last_error.category, 'pages');
  assert.equal(classifyFailure({ ok: false, code: 'SYNTHESIS_INVALID', error: 'detail.release_date: 派生字段必须引用至少一个官方来源' }, null).recovery_kind, 'retryable');
  assert.equal(classifyFailure({ ok: false, code: 'SYNTHESIS_INVALID', error: 'tool-level3.pricing_disclosure.source_urls: 价格说明来源必须匹配 ResearchResult 官方来源' }, null).recovery_kind, 'manual_required');
});

test('draft envelope rejects missing or duplicate source_ids', () => {
  const missingId = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research({ source_id: '' }), synthesis: synthesis() });
  assert.ok(validateCatalogDraftEnvelope(missingId).errors.some(error => error.code === 'SOURCE_ID_INVALID'));

  const duplicate = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: {
      ...research(),
      official_sources: [
        { source_id: 's1', url: 'https://example.com', title: 'A', excerpt: 'x', content: 'x' },
        { source_id: 's1', url: 'https://example.com/other', title: 'B', excerpt: 'x', content: 'x' },
      ],
    },
    synthesis: synthesis(),
  });
  assert.ok(validateCatalogDraftEnvelope(duplicate).errors.some(error => error.code === 'SOURCE_ID_INVALID'));
});

test('legacy draft schemas are blocked from the new Apply path', () => {
  const checked = validateCatalogDraftEnvelope({ schema_version: 2, readiness: { status: 'ready' } });
  assert.equal(checked.ok, false);
  assert.equal(checked.errors[0].code, 'DRAFT_SCHEMA_UNSUPPORTED');
});
