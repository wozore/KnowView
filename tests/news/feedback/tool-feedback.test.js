'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../../../src/shared/paths');
const {
  feedbackFromSummaries,
  classifyEntityForPending,
  extractEntities,
  normalizeEntities,
} = require('../../../src/news/feedback/tool-feedback');
const { pendingCandidateToSeed } = require('../../../src/pending/index');

// 备份/恢复待补卡文件（feedbackFromSummaries 会真实写这两个文件）
const PENDING_TOOL = CATALOG_GENERATOR_FILES.pendingTools;
const PENDING_CONCEPT = CONCEPT_FILES.pendingConcepts;

function backup() {
  const tool = fs.existsSync(PENDING_TOOL) ? fs.readFileSync(PENDING_TOOL, 'utf8') : null;
  const concept = fs.existsSync(PENDING_CONCEPT) ? fs.readFileSync(PENDING_CONCEPT, 'utf8') : null;
  return { tool, concept };
}
function restore(saved) {
  if (saved.tool === null) { if (fs.existsSync(PENDING_TOOL)) fs.unlinkSync(PENDING_TOOL); }
  else fs.writeFileSync(PENDING_TOOL, saved.tool);
  if (saved.concept === null) { if (fs.existsSync(PENDING_CONCEPT)) fs.unlinkSync(PENDING_CONCEPT); }
  else fs.writeFileSync(PENDING_CONCEPT, saved.concept);
}

// isVagueName 仍由 pending facade（src/pending/rules.js，catalog-seed 生产调用）提供，
// 其断言见 pending-review-store.test.js；tool-feedback 不再消费硬名单。

// ── normalizeEntities：类型归一化 ─────────────────────────────
test('normalizeEntities 兼容类型数组、裸字符串与对象，非法 type 兜底 tool', () => {
  assert.deepEqual(normalizeEntities([{ name: 'Cursor', type: 'tool' }, { name: 'Qwen3.8-Max', type: 'model' }]),
    [{ name: 'Cursor', type: 'tool' }, { name: 'Qwen3.8-Max', type: 'model' }]);
  assert.deepEqual(normalizeEntities(['Cursor', 'RAG']), [{ name: 'Cursor', type: 'tool' }, { name: 'RAG', type: 'tool' }]);
  assert.deepEqual(normalizeEntities({ names: ['Cursor'] }), [{ name: 'Cursor', type: 'tool' }]);
  assert.deepEqual(normalizeEntities([{ name: 'X', type: 'bogus' }]), [{ name: 'X', type: 'tool' }]);
  assert.deepEqual(normalizeEntities([{ name: 'GPT-5.6', type: 'series' }]), [{ name: 'GPT-5.6', type: 'series' }]);
  assert.deepEqual(normalizeEntities(null), []);
});

// ── classifyEntityForPending：待补路由纯函数 ───────────────────
test('classifyEntityForPending 按契约路由五种实体类型', () => {
  assert.deepEqual(classifyEntityForPending({ name: 'GPT-5.6', type: 'series' }), { target: 'tools', entity_type: 'series' });
  assert.deepEqual(classifyEntityForPending({ name: '可灵', type: 'vague' }), { target: 'filtered', entity_type: 'vague' });
  assert.deepEqual(classifyEntityForPending({ name: 'RAG', type: 'concept' }), { target: 'concepts', entity_type: 'concept' });
  assert.deepEqual(classifyEntityForPending({ name: 'Cursor', type: 'tool' }), { target: 'tools', entity_type: 'tool' });
  assert.deepEqual(classifyEntityForPending({ name: 'Claude Opus 4.8', type: 'model' }), { target: 'tools', entity_type: 'model' });
  // 未知/缺类型：filtered（绝不静默当 tool）
  assert.deepEqual(classifyEntityForPending({ name: 'X' }), { target: 'filtered', entity_type: 'unknown' });
  assert.deepEqual(classifyEntityForPending(null), { target: 'filtered', entity_type: 'unknown' });
});

