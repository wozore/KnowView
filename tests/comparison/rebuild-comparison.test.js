'use strict';

/**
 * rebuild-comparison.test.js — 模型对比管线核心回归
 *
 * 覆盖：主键对齐（含 models-alias 覆盖自动规则）、15 config 合并、维度归一化、
 * 综合分缺源按比例重分配、性价比 min-max、单源模型、无综合分模型、
 * LiveBench CSV 聚合与 llm-stats RSC 解析。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { rebuildIntegrated, buildAliasMap, lmarenaParse, livebenchParse, openrouterCanonical, llmStatsCanonical, cleanModelDisplay, themeOfDimensions, isOpenSourceOrOpenWeights } = require('../../src/comparison/core/rebuild-comparison');
const { parseCsv, aggregateGroups } = require('../../src/comparison/fetch/fetch-livebench');
const { extractFlightChunks, extractInitialData, mapLlmStatsModel, normalizeRscValue } = require('../../src/comparison/fetch/fetch-llm-stats');
const { validateLmarenaSnapshot, normalizeLmarena, normalizeIndex } = require('../../src/comparison/core/compare-schema');

const FIXTURES = path.join(__dirname, 'fixtures', 'raw');
const readFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

function buildSnapshots() {
  return {
    openrouter: readFixture('openrouter.json'),
    lmarena: readFixture('lmarena.json'),
    livebench: readFixture('livebench.json'),
    llm_stats: readFixture('llm-stats.json'),
  };
}

test('rebuild：对齐 4 源、归一化、综合分缺源重分配、性价比', () => {
  const result = rebuildIntegrated({ snapshots: buildSnapshots(), aliasEntries: [], write: false, exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.models.length, 6); // gpt/claude/o3/kimi/midjourney/runway-gen-4（开源模型 qwen/deepseek 被排除）
  const byCanonical = new Map(result.models.map(model => [model.canonical, model]));

  // GPT-5.6 Sol：4 源、非开源 → 综合分 {lmarena:.65, livebench:.35}
  const gpt = byCanonical.get('openai--gpt-5.6-sol');
  assert.ok(gpt, 'openai--gpt-5.6-sol 存在');
  assert.equal(gpt.open_source, false);
  assert.equal(gpt.single_source, false);
  assert.deepEqual(gpt.degrees, { lmarena: ['high'], livebench: ['high'] });
  assert.deepEqual(gpt.default_degree, { lmarena: 'high', livebench: 'high' });
  assert.equal(gpt.composite.method, 'proportional_redistribute');
  assert.deepEqual(gpt.composite.weights, { lmarena: 0.65, livebench: 0.35 });
  // agent 0.09 → (0.39/0.5)*100=78；lbAvg=(84+86+83+80+79+75+82)/7≈81.29；.65*78+.35*81.29≈79.15
  assert.ok(Math.abs(gpt.composite.score - 79.1) < 0.3, `gpt composite ≈79.1，实际 ${gpt.composite.score}`);
  assert.equal(gpt.dimensions.reasoning.source, 'livebench');
  assert.equal(gpt.dimensions.reasoning.value, 84);
  // 数学推理：aime_2025 优先（llm_stats）
  assert.equal(gpt.dimensions.math_reasoning.source, 'llm_stats');
  assert.equal(gpt.dimensions.math_reasoning.value, 92);
  assert.equal(gpt.dimensions.math_reasoning.note, 'aime_2025');
  // 性价比：综合分 ÷ 平均每 M 价 → 0-100
  assert.ok(gpt.value && gpt.value.score >= 0 && gpt.value.score <= 100, 'gpt 有性价比');

  // Claude Opus 5：变体 High/XHigh
  const claude = byCanonical.get('anthropic--claude-opus-5');
  assert.ok(claude);
  assert.deepEqual(claude.degrees.lmarena, ['high', 'xhigh']);
  assert.equal(claude.default_degree.lmarena, 'high');
  assert.ok(claude.lmarena_scores.agent.high && claude.lmarena_scores.agent.xhigh);
  assert.equal(claude.license, 'Proprietary');
  assert.equal(claude.context_length, 1000000);

  // o3-mini：无 LMArena → 综合分按重分配退化为纯 LiveBench；livebench 变体 high/low
  const o3 = byCanonical.get('openai--o3-mini');
  assert.ok(o3);
  assert.equal(o3.single_source, false);
  assert.deepEqual(o3.degrees.livebench, ['high', 'low']);
  assert.equal(o3.composite.method, 'proportional_redistribute');
  assert.deepEqual(o3.composite.weights, { livebench: 1 }); // 非开源公式 {lmarena, livebench} 仅 livebench 可用
  assert.ok(Math.abs(o3.composite.score - 76.7) < 0.3, `o3 composite ≈76.7，实际 ${o3.composite.score}`);
  assert.equal(o3.dimensions.reasoning.value, 88); // livebench high
  assert.equal(o3.dimensions.math_reasoning.value, 94); // aime 优先于 livebench math

  // 开源与开放权重模型彻底排除
  assert.equal(byCanonical.has('qwen--qwen3.8-27b'), false, '开源开放权重模型 Qwen 3.8 27B 应被彻底排除');
  assert.equal(byCanonical.has('deepseek--deepseek-v4-flash'), false, '开源模型 DeepSeek V4 Flash 应被彻底排除');

  // midjourney：单源 lmarena、无综合分；Elo 榜单值 min-max 归一化为 100
  const mid = byCanonical.get('midjourney--midjourney-v7');
  assert.ok(mid);
  assert.equal(mid.single_source, true);
  assert.equal(mid.composite, null);
  assert.equal(mid.dimensions.text_to_image.value, 100);

  // kimi：无 lmarena/livebench → 无综合分，仅 llm_stats/openrouter
  const kimi = byCanonical.get('moonshotai--kimi-k3');
  assert.ok(kimi);
  assert.equal(kimi.composite, null);
  assert.equal(kimi.dimensions.long_context.value, 92); // index_long_context 53.6 → (73.6/80)*100

  // runway：单源 lmarena（视频模型）
  const runway = byCanonical.get('runway--runway-gen-4');
  assert.ok(runway);
  assert.equal(runway.single_source, true);
  assert.ok(runway.dimensions.text_to_video);
});

test('rebuild：models-alias 覆盖自动主键规则', () => {
  const snapshots = buildSnapshots();
  snapshots.openrouter.data = snapshots.openrouter.data.filter(item => item.id === 'openai/gpt-5.6-sol');
  const aliasEntries = [
    { canonical: 'renamed-gpt', aliases: { openrouter: ['openai/gpt-5.6-sol'], lmarena: ['GPT-5.6 Sol (High)'] } },
  ];
  const result = rebuildIntegrated({ snapshots, aliasEntries, write: false, exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true);
  const models = new Map(result.models.map(model => [model.canonical, model]));
  assert.ok(models.has('renamed-gpt'), 'alias 覆盖后 canonical 为 renamed-gpt');
  assert.match(models.get('renamed-gpt').display, /^GPT-5\.6 Sol/);
});

test('rebuild：模型排除在 Elo/value/series 计算前生效，且每日重建不复活', () => {
  const snapshots = buildSnapshots();
  const exclusionConfig = {
    schema_version: 1,
    rules: [{ vendor: 'openai', identity_prefix: 'gpt-5.6-sol', reason: 'test exclusion' }],
  };
  const first = rebuildIntegrated({ snapshots, exclusionConfig, write: false });
  assert.equal(first.ok, true, first.errors.join('; '));
  assert.equal(first.models.some(model => model.canonical === 'openai--gpt-5.6-sol'), false);
  assert.ok(first.diagnostics.excluded_models.some(item => item.canonical === 'openai--gpt-5.6-sol'));
  assert.equal(first.index.models.some(model => model.canonical === 'openai--gpt-5.6-sol'), false);
  assert.equal(first.data.models.some(model => model.canonical === 'openai--gpt-5.6-sol'), false);
  for (const model of first.models) {
    for (const dimension of Object.values(model.dimensions)) {
      assert.ok(dimension.value >= 0 && dimension.value <= 100);
    }
    if (model.value) assert.ok(model.value.score >= 0 && model.value.score <= 100);
  }

  const second = rebuildIntegrated({ snapshots, exclusionConfig, write: false });
  assert.deepEqual(second.models.map(model => model.canonical), first.models.map(model => model.canonical));
  assert.deepEqual(second.diagnostics.excluded_models.map(item => item.canonical), ['openai--gpt-5.6-sol']);
});

test('rebuild：排除配置不会写 integrated 文件', () => {
  const indexFile = path.join(__dirname, '..', '..', 'data', 'comparison', 'integrated', 'index.json');
  const dataFile = path.join(__dirname, '..', '..', 'data', 'comparison', 'integrated', 'data.json');
  const before = [fs.readFileSync(indexFile, 'utf8'), fs.readFileSync(dataFile, 'utf8')];
  const result = rebuildIntegrated({ snapshots: buildSnapshots(), exclusionConfig: { schema_version: 1, rules: [] }, write: false });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual([fs.readFileSync(indexFile, 'utf8'), fs.readFileSync(dataFile, 'utf8')], before);
});

test('rebuild：raw 快照缺失 → 拒绝重建（全绿才重建）', () => {
  const result = rebuildIntegrated({ snapshots: { openrouter: {}, lmarena: null, livebench: null, llm_stats: null }, write: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('raw 快照缺失')));
});

test('主键规范化：lmarena 程度/日期、livebench degree、openrouter vendor 前缀', () => {
  assert.deepEqual(lmarenaParse('Claude Opus 5 (High)'), { base: 'claude-opus-5', degree: 'high', evaluation_profile: null });
  assert.deepEqual(lmarenaParse('gpt-5.6-sol-xhigh'), { base: 'gpt-5.6-sol', degree: 'xhigh', evaluation_profile: null });
  assert.deepEqual(lmarenaParse('gpt-5.5-high (codex-harness)'), { base: 'gpt-5.5', degree: 'high', evaluation_profile: 'codex-harness' });
  assert.deepEqual(lmarenaParse('Midjourney v7'), { base: 'midjourney-v7', degree: null, evaluation_profile: null });
  assert.deepEqual(livebenchParse('o3-mini-2025-01-31-high'), { base: 'o3-mini', degree: 'high', evaluation_profile: null });
  assert.deepEqual(livebenchParse('deepseek-v4-flash'), { base: 'deepseek-v4-flash', degree: null, evaluation_profile: null });
  assert.equal(openrouterCanonical('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(openrouterCanonical('openai/gpt-5.6-sol-20260814'), 'gpt-5.6-sol'); // 日期多版本取最新
  // 中缀/月份日期：变体型号不该再带日期
  assert.equal(openrouterCanonical('anthropic/claude-opus-4-5-20251101-high-32k'), 'claude-opus-4-5-high-32k');
  assert.equal(openrouterCanonical('qwen/qwen3.5-plus-02-15'), 'qwen3.5-plus'); // MM-DD 日期
  assert.equal(openrouterCanonical('cohere/command-r7b-12-2024'), 'command-r7b'); // MM-YYYY 日期
  assert.equal(openrouterCanonical('qwen/qwen-plus-2025-07-28:thinking'), 'qwen-plus-thinking'); // 日期 + :变体
  // llm-stats model_id 带日期 → 统一剥离对齐（避免同 base 分裂）
  assert.equal(llmStatsCanonical('amazon-nova-experimental-chat-10-09'), 'amazon-nova-experimental-chat');
  assert.equal(llmStatsCanonical('amazon-nova-experimental-chat-26-01-10'), 'amazon-nova-experimental-chat');
  assert.equal(llmStatsCanonical('Amazon Nova Experimental Chat 10-09'), 'amazon-nova-experimental-chat'); // 空格分隔日期（lmarena 形态）
  assert.equal(llmStatsCanonical('qwen3.5-27b'), 'qwen3.5-27b'); // 无日期不变
});

test('rebuild：Codex Harness 是评测环境，不生成 GPT-5.5 重复模型', () => {
  const snapshots = {
    openrouter: {
      data: [{ id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 1e-6 }],
    },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'GPT 5.5', organization: 'openai', license: 'proprietary', score: 0.06, rank: 3 },
          { model_name: 'GPT 5.5 (High)', organization: 'openai', license: 'proprietary', score: 0.07, rank: 2 },
          { model_name: 'GPT 5.5 (xHigh)', organization: 'openai', license: 'proprietary', score: 0.08, rank: 1 },
        ],
        webdev: [
          { model_name: 'gpt-5.5 (codex-harness)', organization: 'openai', license: 'proprietary', rating: 1450, rank: 3 },
          { model_name: 'gpt-5.5-high (codex-harness)', organization: 'openai', license: 'proprietary', rating: 1480, rank: 2 },
          { model_name: 'gpt-5.5-xhigh (codex-harness)', organization: 'openai', license: 'proprietary', rating: 1500, rank: 1 },
        ],
      },
    },
    livebench: { groups: [] },
    llm_stats: { models: [] },
  };
  const result = rebuildIntegrated({ snapshots, identityRegistry: { schema_version: 2, entries: [] }, write: false, exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  const gptModels = result.models.filter(model => model.canonical.startsWith('openai--gpt-5.5'));
  assert.equal(gptModels.length, 1);
  const gpt = gptModels[0];
  assert.deepEqual(gpt.degrees.lmarena, ['high', 'xhigh']);
  assert.deepEqual(gpt.lmarena_scores.agent, {
    base: { score: 0.06, rank: 3 }, high: { score: 0.07, rank: 2 }, xhigh: { score: 0.08, rank: 1 },
  });
  assert.deepEqual(gpt.evaluation_profiles, ['codex-harness']);
  assert.deepEqual(gpt.lmarena_profiles.webdev['codex-harness'], {
    base: { score: 1450, rank: 3 }, high: { score: 1480, rank: 2 }, xhigh: { score: 1500, rank: 1 },
  });
});

test('展示名只剥离日期和服务方式，保留模型身份规格', () => {
  assert.equal(cleanModelDisplay('GPT-5.6 Sol'), 'GPT-5.6 Sol');
  assert.equal(cleanModelDisplay('claude-opus-4.5'), 'claude-opus-4.5');
  assert.equal(cleanModelDisplay('qwen3-max'), 'qwen3-max');
  assert.equal(cleanModelDisplay('olmo-2-0325-32b-instruct'), 'olmo-2-32b-instruct');
  assert.equal(cleanModelDisplay('qwen3.5-27b'), 'qwen3.5-27b');
  assert.equal(cleanModelDisplay('Llama-2-7b-chat-hf'), 'Llama-2-7b-chat-hf');
  assert.equal(cleanModelDisplay('deepseek-r1-distill-qwen-32b'), 'deepseek-r1-distill-qwen-32b');
  assert.equal(cleanModelDisplay('gpt-4.5-preview-2025-02-27'), 'gpt-4.5-preview');
  assert.equal(cleanModelDisplay('chatgpt-4o-latest-20250326'), 'chatgpt-4o');
  assert.equal(cleanModelDisplay('claude-opus-4-5-20251101-high-32k'), 'claude-opus-4-5-high-32k');
  assert.equal(cleanModelDisplay('deepseek-v4-pro-high-20260813'), 'deepseek-v4-pro-high');
  assert.equal(cleanModelDisplay('GPT-4o (2024-11-20)'), 'GPT-4o');
  assert.equal(cleanModelDisplay('Command R (08-2024)'), 'Command R');
  assert.equal(cleanModelDisplay('Qwen3.5 Plus 2026-04-20'), 'Qwen3.5 Plus');
  assert.equal(cleanModelDisplay('command-a-03-2025'), 'command-a');
  assert.equal(cleanModelDisplay('step-1o-turbo-202506'), 'step-1o-turbo');
  assert.equal(cleanModelDisplay('gemini-2.5-flash-lite-preview-09-2025-no-thinking'), 'gemini-2.5-flash-lite-preview-no-thinking');
  assert.equal(cleanModelDisplay('amazon-nova-experimental-chat-10-09'), 'amazon-nova-experimental-chat');
  assert.equal(cleanModelDisplay('amazon-nova-experimental-chat-26-01-10'), 'amazon-nova-experimental-chat');
  assert.equal(cleanModelDisplay(''), null);
  assert.equal(cleanModelDisplay(null), null);
});

test('LiveBench CSV 解析与类别聚合', () => {
  const csv = [
    'model,code_completion,code_generation,math_comp,typos',
    'o3-mini-high,80,84,92,70',
    'o3-mini-low,60,64,82,55',
  ].join('\n');
  const categories = { Coding: ['code_completion', 'code_generation'], Mathematics: ['math_comp'], Language: ['typos'] };
  const rows = parseCsv(csv);
  const groups = aggregateGroups(rows, categories);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].model, 'o3-mini-high');
  assert.equal(groups[0].coding, 82); // (80+84)/2
  assert.equal(groups[0].math, 92);
  assert.equal(groups[0].language, 70);
});

test('llm-stats RSC flight payload 提取 initialData', () => {
  const html = '<script>self.__next_f.push([1,"21:[[\\"$\\",\\"$L2c\\",null,{\\"initialData\\":[{\\"model_id\\":\\"claude-opus-5\\",\\"index_general\\":56.28}]}]]"])</script>';
  const initialData = extractInitialData(extractFlightChunks(html));
  assert.ok(initialData);
  assert.equal(initialData[0].model_id, 'claude-opus-5');
  assert.equal(initialData[0].index_general, 56.28);
});

test('llm-stats RSC 特殊数值兼容：$-0 规整为 0，$NaN/$Infinity 规整为 null', () => {
  assert.equal(normalizeRscValue('$-0'), 0);
  assert.equal(normalizeRscValue('$0'), 0);
  assert.equal(normalizeRscValue('$NaN'), null);
  assert.equal(normalizeRscValue('$Infinity'), null);
  assert.equal(normalizeRscValue('$-Infinity'), null);
  assert.equal(normalizeRscValue(42), 42);
  assert.equal(normalizeRscValue(null), null);

  const mapped = mapLlmStatsModel({
    model_id: 'gpt-4o-mini-2024-07-18',
    name: 'GPT-4o Mini',
    organization: 'OpenAI',
    index_vision: '$-0',
    index_reasoning: '$NaN',
  });
  assert.equal(mapped.index_vision, 0);
  assert.equal(mapped.index_reasoning, null);
});

test('LMArena snapshot 白名单校验 fail-closed（缺列拒绝）', () => {
  const scoreRow = { model_name: 'A', organization: 'o', license: 'L', score: 0.1, score_ci_lower: 0, score_ci_upper: 0.2, observation_count: 1, session_count: 1, rank: 1, category: 'overall', leaderboard_publish_date: '2026-01-01' };
  const ratingRow = { model_name: 'A', organization: 'o', license: 'L', rating: 1300, rating_lower: 1290, rating_upper: 1310, variance: 8, vote_count: 10, rank: 1, category: 'overall', leaderboard_publish_date: '2026-01-01' };
  const agentConfigs = ['agent', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit'];
  const configs = {};
  for (const config of ['agent', 'text', 'vision', 'webdev', 'search', 'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit']) {
    configs[config] = [agentConfigs.includes(config) ? scoreRow : ratingRow];
  }
  assert.equal(validateLmarenaSnapshot({ fetched_at: 'x', configs }).ok, true);
  const bad = { fetched_at: 'x', configs: { agent: [{ model_name: 'A' }] } };
  const result = validateLmarenaSnapshot(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('归一化口径（契约 §2）', () => {
  assert.ok(Math.abs(normalizeLmarena(0.1219) - 84.38) < 0.001);
  assert.ok(Math.abs(normalizeLmarena(-0.2) - 20) < 0.001);
  assert.ok(Math.abs(normalizeIndex(56.28) - 95.35) < 0.001);
  assert.equal(normalizeIndex(-20), 0);
});

test('buildAliasMap 命中登记表', () => {
  const map = buildAliasMap([{ canonical: 'x', aliases: { openrouter: ['vendor/x-2026'], livebench: ['x-high'] } }]);
  assert.equal(map.openrouter['vendor/x-2026'], 'x');
  assert.equal(map.livebench['x-high'], 'x');
});

test('rebuild：raw 源字段 null/空时不写维度（缺失不当 0/25 造假）', () => {
  const snapshots = {
    openrouter: { data: [] },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'null-fields-probe', organization: 'probe', license: 'proprietary', score: 0.1, rank: 1 },
        ],
      },
    },
    livebench: {
      groups: [
        { model: 'lb-null-probe', reasoning: null, coding: null, math: null, language: null, instruction_following: null, data_analysis: null, agentic_coding: null },
      ],
    },
    llm_stats: {
      models: [
        {
          model_id: 'null-fields-probe', name: 'Null Fields Probe', organization_id: 'probe', license: 'proprietary',
          index_general: 50, index_reasoning: 50,
          input_price: 1, output_price: 2,
          aime_2025_score: null, mmmu_pro_score: null, swe_bench_pro_score: null, swe_bench_verified_score: null,
          gpqa_score: null, hle_score: null, index_math: null, index_vision: null, index_long_context: null,
        },
      ],
    },
  };
  const result = rebuildIntegrated({ snapshots, aliasEntries: [], write: false, exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  const model = result.models.find(m => m.canonical === 'probe--null-fields-probe');
  assert.ok(model, 'probe--null-fields-probe 存在');
  // 缺失的 benchmark/index 字段 → 维度整体不落盘（不造假 0/25）
  for (const dim of ['swe_capability', 'multimodal', 'math_reasoning', 'expert_knowledge', 'long_context', 'tool_calling']) {
    assert.equal(model.dimensions[dim], undefined, `缺失字段不应写入维度 ${dim}`);
  }
  // 真实 index_reasoning 仍落盘：normalizeIndex(50)=(50+20)/80*100=87.5
  assert.equal(model.dimensions.reasoning.value, 87.5);
  assert.equal(model.dimensions.reasoning.raw, 50);
  // 综合分只含真实可用源（livebench 全 null → lbAvg null 不进综合，lmarena 可用进综合）
  assert.deepEqual(model.composite.weights, { lmarena: 1 });
  // livebench 行全 null → 无任何有效数据，被空模型自动过滤（缺失不当 0/25 造假，空壳不展示）
  const lb = result.models.find(m => m.canonical === 'unknown--lb-null-probe');
  assert.equal(lb, undefined, 'unknown--lb-null-probe 应被空模型自动过滤');
  const filtered = result.diagnostics.empty_filtered_models;
  assert.ok(filtered.includes('unknown--lb-null-probe'), '自动过滤诊断应列出该探针模型');
});

test('rebuild：不同明确修订版不混合来源或综合分', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'openai/gpt-5.6-flash-0423', name: 'OpenAI: GPT-5.6 Flash', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 1e-6 },
        { id: 'openai/gpt-5.6-flash-0731', name: 'OpenAI: GPT-5.6 Flash', created: 2, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 1e-6 },
      ],
    },
    lmarena: { configs: {} },
    livebench: {
      groups: [
        { model: 'gpt-5.6-flash-0731-high', reasoning: 80, coding: 80, math: 80, language: 80, instruction_following: 80, data_analysis: 80, agentic_coding: 80 },
      ],
    },
    llm_stats: { models: [] },
  };
  const result = rebuildIntegrated({ snapshots, write: false, identityRegistry: { schema_version: 2, entries: [] }, now: new Date('2026-08-26T00:00:00Z'), exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  // revision 已规范化：MMDD 按系统年份推断（本年不显示年份 → MM-DD）
  const older = result.models.find(model => model.canonical === 'openai--gpt-5.6-flash@04-23');
  const newer = result.models.find(model => model.canonical === 'openai--gpt-5.6-flash@07-31');
  assert.ok(older, '0423 → 04-23');
  assert.ok(newer, '0731 → 07-31');
  assert.deepEqual(Object.keys(older.source_names), ['openrouter']);
  assert.deepEqual(Object.keys(newer.source_names).sort(), ['livebench', 'openrouter']);
  assert.equal(older.composite, null);
  assert.equal(newer.composite?.available?.livebench, 80);
});

test('rebuild：同一日期的 MMDD 与 YYYYMMDD 规范化后合并为同一 revision', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'openai/gpt-5.6-flash-0731', name: 'OpenAI: GPT-5.6 Flash', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 1e-6 },
        { id: 'openai/gpt-5.6-flash-20260731', name: 'OpenAI: GPT-5.6 Flash', created: 2, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 1e-6 },
      ],
    },
    lmarena: { configs: {} },
    livebench: {
      groups: [
        { model: 'gpt-5.6-flash-0731', reasoning: 80, coding: 80, math: 80, language: 80, instruction_following: 80, data_analysis: 80, agentic_coding: 80 },
      ],
    },
    llm_stats: { models: [] },
  };
  const result = rebuildIntegrated({ snapshots, write: false, identityRegistry: { schema_version: 2, entries: [] }, now: new Date('2026-08-26T00:00:00Z'), exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  const merged = result.models.find(model => model.canonical === 'openai--gpt-5.6-flash@07-31');
  assert.ok(merged, '0731 与 20260731 合并为 @07-31');
  assert.equal(result.models.filter(m => m.identity === 'gpt-5.6-flash').length, 1, '应只保留一个 gpt-5.6-flash revision');
  assert.deepEqual([...merged.revisions], ['07-31']);
  assert.deepEqual([...merged.source_names.openrouter], ['openai/gpt-5.6-flash-0731', 'openai/gpt-5.6-flash-20260731']);
  assert.equal(merged.livebench_scores?.base?.reasoning ?? merged.composite?.available?.livebench, 80, 'livebench 分数合并保留');
});

test('rebuild：release_date 早于 cutoff 的模型被过滤，无日期保守保留', () => {
  const snapshots = {
    openrouter: { data: [] },
    lmarena: { configs: {} },
    livebench: { groups: [] },
    llm_stats: {
      models: [
        { model_id: 'gpt-4o', name: 'GPT-4o', organization_id: 'openai', license: 'proprietary', release_date: '2024-05-13', index_reasoning: 50 },
        { model_id: 'gpt-5.5', name: 'GPT-5.5', organization_id: 'openai', license: 'proprietary', release_date: '2026-04-23', index_reasoning: 90 },
        { model_id: 'no-date-model', name: 'No Date Model', organization_id: 'openai', license: 'proprietary', index_reasoning: 60 },
      ],
    },
  };
  const result = rebuildIntegrated({
    snapshots, write: false, cutoffDate: '2025-06-01',
    identityRegistry: { schema_version: 2, entries: [] },
    exclusionConfig: { schema_version: 1, rules: [] },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  const canonicals = result.models.map(m => m.canonical);
  assert.ok(!canonicals.includes('openai--gpt-4o'), '2024-05-13 早于 cutoff 应被过滤');
  assert.ok(canonicals.includes('openai--gpt-5.5'), '2026-04-23 应保留');
  assert.ok(canonicals.includes('openai--no-date-model'), '无日期保守保留');
  // 诊断
  assert.equal(result.diagnostics.retention_cutoff_date, '2025-06-01');
  assert.equal(result.diagnostics.retention_filtered_models.length, 1);
  assert.equal(result.diagnostics.retention_filtered_models[0].canonical, 'openai--gpt-4o');
  assert.equal(result.diagnostics.retention_retained_null_models.length, 1);
  // 保留模型的 release_date 已投影
  const kept = result.models.find(m => m.canonical === 'openai--gpt-5.5');
  assert.equal(kept.release_date, '2026-04-23');
  assert.equal(kept.release_date_provenance, 'llm_stats');
});

test('themeOfDimensions：按评测维度归类图像/视频/纯视觉/通用', () => {
  assert.equal(themeOfDimensions({ text_to_image: {}, image_edit: {} }), 'image');
  assert.equal(themeOfDimensions({ text_to_video: {}, video_edit: {} }), 'video');
  assert.equal(themeOfDimensions({ image_to_video: {} }), 'video');
  assert.equal(themeOfDimensions({ vision: {}, text: {} }), 'general', '带文本能力不算纯视觉');
  assert.equal(themeOfDimensions({ vision: {}, multimodal: {} }), 'general', '带多模态能力不算纯视觉');
  assert.equal(themeOfDimensions({ vision: {} }), 'vision');
  assert.equal(themeOfDimensions({ vision: {}, reasoning: {} }), 'general');
  assert.equal(themeOfDimensions({ text: {}, coding: {}, math_reasoning: {} }), 'general');
  assert.equal(themeOfDimensions({ text_to_image: {}, text_to_video: {} }), 'video', '视频优先于图像');
  assert.equal(themeOfDimensions(null), 'general');
  assert.equal(themeOfDimensions({}), 'general');
});

test('rebuild：按模型维度归类生成模型 theme，带 vision 维的通用 LLM 仍归 general', () => {
  const result = rebuildIntegrated({ snapshots: buildSnapshots(), aliasEntries: [], write: false, exclusionConfig: { schema_version: 1, rules: [] } });
  assert.equal(result.ok, true, result.errors.join('; '));
  const byCanonical = new Map(result.models.map(model => [model.canonical, model]));
  assert.equal(byCanonical.get('midjourney--midjourney-v7').theme, 'image');
  assert.equal(byCanonical.get('runway--runway-gen-4').theme, 'video');
  assert.equal(byCanonical.get('openai--gpt-5.6-sol').theme, 'general', '有 vision 榜分的通用 LLM 不归纯视觉');
  assert.equal(byCanonical.get('anthropic--claude-opus-5').theme, 'general');
  assert.equal(byCanonical.get('openai--o3-mini').theme, 'general');
});

test('rebuild：彻底排除开源模型与开放权重模型，仅保留商业闭源模型', () => {
  const snapshots = {
    openrouter: {
      data: [
        // 开源且有商业定价（仍应被彻底排除）
        { id: 'deepseek/deepseek-priced', name: 'DeepSeek Priced', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
        // 开放权重 xxB 后缀模型（带定价仍应被排除）
        { id: 'meta/llama-3.1-70b', name: 'Llama 3.1 70B', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
        { id: 'google/gemma-4-e4b', name: 'Gemma 4 E4B', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
        { id: 'qwen/qwen-7b', name: 'Qwen 7B', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
        // 闭源纯商业模型（应保留）
        { id: 'openai/closed-proprietary', name: 'Closed Proprietary', created: 1, input_modalities: ['text'], output_modalities: ['text'] },
      ],
    },
    lmarena: {
      configs: {
        agent: [
          // 开源且无定价
          { model_name: 'open-unpriced', organization: 'meta', license: 'apache-2.0', score: 0.1, rank: 1 },
          // 闭源无定价但有评测数据
          { model_name: 'closed-proprietary', organization: 'openai', license: 'proprietary', score: 0.12, rank: 2 },
        ],
      },
    },
    livebench: { groups: [] },
    llm_stats: {
      models: [
        { model_id: 'deepseek-priced', name: 'DeepSeek Priced', organization_id: 'deepseek', license: 'mit', index_general: 50 },
        { model_id: 'closed-proprietary', name: 'Closed Proprietary', organization_id: 'openai', license: 'proprietary', index_general: 80 },
      ],
    },
  };
  const result = rebuildIntegrated({
    snapshots,
    write: false,
    identityRegistry: { schema_version: 2, entries: [] },
    exclusionConfig: { schema_version: 1, rules: [] },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  const canonicals = result.models.map(m => m.canonical);
  assert.ok(!canonicals.includes('meta--open-unpriced'), '无正向定价的开源模型应被过滤');
  assert.ok(!canonicals.includes('deepseek--deepseek-priced'), '有正向定价的开源模型也必须彻底排除');
  assert.ok(!canonicals.includes('meta--llama-3.1-70b'), '70B 开放权重模型应被彻底排除');
  assert.ok(!canonicals.includes('google--gemma-4-e4b'), 'E4B 开放权重模型应被彻底排除');
  assert.ok(!canonicals.includes('qwen--qwen-7b'), '7B 开放权重模型应被彻底排除');
  assert.ok(canonicals.includes('openai--closed-proprietary'), '闭源商业模型应正常保留');
});

test('rebuild：Kimi K3 别名收拢至 moonshotai--kimi-k3，消除主键分裂', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'moonshotai/kimi-k3', name: 'Moonshot: Kimi K3', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
      ],
    },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'Kimi K3', organization: 'moonshot', license: 'proprietary', score: 0.08, rank: 2 },
          { model_name: 'kimi-k3', organization: 'moonshot', license: 'proprietary', score: 0.09, rank: 1 },
        ],
      },
    },
    livebench: {
      groups: [
        { model: 'kimi-k3', reasoning: 85, coding: 85, math: 85, language: 85, instruction_following: 85, data_analysis: 85, agentic_coding: 85 },
      ],
    },
    llm_stats: {
      models: [
        { model_id: 'kimi-k3', name: 'Kimi K3', organization_id: 'moonshot', license: 'kimi_k3', index_general: 60 },
      ],
    },
  };
  const aliasEntries = [
    {
      model_key: 'moonshotai--kimi-k3',
      display: 'Kimi K3',
      aliases: {
        lmarena: ['kimi k3', 'kimi-k3'],
      },
    },
  ];
  const result = rebuildIntegrated({
    snapshots,
    write: false,
    identityRegistry: { schema_version: 2, entries: aliasEntries },
    exclusionConfig: { schema_version: 1, rules: [] },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  const kimiModels = result.models.filter(m => m.canonical.startsWith('moonshotai--kimi'));
  assert.equal(kimiModels.length, 1, 'Kimi K3 别名收拢后不应有分裂记录');
  assert.equal(kimiModels[0].canonical, 'moonshotai--kimi-k3');
  assert.ok(kimiModels[0].source_names.lmarena.includes('Kimi K3'));
  assert.ok(kimiModels[0].source_names.lmarena.includes('kimi-k3'));
});

test('isOpenSourceOrOpenWeights：严密识别开源与开放权重模型，豁免商业旗舰', () => {
  // 1. open_source === true 判定为开源
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', open_source: true }), true);

  // 2. 许可证判定
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'Apache-2.0' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'MIT' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'GPL-3.0' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'creative_commons_attribution_4_0_license' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'Llama 3.1 Community' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'qwen_community_1_0' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'other--custom-model', license: 'Proprietary' }), false);

  // 3. 参数规模标记判定（7B, 20B, 27B, 30B, 70B, 120B, E4B, A4B, A23B 等）
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-7b', display: 'Bar 7B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-20b', display: 'Bar 20B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-27b', display: 'Bar 27B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-30b', display: 'Bar 30B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-70b', display: 'Bar 70B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-120b', display: 'Bar 120B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-e4b', display: 'Bar E4B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-a4b', display: 'Bar A4B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-a23b', display: 'Bar A23B' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'foo--bar-424b-a47b', display: 'Bar 424B A47B' }), true);

  // 4. 知名开放权重家族/厂商
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'meta--muse-spark', vendor: 'meta' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'allenai--olmo-2', vendor: 'allenai' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'openbmb--minicpm', vendor: 'openbmb' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'google--gemma-3', family: 'gemma' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'ibm--granite-4.2', family: 'granite' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'nvidia--nemotron-3', family: 'nemotron' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'openai--gpt-oss-20b', family: 'gpt-oss' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'lg--exaone-4.5', family: 'exaone' }), true);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'deepseek--deepseek-v4', vendor: 'deepseek' }), true);

  // 5. 纯商业旗舰模型绝不误判
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'openai--gpt-4o', identity: 'gpt-4o', display: 'GPT-4o' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'openai--gpt-5.6-sol', identity: 'gpt-5.6-sol', display: 'GPT-5.6 Sol' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'openai--gpt-6-astra', identity: 'gpt-6-astra', display: 'GPT-6 Astra' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'anthropic--claude-opus-5', identity: 'claude-opus-5', display: 'Claude Opus 5' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'anthropic--claude-sonnet-4.6', identity: 'claude-sonnet-4.6', display: 'Claude Sonnet 4.6' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'google--gemini-3.5-pro', identity: 'gemini-3.5-pro', display: 'Gemini 3.5 Pro' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'google--gemini-2.5-flash-lite', identity: 'gemini-2.5-flash-lite', display: 'Gemini 2.5 Flash-Lite' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'xai--grok-4.6', identity: 'grok-4.6', display: 'Grok 4.6' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'zhipu--glm-5.3', identity: 'glm-5.3', display: 'GLM-5.3', license: 'glm_5_3' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'moonshotai--kimi-k3', identity: 'kimi-k3', display: 'Kimi K3', license: 'kimi_k3' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'minimax--minimax-m3', identity: 'minimax-m3', display: 'MiniMax M3', license: 'MIT' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'baidu--ernie-5.1', identity: 'ernie-5.1', display: 'ERNIE 5.1' }), false);
  assert.equal(isOpenSourceOrOpenWeights({ canonical: 'qwen--qwen3.8-max', identity: 'qwen3.8-max', display: 'Qwen3.8 Max' }), false);
});

test('rebuild：解除 gpt-6 排除后，GPT-6 Astra 正常纳入 integrated 结果', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-5, completion: 3e-5 },
      ],
    },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'gpt-6-astra-max', organization: 'openai', license: 'proprietary', score: 0.15, rank: 1 },
        ],
      },
    },
    livebench: { groups: [] },
    llm_stats: {
      models: [
        { model_id: 'gpt-6-astra', name: 'GPT-6 Astra', organization_id: 'openai', license: 'proprietary', index_general: 90 },
      ],
    },
  };
  const result = rebuildIntegrated({
    snapshots,
    write: false,
    identityRegistry: { schema_version: 2, entries: [] },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  const gpt6 = result.models.find(m => m.canonical === 'openai--gpt-6-astra');
  assert.ok(gpt6, 'openai--gpt-6-astra 应正常纳入 integrated 结果');
  assert.equal(gpt6.open_source, false);
  assert.ok(gpt6.composite && gpt6.composite.score > 0);
});

test('rebuild：priceAvgPerM 与 computeValues 防御门禁杜绝 NaN 与非正综合分扩散', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'openai/bad-pricing', name: 'Bad Pricing', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 'invalid', completion: undefined },
        { id: 'openai/good-pricing', name: 'Good Pricing', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
      ],
    },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'bad-pricing', organization: 'openai', license: 'proprietary', score: 0.1, rank: 1 },
          { model_name: 'good-pricing', organization: 'openai', license: 'proprietary', score: 0.2, rank: 2 },
        ],
      },
    },
    livebench: { groups: [] },
    llm_stats: { models: [] },
  };
  const result = rebuildIntegrated({
    snapshots,
    write: false,
    identityRegistry: { schema_version: 2, entries: [] },
    exclusionConfig: { schema_version: 1, rules: [] },
  });
  assert.equal(result.ok, true);
  const good = result.models.find(m => m.canonical === 'openai--good-pricing');
  assert.ok(good && good.value && Number.isFinite(good.value.score), '正常模型性价比得分应为有限数');
  const bad = result.models.find(m => m.canonical === 'openai--bad-pricing');
  assert.equal(bad.value, null, '非法定价模型不应生成 value');
});

test('rebuild：商业模型综合分权重使用双源公式，不混入开源 llm_stats 权重', () => {
  const snapshots = {
    openrouter: {
      data: [
        { id: 'minimax/minimax-m3', name: 'MiniMax M3', created: 1, input_modalities: ['text'], output_modalities: ['text'], prompt: 1e-6, completion: 2e-6 },
      ],
    },
    lmarena: {
      configs: {
        agent: [
          { model_name: 'minimax-m3', organization: 'minimax', license: 'MIT', score: 0.20, rank: 1 },
        ],
      },
    },
    livebench: {
      groups: [
        { model: 'minimax-m3', reasoning: 80, coding: 75, math: 70, language: 85, instruction_following: 90, data_analysis: 70, agentic_coding: 70 },
      ],
    },
    llm_stats: {
      models: [
        { model_id: 'minimax-m3', name: 'MiniMax M3', organization_id: 'minimax', license: 'MIT', index_general: 88 },
      ],
    },
  };
  const result = rebuildIntegrated({
    snapshots,
    write: false,
    identityRegistry: { schema_version: 2, entries: [] },
    exclusionConfig: { schema_version: 1, rules: [] },
  });
  assert.equal(result.ok, true);
  const m3 = result.models.find(m => m.canonical === 'minimax--minimax-m3');
  assert.ok(m3, 'MiniMax M3 应保留');
  assert.equal(m3.open_source, false);
  assert.equal(m3.license, 'Proprietary');
  assert.ok(m3.composite, '应有综合分');
  assert.equal(m3.composite.weights.llm_stats, undefined, '商业模型权重不得包含 llm_stats');
  assert.equal(m3.composite.weights.lmarena, 0.65);
  assert.equal(m3.composite.weights.livebench, 0.35);
});

