'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOfficialDiscoveryQuery } = require('../../src/catalog/intake/index');
const { deriveKeys } = require('../../src/catalog/core/catalog-record-builders');
const {
  synthesizeLayerFields,
  revisionOf,
  previewHashOf,
  emptySnapshot,
  buildDetail,
  buildToolCard,
  buildLevel2,
  validatePlannedRecords,
  validateCatalogSnapshot,
} = require('../../src/catalog/core/index');

test('deriveKeys 保留数字版本点号', () => {
  const keys = deriveKeys({ vendor_name: 'Anthropic', name: 'Claude Fable 5.1', group_key: 'Claude 最新系列', detail_key: 'claude-fable-5.1' });
  assert.equal(keys.toolKey, 'claude-fable-5.1');
  assert.equal(keys.detailKey, 'claude-fable-5.1');
});

function fakeResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

test('v3 discovery query expands API video pricing terms from predicates', () => {
  const query = buildOfficialDiscoveryQuery({
    plan: {
      seed: {
        name: 'Kling 2.6 Pro',
        vendor_name: '可灵',
        discovery_sources: [{ url: 'https://kling.ai/developer' }],
      },
      profile: { modality: 'video' },
    },
    scope: { kind: 'detail' },
    missing_predicates: ['api_available', 'price_rate', 'max_duration', 'output_resolution', 'audio_capability'],
  });
  assert.match(query, /developer API OpenAPI/);
  assert.match(query, /pricing credits/);
  assert.match(query, /billing price/);
  assert.match(query, /duration resolution audio languages/);
  assert.doesNotMatch(query, /site:/);
});

test('v3 synthesis adapter uses object JSON mode and reserves synthesis plus response budgets', async () => {
  const payloads = [];
  const reservations = [];
  const fetchImpl = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return fakeResponse({
      output_text: JSON.stringify({
        layer_fields: { detail: { summary: '可灵 2.6 Pro' } },
        provenance: { 'detail.summary': ['source-1'] },
        missing: [],
      }),
    });
  };
  const result = await synthesizeLayerFields({
    plan: { profile: { detail_kind: 'api_model', modality: 'video' }, applicability: {}, research_scopes: [] },
    expected_layer_fields: { detail: ['summary'] },
    research: { official_sources: [{ source_id: 'source-1', url: 'https://kling.ai', title: 'Kling', content: 'facts', discovered_for: ['detail:kling-2-6-pro'] }] },
    ledger: { reserve(category, amount) { reservations.push([category, amount]); return { ok: true }; } },
  }, { provider: 'deepseek', apiKey: 'test-key', fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.layer_fields.detail.summary, '可灵 2.6 Pro');
  assert.deepEqual(reservations, [['synthesis_calls', 1], ['responses_calls', 1]]);
  assert.deepEqual(payloads[0].reasoning, { effort: 'none' });
  assert.deepEqual(payloads[0].text, { format: { type: 'json_object' } });
  assert.match(payloads[0].instructions, /expected_layer_fields/);
  assert.match(payloads[0].instructions, /missing/);
  assert.match(payloads[0].input, /"layers"/);
});

test('v3 synthesis repair prefers matching seed evidence for official date', async () => {
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.match(payload.instructions, /seed_official_hint/);
    assert.match(payload.input, /2025-07-07/);
    return fakeResponse({
      output_text: JSON.stringify({
        layer_fields: { detail: { last_updated_date: '2026-02-16' } },
        provenance: { 'detail.last_updated_date': ['source-latest'] },
        missing: [],
      }),
    });
  };
  const result = await synthesizeLayerFields({
    plan: {
      seed: { repair_layers: ['tool-level3'], repair_note: '修复 last_updated_date 为 2025-07-07。' },
      profile: { detail_kind: 'tool', modality: 'general' },
      applicability: {},
      research_scopes: [],
    },
    expected_layer_fields: { detail: ['last_updated_date'] },
    research: {
      official_sources: [{
        source_id: 'source-release',
        source_role: 'seed_official_hint',
        url: 'https://augmentcode.com/release',
        title: 'Release notes',
        content: 'July 7, 2025',
        discovered_for: ['detail:augment-code'],
      }],
    },
    ledger: { reserve() { return { ok: true }; } },
  }, { provider: 'deepseek', apiKey: 'test-key', fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.layer_fields.detail.last_updated_date, '2025-07-07');
  assert.deepEqual(result.provenance['detail.last_updated_date'], ['source-release']);
});