// ── feedbackFromSummaries：硬名单不再一票否决，LLM 类型层说了算 ──
test('feedback 路由：笼统名标 tool 也生成待补卡、模型带 api_model 提示、概念走概念卡', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '可灵和 Qwen3.8-Max 都很流行，RAG 也是热点。' },
        { review_status: 'approved', summary: 'Cursor 发布了新功能。' },
        { review_status: 'pending', summary: '不该被处理的摘要。' },
      ],
    };
    // LLM 把笼统名可灵误标为 tool：不再硬名单兜底，宁多生成候补卡交人工确认
    const llmExtract = async text => {
      const out = [];
      if (text.includes('可灵')) out.push({ name: '可灵', type: 'tool' });
      if (text.includes('Qwen3.8-Max')) out.push({ name: 'Qwen3.8-Max', type: 'model' });
      if (text.includes('RAG')) out.push({ name: 'RAG', type: 'concept' });
      if (text.includes('Cursor')) out.push({ name: 'Cursor', type: 'tool' });
      return out;
    };
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [{ title: 'Cursor' }],
      glossary: [],
      llmExtract,
    });

    // 笼统名（LLM 标 tool）→ 待补工具卡；目录无近似命中时不带 similar_in_catalog
    const keling = result.toolsPending.find(c => c.name === '可灵');
    assert.ok(keling, '可灵应生成待补工具卡（不再静默丢弃）');
    assert.equal(keling.entity_type, 'tool');
    assert.equal(Object.hasOwn(keling, 'similar_in_catalog'), false);
    // 具体模型 → 待补工具卡 + api_model 提示 + entity_type
    const model = result.toolsPending.find(c => c.name === 'Qwen3.8-Max');
    assert.ok(model, 'Qwen3.8-Max 应进入待补工具卡');
    assert.equal(model.detail_kind_hint, 'api_model');
    assert.equal(model.entity_type, 'model');
    // 已有工具（归一化精确同一）→ toolsFound，不生成卡
    assert.deepEqual(result.toolsFound, ['Cursor']);
    assert.equal(result.toolsPending.some(c => c.name === 'Cursor'), false);
    // 概念 → 概念卡，不进工具卡
    assert.equal(result.conceptsPending.some(c => c.term === 'RAG'), true);
    assert.equal(result.toolsPending.some(c => c.name === 'RAG'), false);
    assert.equal(result.conceptsPending.some(c => c.term === 'Qwen3.8-Max'), false);
  } finally {
    restore(saved);
  }
});

// ── feedback 路由：series 进待补工具卡（无 detail_kind_hint），走 Bundle 管线 ──
test('feedback 路由：series 实体进待补工具卡，entity_type=series 且省略 detail_kind_hint', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: 'GPT-5.6 系列发布了，含 Sol 与 Terra 两个型号。' },
      ],
    };
    const llmExtract = async () => [{ name: 'GPT-5.6', type: 'series' }, { name: 'Sol', type: 'model' }];
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [],
      glossary: [],
      llmExtract,
    });
    const series = result.toolsPending.find(c => c.name === 'GPT-5.6');
    assert.ok(series, 'GPT-5.6 系列应进入待补工具卡');
    assert.equal(series.entity_type, 'series');
    assert.equal(Object.hasOwn(series, 'detail_kind_hint'), false, 'series 候选必须省略 detail_kind_hint');
    // 具体型号仍按 model 路由
    const model = result.toolsPending.find(c => c.name === 'Sol');
    assert.ok(model, '具体型号 Sol 应按 model 进入待补工具卡');
    assert.equal(model.entity_type, 'model');
    assert.equal(model.detail_kind_hint, 'api_model');
    // identity_key 由 normalizeModelIdentity 统一算法生成
    assert.equal(series.identity_key, 'gpt-5.6');
    assert.equal(model.identity_key, 'sol');
  } finally {
    restore(saved);
  }
});

test('feedback 正则路径：默认正则不再硬名单裁决，笼统名也生成待补卡', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '这篇提到 可灵 和 豆包，还有 Kling 2.6 Pro。' },
      ],
    };
    // 不注入 llmExtract → 走默认正则
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [],
      glossary: [],
    });
    // 正则路径一律标 tool：可灵/豆包不再被硬名单静默排除
    for (const name of ['可灵', '豆包', 'Kling 2.6 Pro']) {
      const card = result.toolsPending.find(c => c.name === name);
      assert.ok(card, `${name} 应生成待补工具卡`);
      assert.equal(Object.hasOwn(card, 'similar_in_catalog'), false);
    }
    assert.deepEqual(result.toolsFound, []);
  } finally {
    restore(saved);
  }
});

