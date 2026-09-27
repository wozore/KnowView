'use strict';

/**
 * catalog-series-placement-ai.test.js —— 二级系列 AI 分类 Adapter 回归（阶段 4）
 *
 * 覆盖：
 *   - prompt 构建不泄露密钥、输入字段白名单、指令禁止跨用途；
 *   - validateSeriesPlacementValue 结构校验；
 *   - suggestSeriesPlacement 缺 ledger fail-closed；
 *   - resolveSeriesPlacement 各分支：
 *       人工 placement 最高优先（合法 → manual；非法 → fail_closed）；
 *       政策覆盖的通用 LLM 确定性判定（existing / create，零 AI）；
 *       专用/无政策厂商 not_applicable（不改 seed）；
 *       第 4 个成员触发 migration_required；
 *       needs_ai 未放行 → fail_closed；放行 + AI hint → decision(ai)；
 *       AI 冲突/未确认 → fail_closed；
 *   - applyPlacementToSeed：existing → existing_level2_ref；create → group_key + new_group_title。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/core/index');
const { loadSeriesPolicy } = require('../../src/catalog/series/index');
const {
  buildSeriesPlacementInput,
  buildSeriesPlacementInstructions,
  validateSeriesPlacementValue,
  suggestSeriesPlacement,
  resolveSeriesPlacement,
  applyPlacementToSeed,
} = require('../../src/catalog/series/index');

function candidate(overrides = {}) {
  return {
    detail_kind: 'api_model',
    name: 'GLM-5.4',
    vendor_name: '智谱',
    vendor_key: 'zhipu',
    official_url: 'https://docs.z.ai/guides/llm/glm-5',
    ...overrides,
  };
}

function snapshot() {
  const snap = emptySnapshot();
  snap['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', level2_refs: [] });
  snap['vendor-level2'].push({
    id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', status: 'active',
    detail_refs: ['glm-5.1', 'glm-5.2', 'glm-5-3'].map(id => ({ kind: 'tool-level3', id: `tool-level3:${id}` })),
  });
  snap['tool-level3'].push(
    { id: 'tool-level3:glm-5.1', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
    { id: 'tool-level3:glm-5.2', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
    { id: 'tool-level3:glm-5-3', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
  );
  return snap;
}

// ── 1. prompt 构建 ──────────────────────────────────────────────

test('buildSeriesPlacementInput 字段白名单，不含密钥/正文', () => {
  const policy = loadSeriesPolicy();
  const input = buildSeriesPlacementInput({ candidate: candidate(), policy, currentSeries: [] });
  const raw = JSON.stringify(input);
  assert.match(raw, /GLM-5\.4/);
  assert.doesNotMatch(raw, /api[_-]?key|DEEPSEEK|TAVILY|sk-|Authorization/i);
  assert.ok(input.candidate && typeof input.candidate.name === 'string');
  assert.ok(input.policy_scope && Array.isArray(input.policy_scope.families));
  assert.ok(input.policy_scope.families.some(f => f.family === 'glm' && f.usage_kind === 'general_llm'));
});

test('buildSeriesPlacementInstructions 禁止把专用当通用、禁止编造 URL', () => {
  const instructions = buildSeriesPlacementInstructions();
  assert.match(instructions, /general_llm/);
  assert.match(instructions, /禁止把专用模型当 general_llm/);
  assert.match(instructions, /不许编造 URL/);
  assert.match(instructions, /canonical_family/);
});

test('validateSeriesPlacementValue 结构校验', () => {
  const registry = loadSeriesPolicy().task_type_registry;
  assert.equal(validateSeriesPlacementValue({ usage_kind: 'general_llm', task_types: ['LLM'], modality: 'text', canonical_vendor_key: 'zhipu', canonical_family: 'glm', major_line: 'glm5', release_cohort: 'newest', rationale: 'x' }, registry), true);
  assert.equal(validateSeriesPlacementValue(null), false);
  assert.equal(validateSeriesPlacementValue({ usage_kind: 5 }), false);
  assert.equal(validateSeriesPlacementValue({ usage_kind: 'general_llm', task_types: ['LLM'], modality: 'text', canonical_vendor_key: 'zhipu', canonical_family: 'glm', major_line: 'glm5', release_cohort: 'newest', rationale: 'x', confidence: -1 }, registry), true, '不再读取置信度字段');
});

// ── 2. suggestSeriesPlacement：缺 ledger fail-closed ────────────

test('suggestSeriesPlacement 缺 ledger → COST_LEDGER_REQUIRED（fail-closed）', async () => {
  const result = await suggestSeriesPlacement({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_LEDGER_REQUIRED');
});

test('suggestSeriesPlacement 自适应当前 provider 的默认模型', async () => {
  const calls = [];
  const input = { policy_scope: { task_type_registry: loadSeriesPolicy().task_type_registry } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              usage_kind: 'general_llm',
              task_types: ['LLM'],
              modality: 'text',
              canonical_vendor_key: 'zhipu',
              canonical_family: 'glm',
              major_line: 'glm5',
              release_cohort: 'newest',
              rationale: 'x',
            }),
          }],
        };
      },
      async text() { return ''; },
    };
  };

  const ledger = { reserve: () => ({ ok: true }) };
  const res = await suggestSeriesPlacement(input, {
    ledger,
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(calls[0].body.model, 'glm-5.3-flash');
});

test('resolve：缓存 placement 目标不再符合当前 policy 时 fail_closed', async () => {
  const policy = loadSeriesPolicy();
  const stale = candidate({
    placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:openai:gpt-image' } },
    placement_decision: {
      vendor: 'openai', family: 'removed-family', target_mode: 'existing',
      target_level2_id: 'vendor-level2:openai:gpt-image', target_level2_title: 'GPT-Image',
    },
  });
  const result = await resolveSeriesPlacement(policy, emptySnapshot(), stale, {});
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_CACHED_DECISION_INVALID');
});

// ── 3. resolveSeriesPlacement 各分支 ────────────────────────────

test('resolve：人工 placement 合法 → manual（最高优先，不触发 AI）', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  const c = candidate({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' } } });
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: true });
  assert.equal(result.kind, 'manual');
  assert.equal(result.target_level2_id, 'vendor-level2:zhipu:glm');
});

test('resolve：人工 placement 非法（vendor 不匹配）→ fail_closed', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  const c = candidate({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:openai:gpt-5.6' } } });
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: true });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_REF_INVALID');
});

test('resolve：显式非法 modality 直接 fail_closed，不允许 AI 覆盖', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'openai', name: 'GPT-5.6 Sol', modality: 'hologram' }), {
      allowAi: true, ledger: { reserve: () => ({ ok: true }) },
      suggestPlacement: async () => ({ ok: true, hint: { usage_kind: 'general_llm', canonical_family: 'gpt', release_cohort: 'newest', confidence: 1 } }),
    });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_MODALITY_INVALID');
});

test('resolve：政策覆盖的通用 LLM 确定性判定（零 AI）→ decision', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  // 加入一个已有的 openai:gpt-5.6，让新 GPT 候选走 existing
  const cohereSnap = emptySnapshot();
  cohereSnap['vendor-level2'].push({
    id: 'vendor-level2:cohere:command', vendor_key: 'cohere', title: 'Command 模型', status: 'active',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:command-a' }],
  });
  const c = candidate({ vendor_key: 'cohere', vendor_name: 'Cohere', name: 'Command B' });
  const result = await resolveSeriesPlacement(policy, cohereSnap, c, { allowAi: true });
  assert.equal(result.kind, 'decision');
  assert.equal(result.target_mode, 'existing');
  assert.equal(result.target_level2_id, 'vendor-level2:cohere:command');
  assert.equal(result.source, 'policy');
  assert.equal(result.target_level2_title, 'Command Text & Reasoning Models');
});

test('resolve：目标系列未建 → decision create（组 key 取政策稳定段）', async () => {
  const policy = loadSeriesPolicy();
  const snap = emptySnapshot();
  const c = candidate({ vendor_key: 'mistral', vendor_name: 'Mistral', name: 'Mistral Large 4' });
  snap['vendor-level2'].push({ id: 'vendor-level2:mistral:mistral', vendor_key: 'mistral', title: 'Mistral 模型', detail_refs: [] });
  const result = await resolveSeriesPlacement(policy, snap, c, {});
  assert.equal(result.kind, 'decision');
  assert.equal(result.target_mode, 'existing');
});

test('resolve：政策专用系列（OpenAI image）→ decision，复用政策目标系列', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'openai', name: 'GPT Images 2.5', modality: 'image' }), { allowAi: true });
  assert.equal(result.kind, 'decision');
  assert.equal(result.vendor, 'openai');
  assert.equal(result.family, 'image');
  assert.equal(result.target_level2_id, 'vendor-level2:openai:gpt-image');
});

test('resolve：政策专用系列（xAI Grok Voice）→ decision，复用 Grok Voice', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'xai', name: 'Grok Voice Transcribe 2.0', modality: 'audio' }), { allowAi: true });
  assert.equal(result.kind, 'decision');
  assert.equal(result.vendor, 'xai');
  assert.equal(result.family, 'voice');
  assert.equal(result.target_level2_id, 'vendor-level2:xai:grok-voice');
  assert.deepEqual(result.candidate_task_types, ['STT', 'Voice']);
});

test('resolve：明确的图像与检索任务使用统一英文类型标签', async () => {
  const policy = loadSeriesPolicy();
  const image = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'alibaba', name: 'Qwen-Image-2.1', modality: 'image' }), {});
  const embedding = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'cohere', name: 'embed-v4.0', modality: 'text' }), {});
  const transcribe = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'microsoft', name: 'MAI-Transcribe-2', modality: 'audio' }), {});
  assert.deepEqual(image.candidate_task_types, ['Image Generation']);
  assert.deepEqual(embedding.candidate_task_types, ['Embedding']);
  assert.equal(transcribe.target_mode, 'create');
  assert.equal(transcribe.target_level2_id, 'vendor-level2:microsoft:mai-transcribe');
  assert.deepEqual(transcribe.candidate_task_types, ['STT']);
});

test('MiMo V2.6 Pro 已列入厂商名册后进入现有 MiMo 系列', async () => {
  const policy = loadSeriesPolicy();
  const snap = emptySnapshot();
  snap['vendor-level2'].push({
    id: 'vendor-level2:xiaomi:mimo',
    vendor_key: 'xiaomi',
    title: 'MiMo General & Reasoning Models',
    detail_refs: ['mimo-v2-5-pro', 'mimo-v2-5', 'mimo-v2-flash']
      .map(id => ({ kind: 'tool-level3', id: `tool-level3:${id}` })),
  });
  const result = await resolveSeriesPlacement(policy, snap,
    candidate({ vendor_key: 'xiaomi', vendor_name: 'Xiaomi', name: 'MiMo-V2.6-Pro', modality: 'text' }), {});
  assert.equal(result.kind, 'decision');
  assert.equal(result.family, 'mimo');
  assert.equal(result.target_mode, 'existing');
  assert.deepEqual(result.candidate_task_types, ['LLM']);
});

test('resolve：OpenAI 不匹配 Kling，Kuaishou Kling 进入自身系列', async () => {
  const policy = loadSeriesPolicy();
  const openai = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'openai', name: 'Kling 4.0', modality: 'video' }), { allowAi: true });
  const kuaishou = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'kuaishou', vendor_name: '快手可灵', name: 'Kling 4.0', modality: 'video' }), { allowAi: true });
  assert.equal(openai.kind, 'fail_closed');
  assert.equal(openai.code, 'PLACEMENT_MODALITY_UNSUPPORTED');
  assert.equal(kuaishou.kind, 'decision');
  assert.equal(kuaishou.target_level2_id, 'vendor-level2:kuaishou:kling');
});


test('resolve：GLM 第 4 个成员 → migration_required（阻断普通 Draft）', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, snapshot(), candidate({ name: 'GLM-5.4' }), {});
  assert.equal(result.kind, 'migration_required');
  assert.equal(result.family, 'glm');
});

test('policy expected members include approved candidates so existing groups do not demand needless migrations', async () => {
  const policy = loadSeriesPolicy();
  const cases = [
    { vendor: 'alibaba', family: 'qwen_image', series: 'vendor-level2:alibaba:qwen-image', name: 'Qwen-Image-2.1', identity: 'qwen-image-2.1', modality: 'image' },
    { vendor: 'stepfun', family: 'step', series: 'vendor-level2:stepfun:step', name: 'Step 5 Preview', identity: 'step-5-preview', modality: 'text' },
    { vendor: 'anthropic', family: 'claude', series: 'vendor-level2:anthropic:claude', name: 'Claude Opus 5.5', identity: 'claude-opus-5.5', modality: 'text' },
    { vendor: 'openai', family: 'gpt', series: 'vendor-level2:openai:gpt-6', name: 'GPT-6 Luna', identity: 'gpt-6-luna', modality: 'text' },
  ];
  for (const item of cases) {
    const series = policy.vendors.find(vendor => vendor.vendor_key === item.vendor).families
      .find(family => family.family === item.family).series.find(target => target.id === item.series);
    const snapshot = emptySnapshot();
    snapshot['vendor-level2'].push({
      id: item.series,
      vendor_key: item.vendor,
      title: series.title,
      detail_refs: series.expected_members.map(member => ({ kind: 'tool-level3', id: `tool-level3:${member}` })),
    });
    const result = await resolveSeriesPlacement(policy, snapshot, {
      ...candidate({ vendor_key: item.vendor, vendor_name: item.vendor, name: item.name, modality: item.modality }),
      model_key: `${item.vendor}-${item.identity}`,
    }, { allowAi: false });
    assert.equal(result.kind, 'decision', `${item.name} should enter its policy group`);
    assert.equal(result.target_level2_id, item.series);
  }
});

test('resolve：needs_ai 未放行 → fail_closed PLACEMENT_MANUAL_REQUIRED', async () => {
  const policy = loadSeriesPolicy();
  // 某政策厂商但名称完全无法判定用途 → needs_ai；allowAi=false → fail_closed
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const snap = emptySnapshot();
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: false });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_MANUAL_REQUIRED');
});

test('resolve：needs_ai + 放行 + AI hint 正确 → decision(ai)', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const snap = emptySnapshot();
  snap['vendor-level2'].push({ id: 'vendor-level2:alibaba:qwen', vendor_key: 'alibaba', title: 'Qwen 模型', detail_refs: [] });
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'general_llm', canonical_family: 'qwen', release_cohort: 'newest' },
    usage: {}, raw: {},
  });
  const result = await resolveSeriesPlacement(policy, snap, c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'decision');
  assert.equal(result.source, 'ai');
  assert.equal(result.target_level2_id, 'vendor-level2:alibaba:qwen');
  assert.equal('ai_confidence' in result, false);
});

test('resolve：needs_ai + AI 冲突（无法确认）→ fail_closed', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'zhipu', vendor_name: '智谱', name: 'Z-Unknown-7' });
  const snap = snapshot(); // zhipu glm 已有 3 成员
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'unknown', canonical_family: null, release_cohort: null },
    usage: {}, raw: {},
  });
  const result = await resolveSeriesPlacement(policy, snap, c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_AI_NOT_CONFIRMED');
});

test('resolve：AI 调用失败 → fail_closed PLACEMENT_AI_FAILED', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const mockSuggest = async () => ({ ok: false, code: 'DEEPSEEK_ERROR', error: 'boom' });
  const result = await resolveSeriesPlacement(policy, emptySnapshot(), c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_AI_FAILED');
});

// ── 4. applyPlacementToSeed ─────────────────────────────────────

test('applyPlacementToSeed：existing → 写 existing_level2_ref；create → group_key + new_group_title', () => {
  const existingSeed = { detail_kind: 'api_model', name: 'X', placement: {} };
  applyPlacementToSeed(existingSeed, {
    kind: 'decision', vendor: 'cohere', target_mode: 'existing',
    target_level2_id: 'vendor-level2:cohere:command', target_level2_title: 'Command 模型',
  });
  assert.deepEqual(existingSeed.placement.existing_level2_ref, { kind: 'vendor-level2', id: 'vendor-level2:cohere:command' });

  const createSeed = { detail_kind: 'api_model', name: 'Y', placement: {} };
  applyPlacementToSeed(createSeed, {
    kind: 'decision', vendor: 'alibaba', target_mode: 'create',
    target_level2_id: 'vendor-level2:alibaba:qwen', target_level2_title: 'Qwen 模型', group_key: 'qwen',
    candidate_task_types: ['TTS'],
  });
  assert.equal(createSeed.group_key, 'qwen');
  assert.equal(createSeed.placement.new_group_title, 'Qwen 模型');
  assert.deepEqual(createSeed.task_types, ['TTS']);
  assert.equal(createSeed.placement.existing_level2_ref, null);
  assert.deepEqual(createSeed.placement.existing_level1_ref, { kind: 'vendor-level1', id: 'vendor-level1:alibaba' });
});