test('revision and preview hashes are deterministic', () => {
  const snapshot = emptySnapshot();
  assert.equal(revisionOf(snapshot), revisionOf(JSON.parse(JSON.stringify(snapshot))));
  assert.equal(previewHashOf({ b: 1, a: 2 }), previewHashOf({ a: 2, b: 1 }));
});

// ---- S1c：统一模型键/系列字段契约（builders + completeness + snapshot-validator）----

function assertThrowsCode(fn, code) {
  assert.throws(fn, error => error.message.startsWith(code), `期望抛出 ${code}`);
}

function baseDetailFields(detailKind, title = 'Kling 2.6 Pro') {
  return {
    vendorKey: 'kuaishou',
    detailKind,
    title,
    vendorLabel: '可灵',
    summary: '音画同步视频生成模型。',
    applicableScenarios: [{ title: '短视频', description: '适合。' }],
    sources: [],
  };
}

function baseCardFields(detailKind, title = 'Kling 2.6 Pro') {
  return {
    toolKey: 'kling-2-6-pro',
    vendorKey: 'kuaishou',
    title,
    vendorLabel: '可灵',
    summary: '音画同步视频生成模型。',
    theme: 'media',
    detailId: 'tool-level3:kling-2-6-pro',
    detailKind,
  };
}