// ── 收录判定降级为提示：Gemini 3.8 Live 事故回归（不得被家族卡静默吸附） ──
test('feedback 路由：目录近似只提示不裁决，Gemini 3.8 Live 生成待补卡并带 similar_in_catalog', async () => {
  const saved = backup();
  try {
    const store = { candidates: [{ review_status: 'approved', summary: 'Gemini 3.8 Live 开始推流。' }] };
    const llmExtract = async () => [{ name: 'Gemini 3.8 Live', type: 'model' }];
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [
        { tool_key: 'gemini-3-8-flash', title: 'Gemini 3.8 Flash', vendor_label: 'Google' },
        { tool_key: 'gemini-3-8', title: 'Gemini 3.8', vendor_label: 'Google' },
      ],
      glossary: [],
      llmExtract,
    });
    assert.deepEqual(result.toolsFound, [], '近似名不得判"已收录"');
    const card = result.toolsPending.find(c => c.name === 'Gemini 3.8 Live');
    assert.ok(card, 'Gemini 3.8 Live 必须生成待补卡，不得被双向子串静默丢弃');
    assert.equal(card.entity_type, 'model');
    // 家族卡 Gemini 3.8（needle.includes(title) 命中）作为近似提示；Flash 具体卡不命中
    assert.deepEqual(card.similar_in_catalog, [{ tool_key: 'gemini-3-8', title: 'Gemini 3.8', vendor_label: 'Google' }]);
  } finally {
    restore(saved);
  }
});

test('feedback 路由：精确同名进 toolsFound；近似为空时待补卡不带 similar_in_catalog 字段', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [{ review_status: 'approved', summary: 'Cursor 更新，Zed Editor 也值得关注。' }],
    };
    const llmExtract = async () => [{ name: 'Cursor', type: 'tool' }, { name: 'Zed Editor', type: 'tool' }];
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [{ tool_key: 'cursor', title: 'Cursor', vendor_label: 'Anysphere' }],
      glossary: [],
      llmExtract,
    });
    // 归一化精确同一 → 已收录；目录无 Zed 近似 → 不生成提示字段
    assert.deepEqual(result.toolsFound, ['Cursor']);
    const card = result.toolsPending.find(c => c.name === 'Zed Editor');
    assert.ok(card, 'Zed Editor 应生成待补卡');
    assert.equal(Object.hasOwn(card, 'similar_in_catalog'), false, '无近似命中时字段必须缺席');
  } finally {
    restore(saved);
  }
});

// ── extractEntities：返回带类型实体 ───────────────────────────
test('extractEntities 默认正则返回带类型实体（不再硬名单标 vague）', async () => {
  const entities = await extractEntities('可灵 发布了新模型。', {});
  assert.ok(entities.some(e => e.name === '可灵' && e.type === 'tool'), '默认正则统一标 tool，类型交 LLM/人工判断');
  const llm = await extractEntities('Cursor 很流行。', { llmExtract: async () => [{ name: 'Cursor', type: 'tool' }] });
  assert.deepEqual(llm, [{ name: 'Cursor', type: 'tool' }]);
});

// ── pendingCandidateToSeed：类型提示与笼统名拒绝 ──────────────
test('pendingCandidateToSeed 按 detail_kind_hint 设 detail_kind', () => {
  assert.equal(pendingCandidateToSeed({ name: 'Qwen3.8-Max', detail_kind_hint: 'api_model' }).detail_kind, 'api_model');
  assert.equal(pendingCandidateToSeed({ name: 'Brand New Tool' }).detail_kind, 'tool');
  assert.equal(pendingCandidateToSeed({ name: 'Brand New Tool', detail_kind_hint: 'tool' }).detail_kind, 'tool');
});

test('pendingCandidateToSeed 透传显式 modality', () => {
  assert.equal(pendingCandidateToSeed({ name: 'Qwen3.7 Plus', detail_kind_hint: 'api_model', modality: 'text' }).modality, 'text');
  assert.equal(Object.hasOwn(pendingCandidateToSeed({ name: 'Brand New Tool' }), 'modality'), false);
});

test('pendingCandidateToSeed 拒绝笼统名（批量生成绝不产出笼统名卡）', () => {
  for (const name of ['可灵', '通义千问', 'ChatGPT', 'Claude', '豆包', 'Kimi']) {
    assert.throws(() => pendingCandidateToSeed({ name }), /PENDING_CANDIDATE_VAGUE/, `${name} 应被拒绝`);
  }
});