test('buildDetail requires model_key for api_model and rejects it elsewhere', () => {
  assertThrowsCode(() => buildDetail(baseDetailFields('api_model')), 'MODEL_KEY_REQUIRED:Kling 2.6 Pro');
  assertThrowsCode(() => buildDetail({ ...baseDetailFields('tool'), modelKey: 'kuaishou-kling-2.6-pro' }), 'MODEL_KEY_NOT_APPLICABLE');
  assertThrowsCode(() => buildDetail({ ...baseDetailFields('api_model'), modelKey: 'Kling 2.6' }), 'MODEL_KEY_SYNTAX_INVALID');

  const detail = buildDetail({ ...baseDetailFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro' });
  assert.equal(detail.model_key, 'kuaishou-kling-2.6-pro');
  assert.equal('visibility' in detail, false);
  assert.equal('historical_since' in detail, false);

  const plain = buildDetail(baseDetailFields('tool'));
  assert.equal('model_key' in plain, false);
});

test('buildDetail accepts hidden_history marking without rewriting existing fields', () => {
  const detail = buildDetail({ ...baseDetailFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro', visibility: 'hidden_history', historicalSince: '2026-09-01' });
  assert.equal(detail.visibility, 'hidden_history');
  assert.equal(detail.historical_since, '2026-09-01');
  assertThrowsCode(() => buildDetail({ ...baseDetailFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro', visibility: 'archived' }), 'VISIBILITY_INVALID');
});

test('buildToolCard mirrors model_key gating of buildDetail', () => {
  assertThrowsCode(() => buildToolCard(baseCardFields('api_model')), 'MODEL_KEY_REQUIRED:Kling 2.6 Pro');
  assertThrowsCode(() => buildToolCard({ ...baseCardFields('tool'), modelKey: 'kuaishou-kling-2.6-pro' }), 'MODEL_KEY_NOT_APPLICABLE');
  const card = buildToolCard({ ...baseCardFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro' });
  assert.equal(card.model_key, 'kuaishou-kling-2.6-pro');
  const plain = buildToolCard(baseCardFields('tool'));
  assert.equal('model_key' in plain, false);
});

test('buildLevel2 requires valid series_kind and gates generation_state to model_series', () => {
  const base = { vendorKey: 'kuaishou', level1Id: 'vendor-level1:kuaishou', groupKey: 'kling', title: 'Kling', summary: '系列。', status: 'active' };
  assertThrowsCode(() => buildLevel2(base), 'SERIES_KIND_REQUIRED');
  assertThrowsCode(() => buildLevel2({ ...base, seriesKind: 'series' }), 'SERIES_KIND_INVALID:series');
  const level2 = buildLevel2({ ...base, seriesKind: 'model_series', generationState: 'newest' });
  assert.equal(level2.series_kind, 'model_series');
  assert.equal(level2.generation_state, 'newest');
  const plain = buildLevel2({ ...base, seriesKind: 'tool_series' });
  assert.equal(plain.series_kind, 'tool_series');
  assert.equal('generation_state' in plain, false);
  assertThrowsCode(() => buildLevel2({ ...base, seriesKind: 'tool_series', generationState: 'newest' }), 'GENERATION_STATE_NOT_APPLICABLE:tool_series');
  assertThrowsCode(() => buildLevel2({ ...base, seriesKind: 'model_series', generationState: 'current' }), 'GENERATION_STATE_INVALID:current');
});

test('validatePlannedRecords exempts conditional fields but keeps api_model model_key required', () => {
  const detail = buildDetail({ ...baseDetailFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro' });
  const card = buildToolCard({ ...baseCardFields('api_model'), modelKey: 'kuaishou-kling-2.6-pro' });
  const ok = validatePlannedRecords({
    'tool-level3': [{ ...detail, id: 'tool-level3:kling-2-6-pro' }],
    'tool-card': [{ ...card, id: 'tool-card:kling-2-6-pro' }],
  });
  assert.equal(ok.errors.some(error => error.code === 'MODEL_KEY_REQUIRED'), false, JSON.stringify(ok.errors));
  assert.equal(ok.errors.some(error => error.code === 'GENERATED_FIELD_MISSING' && error.path.includes('model_key')), false, '条件字段豁免无条件必填');
  assert.equal(ok.errors.some(error => error.code === 'GENERATED_FIELD_MISSING' && error.path.includes('visibility')), false);

  const missingKey = validatePlannedRecords({
    'tool-level3': [{ ...detail, id: 'tool-level3:x', model_key: undefined }],
  });
  assert.ok(missingKey.errors.some(error => error.code === 'MODEL_KEY_REQUIRED'), JSON.stringify(missingKey.errors));
  assert.ok(!missingKey.errors.some(error => error.code === 'GENERATED_FIELD_MISSING' && error.path.includes('model_key')), '条件字段不得触发无条件必填');

  const hiddenWithoutDate = validatePlannedRecords({
    'tool-level3': [{ ...detail, id: 'tool-level3:x', visibility: 'hidden_history', historical_since: undefined }],
  });
  assert.ok(hiddenWithoutDate.errors.some(error => error.code === 'HISTORY_DATE_REQUIRED'));
});

function minimalSnapshot({ detail, card, level2 }) {
  return {
    'vendor-card': [],
    'tool-card': [card],
    'vendor-level1': [],
    'vendor-level2': level2 ? [level2] : [],
    'tool-level3': [detail],
  };
}

function legacyPair(overrides = {}) {
  const detail = {
    id: 'tool-level3:legacy-tool',
    vendor_key: 'legacy-vendor',
    detail_kind: 'tool',
    theme: 'dev',
    title: 'Legacy Tool',
    official_url: 'https://example.com/legacy',
    sources: [],
  };
  const card = {
    id: 'tool-card:legacy-tool',
    tool_key: 'legacy-tool',
    vendor_key: 'legacy-vendor',
    title: 'Legacy Tool',
    theme: 'dev',
    detail_kind: 'tool',
    detail_ref: { kind: 'tool-level3', id: detail.id },
  };
  return { detail: { ...detail, ...overrides.detail }, card: { ...card, ...overrides.card } };
}

test('snapshot validator keeps legacy records free of new-field errors', () => {
  const { detail, card } = legacyPair();
  const result = validateCatalogSnapshot(minimalSnapshot({ detail, card }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('snapshot validator enforces model key syntax, duplicates, and card mismatch', () => {
  const badSyntax = legacyPair({ detail: { model_key: 'Legacy Tool' }, card: { model_key: 'Legacy Tool' } });
  const syntaxResult = validateCatalogSnapshot(minimalSnapshot(badSyntax));
  assert.ok(syntaxResult.errors.some(error => error.code === 'MODEL_KEY_SYNTAX_INVALID'));

  const dupA = legacyPair({ detail: { id: 'tool-level3:dup-a', model_key: 'legacy-vendor-same' }, card: { id: 'tool-card:dup-a', tool_key: 'dup-a', detail_ref: { kind: 'tool-level3', id: 'tool-level3:dup-a' } } });
  const dupB = legacyPair({ detail: { id: 'tool-level3:dup-b', model_key: 'legacy-vendor-same' }, card: { id: 'tool-card:dup-b', tool_key: 'dup-b', detail_ref: { kind: 'tool-level3', id: 'tool-level3:dup-b' } } });
  const dupResult = validateCatalogSnapshot({ 'vendor-card': [], 'tool-card': [dupA.card, dupB.card], 'vendor-level1': [], 'vendor-level2': [], 'tool-level3': [dupA.detail, dupB.detail] });
  assert.ok(dupResult.errors.some(error => error.code === 'MODEL_KEY_DUPLICATE' && error.message.includes('legacy-vendor-same')));

  const mismatch = legacyPair({ detail: { model_key: 'legacy-vendor-one' }, card: { model_key: 'legacy-vendor-two' } });
  const mismatchResult = validateCatalogSnapshot(minimalSnapshot(mismatch));
  assert.ok(mismatchResult.errors.some(error => error.code === 'CARD_MODEL_KEY_MISMATCH'));
});

test('snapshot validator enforces visibility and series enums plus history rules', () => {
  const { detail, card } = legacyPair({ detail: { visibility: 'archived' } });
  assert.ok(validateCatalogSnapshot(minimalSnapshot({ detail, card })).errors.some(error => error.code === 'VISIBILITY_INVALID'));

  const { detail: historyDetail, card: historyCard } = legacyPair({ detail: { visibility: 'hidden_history' }, card: { visibility: 'hidden_history' } });
  assert.ok(validateCatalogSnapshot(minimalSnapshot({ detail: historyDetail, card: historyCard })).errors.some(error => error.code === 'HISTORY_DATE_REQUIRED'));

  const orphan = legacyPair({ detail: { visibility: 'visible' } });
  assert.ok(validateCatalogSnapshot(minimalSnapshot(orphan)).errors.some(error => error.code === 'L3_ORPHAN'));

  const level2 = {
    id: 'vendor-level2:legacy-vendor:group',
    level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:legacy-vendor' },
    vendor_key: 'legacy-vendor',
    title: 'Group',
    summary: 'S',
    status: 'active',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:legacy-tool' }],
  };
  const badSeries = validateCatalogSnapshot(minimalSnapshot({ detail: orphan.detail, card: orphan.card, level2: { ...level2, series_kind: 'family' } }));
  assert.ok(badSeries.errors.some(error => error.code === 'SERIES_KIND_INVALID'));
  const badGeneration = validateCatalogSnapshot(minimalSnapshot({ detail: orphan.detail, card: orphan.card, level2: { ...level2, series_kind: 'model_series', generation_state: 'current' } }));
  assert.ok(badGeneration.errors.some(error => error.code === 'GENERATION_STATE_INVALID'));

  const historyReferenced = legacyPair({
    detail: { visibility: 'hidden_history', historical_since: '2026-09-01' },
    card: { visibility: 'hidden_history' },
  });
  const hiddenRefs = validateCatalogSnapshot(minimalSnapshot({ detail: historyReferenced.detail, card: historyReferenced.card, level2: { ...level2, series_kind: 'model_series' } }));
  assert.ok(hiddenRefs.errors.some(error => error.code === 'HISTORY_STILL_REFERENCED'));

  const valid = validateCatalogSnapshot(minimalSnapshot({
    detail: { ...orphan.detail, visibility: 'visible' },
    card: orphan.card,
    level2: { ...level2, series_kind: 'model_series' },
  }));
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
});

test('same-name level2 and level3 records are both legal', () => {
  const { detail, card } = legacyPair();
  const level2 = {
    id: 'vendor-level2:legacy-vendor:legacy-tool',
    level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:legacy-vendor' },
    vendor_key: 'legacy-vendor',
    title: 'Legacy Tool',
    summary: '同名二级系列与三级模型。',
    status: 'active',
    series_kind: 'model_series',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:legacy-tool' }],
  };
  const result = validateCatalogSnapshot(minimalSnapshot({ detail, card, level2 }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.errors.some(error => error.message.includes('同名') || error.code === 'TITLE_DUPLICATE'), false);
});
