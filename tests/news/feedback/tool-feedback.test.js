'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  feedbackFromSummaries,
  classifyEntityForPending,
  extractEntities,
  normalizeEntities,
  extractEntitiesDefaultWithTypes,
  AI_MODEL_PATTERN,
} = require('../../../src/news/feedback/tool-feedback');
const { pendingCandidateToSeed } = require('../../../src/pending/index');

/**
 * 创建完全隔离的临时待补卡文件（AC-10），绝不读写仓库真实的 tool-cards-pending.json。
 */
function createTempPendingFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-feedback-test-'));
  const pendingToolFile = path.join(dir, 'tool-cards-pending.json');
  const pendingConceptFile = path.join(dir, 'concept-cards-pending.json');
  return {
    dir,
    pendingToolFile,
    pendingConceptFile,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

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
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '可灵和 Qwen3.8-Max 都很流行，RAG 也是热点。' },
        { review_status: 'approved', summary: 'Cursor 发布了新功能。' },
        { review_status: 'pending', summary: '不该被处理的摘要。' },
      ],
    };
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
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });

    const keling = result.toolsPending.find(c => c.name === '可灵');
    assert.ok(keling, '可灵应生成待补工具卡（不再静默丢弃）');
    assert.equal(keling.entity_type, 'tool');
    assert.equal(Object.hasOwn(keling, 'similar_in_catalog'), false);
    const model = result.toolsPending.find(c => c.name === 'Qwen3.8-Max');
    assert.ok(model, 'Qwen3.8-Max 应进入待补工具卡');
    assert.equal(model.detail_kind_hint, 'api_model');
    assert.equal(model.entity_type, 'model');
    assert.deepEqual(result.toolsFound, ['Cursor']);
    assert.equal(result.toolsPending.some(c => c.name === 'Cursor'), false);
    assert.equal(result.conceptsPending.some(c => c.term === 'RAG'), true);
    assert.equal(result.toolsPending.some(c => c.name === 'RAG'), false);
    assert.equal(result.conceptsPending.some(c => c.term === 'Qwen3.8-Max'), false);
  } finally {
    temp.cleanup();
  }
});

// ── feedback 路由：series 进待补工具卡（无 detail_kind_hint），走 Bundle 管线 ──
test('feedback 路由：series 实体进待补工具卡，entity_type=series 且省略 detail_kind_hint', async () => {
  const temp = createTempPendingFiles();
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
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    const series = result.toolsPending.find(c => c.name === 'GPT-5.6');
    assert.ok(series, 'GPT-5.6 系列应进入待补工具卡');
    assert.equal(series.entity_type, 'series');
    assert.equal(Object.hasOwn(series, 'detail_kind_hint'), false, 'series 候选必须省略 detail_kind_hint');
    const model = result.toolsPending.find(c => c.name === 'Sol');
    assert.ok(model, '具体型号 Sol 应按 model 进入待补工具卡');
    assert.equal(model.entity_type, 'model');
    assert.equal(model.detail_kind_hint, 'api_model');
    assert.equal(series.identity_key, 'gpt-5.6');
    assert.equal(model.identity_key, 'sol');
  } finally {
    temp.cleanup();
  }
});

test('feedback 正则路径：默认正则不再硬名单裁决，笼统名也生成待补卡', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '这篇提到 可灵 和 豆包，还有 Kling 2.6 Pro。' },
      ],
    };
    const result = await feedbackFromSummaries(store, { feedback: { llm_extract: false } }, {
      tools: [],
      glossary: [],
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    for (const name of ['可灵', '豆包', 'Kling 2.6 Pro']) {
      const card = result.toolsPending.find(c => c.name === name);
      assert.ok(card, `${name} 应生成待补工具卡`);
      assert.equal(Object.hasOwn(card, 'similar_in_catalog'), false);
    }
    assert.deepEqual(result.toolsFound, []);
  } finally {
    temp.cleanup();
  }
});

// ── 收录判定降级为提示：Gemini 3.8 Live 事故回归（不得被家族卡静默吸附） ──
test('feedback 路由：目录近似只提示不裁决，Gemini 3.8 Live 生成待补卡并带 similar_in_catalog', async () => {
  const temp = createTempPendingFiles();
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
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    assert.deepEqual(result.toolsFound, [], '近似名不得判"已收录"');
    const card = result.toolsPending.find(c => c.name === 'Gemini 3.8 Live');
    assert.ok(card, 'Gemini 3.8 Live 必须生成待补卡，不得被双向子串静默丢弃');
    assert.equal(card.entity_type, 'model');
    assert.deepEqual(card.similar_in_catalog, [{ tool_key: 'gemini-3-8', title: 'Gemini 3.8', vendor_label: 'Google' }]);
  } finally {
    temp.cleanup();
  }
});

test('feedback 路由：精确同名进 toolsFound；近似为空时待补卡不带 similar_in_catalog 字段', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [{ review_status: 'approved', summary: 'Cursor 更新，Zed Editor 也值得关注。' }],
    };
    const llmExtract = async () => [{ name: 'Cursor', type: 'tool' }, { name: 'Zed Editor', type: 'tool' }];
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [{ tool_key: 'cursor', title: 'Cursor', vendor_label: 'Anysphere' }],
      glossary: [],
      llmExtract,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    assert.deepEqual(result.toolsFound, ['Cursor']);
    const card = result.toolsPending.find(c => c.name === 'Zed Editor');
    assert.ok(card, 'Zed Editor 应生成待补卡');
    assert.equal(Object.hasOwn(card, 'similar_in_catalog'), false, '无近似命中时字段必须缺席');
  } finally {
    temp.cleanup();
  }
});

// ── AC-03：Grok Voice Transcribe 2.0 召回与合并 ───────────────
test('AC-03：Grok Voice Transcribe 2.0 在 3 篇摘要中被召回为 model 并合并为 1 张稳定卡', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: 'xAI 正式推出了 Grok Voice Transcribe 2.0 语音模型。' },
        { review_status: 'approved', summary: '关于 Grok Voice Transcribe 2.0 的性能评测发布。' },
        { review_status: 'approved', summary: '开发者开始接入 Grok Voice Transcribe 2.0 的 API。' },
      ],
    };
    const llmExtract = async text => {
      const out = [];
      if (text.includes('Grok Voice Transcribe 2.0')) {
        out.push({ name: 'Grok Voice Transcribe 2.0', type: 'model' });
      }
      return out;
    };
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [],
      glossary: [],
      llmExtract,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    assert.equal(result.toolsPending.length, 1, '3 篇摘要提及应合并为 1 张待补卡');
    const card = result.toolsPending[0];
    assert.equal(card.name, 'Grok Voice Transcribe 2.0');
    assert.equal(card.entity_type, 'model');
    assert.equal(card.detail_kind_hint, 'api_model');
    assert.equal(card.mentioned_in_summaries, 3, '提及次数应为 3');
  } finally {
    temp.cleanup();
  }
});

// ── AC-04：厂商泛称单独出现过滤，具体产品实体保留 ──────────────
test('AC-04：厂商泛称单独出现识别为 vague/filtered，具体产品实体保留完整', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: 'OpenAI 与 Anthropic 宣布技术合作，Cerebras 和 Runway 也发布了动态。' },
        { review_status: 'approved', summary: 'Anthropic 发布了 Claude Code 工具以及 Claude Opus 4.8 模型。' },
        { review_status: 'approved', summary: 'OpenAI 推出 GPT-5.6 系列，Google 推出 Gemini 3.8 Live。' },
      ],
    };
    // 统一提取策略：厂商泛称单独标 vague，完整具体产品标 tool/model/series
    const llmExtract = async text => {
      const out = [];
      if (text.includes('OpenAI')) out.push({ name: 'OpenAI', type: 'vague' });
      if (text.includes('Anthropic')) out.push({ name: 'Anthropic', type: 'vague' });
      if (text.includes('Cerebras')) out.push({ name: 'Cerebras', type: 'vague' });
      if (text.includes('Runway')) out.push({ name: 'Runway', type: 'vague' });
      if (text.includes('Claude Code')) out.push({ name: 'Claude Code', type: 'tool' });
      if (text.includes('Claude Opus 4.8')) out.push({ name: 'Claude Opus 4.8', type: 'model' });
      if (text.includes('GPT-5.6')) out.push({ name: 'GPT-5.6', type: 'series' });
      if (text.includes('Gemini 3.8 Live')) out.push({ name: 'Gemini 3.8 Live', type: 'model' });
      return out;
    };
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [],
      glossary: [],
      llmExtract,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });

    // 泛称不得生成工具卡
    for (const vendor of ['OpenAI', 'Anthropic', 'Cerebras', 'Runway']) {
      assert.equal(result.toolsPending.some(c => c.name === vendor), false, `${vendor} 不得生成待补卡`);
    }
    // 具体产品/型号/系列完整保留
    const claudeCode = result.toolsPending.find(c => c.name === 'Claude Code');
    assert.ok(claudeCode, 'Claude Code 应保留');
    assert.equal(claudeCode.entity_type, 'tool');

    const opus = result.toolsPending.find(c => c.name === 'Claude Opus 4.8');
    assert.ok(opus, 'Claude Opus 4.8 应保留');
    assert.equal(opus.entity_type, 'model');

    const gpt56 = result.toolsPending.find(c => c.name === 'GPT-5.6');
    assert.ok(gpt56, 'GPT-5.6 应保留');
    assert.equal(gpt56.entity_type, 'series');

    const geminiLive = result.toolsPending.find(c => c.name === 'Gemini 3.8 Live');
    assert.ok(geminiLive, 'Gemini 3.8 Live 应保留');
    assert.equal(geminiLive.entity_type, 'model');

    // 诊断中记录了 vague 过滤
    assert.ok(result.diagnostics.vague_filtered.length >= 4);
  } finally {
    temp.cleanup();
  }
});

// ── AC-06：feedbackFromSummaries 返回诊断与告警细分 ──────────────
test('AC-06：feedbackFromSummaries 返回诊断与告警，区分各类过滤与降级', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '这一条完全没有任何 AI 相关的实体。' },
        { review_status: 'approved', summary: 'OpenAI 提到已收录的 ExistingTool。' },
      ],
    };
    let firstCall = true;
    const llmExtract = async text => {
      if (firstCall) {
        firstCall = false;
        throw new Error('网络超时');
      }
      return [{ name: 'OpenAI', type: 'vague' }, { name: 'ExistingTool', type: 'tool' }];
    };
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [{ title: 'ExistingTool' }],
      glossary: [],
      llmExtract,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    assert.ok(result.diagnostics, '应包含 diagnostics 对象');
    assert.ok(Array.isArray(result.warnings), '应包含 warnings 数组');
    assert.ok(Array.isArray(result.diagnostics.llm_failed), '包含 llm_failed');
    assert.ok(Array.isArray(result.diagnostics.fallback), '包含 fallback');
    assert.ok(Array.isArray(result.diagnostics.vague_filtered), '包含 vague_filtered');
    assert.ok(Array.isArray(result.diagnostics.exact_match_filtered), '包含 exact_match_filtered');
    assert.equal(result.toolsFound.includes('ExistingTool'), true);
  } finally {
    temp.cleanup();
  }
});

// ── 第 2 轮准入筛查：注入 admissionReview 替身验证筛除与归并 ──
test('准入筛查：admissionReview 拒收硬件/基础设施与集成对象，merge 归并别名并累加提及', async () => {
  const temp = createTempPendingFiles();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: 'Grok Voice Transcribe 2.0 发布，OpenRouter 用户第一时间接入，iPhone 17 Pro 1x 拍摄演示视频。' },
        { review_status: 'approved', summary: 'Union Alpha 部署在 @openrouter，流量激增扩容 AWS。' },
      ],
    };
    const llmExtract = async text => {
      const out = [];
      if (text.includes('Grok Voice Transcribe 2.0')) out.push({ name: 'Grok Voice Transcribe 2.0', type: 'model' });
      if (text.includes('iPhone')) out.push({ name: 'iPhone 17 Pro 1x', type: 'tool' });
      if (text.includes('AWS')) out.push({ name: 'AWS', type: 'tool' });
      if (text.includes('Union Alpha')) out.push({ name: 'Union Alpha', type: 'tool' });
      if (text.includes('@openrouter')) out.push({ name: '@openrouter', type: 'tool' });
      else if (text.includes('OpenRouter')) out.push({ name: 'OpenRouter', type: 'tool' });
      return out;
    };
    const admissionReview = async entities => entities.map(e => {
      if (e.name === 'iPhone 17 Pro 1x') return { original_name: e.name, decision: 'reject', reason: '硬件设备' };
      if (e.name === 'AWS') return { original_name: e.name, decision: 'reject', reason: '云基础设施' };
      if (e.name === '@openrouter') return { original_name: e.name, decision: 'merge', reason: '别名归并', final_name: 'OpenRouter' };
      return { original_name: e.name, decision: 'accept', reason: '合格 AI 产品' };
    });
    const result = await feedbackFromSummaries(store, { feedback: { llm_extract: true } }, {
      tools: [],
      glossary: [],
      llmExtract,
      admissionReview,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    assert.equal(result.toolsPending.some(c => c.name.includes('iPhone')), false, 'iPhone 不得进入待补卡');
    assert.equal(result.toolsPending.some(c => c.name === 'AWS'), false, 'AWS 不得进入待补卡');
    assert.equal(result.toolsPending.some(c => c.name === '@openrouter'), false, '别名残片不得单独成卡');
    const grok = result.toolsPending.find(c => c.name === 'Grok Voice Transcribe 2.0');
    assert.ok(grok, 'Grok Voice Transcribe 2.0 必须保留');
    assert.equal(grok.entity_type, 'model');
    const openRouter = result.toolsPending.find(c => c.name === 'OpenRouter');
    assert.ok(openRouter, 'OpenRouter 归并后保留');
    assert.equal(openRouter.mentioned_in_summaries, 2, '归并后提及次数累加');
    const rejected = result.diagnostics.vague_filtered.filter(v => v.type === 'rejected_by_admission');
    assert.equal(rejected.length, 2, '拒收项记入诊断');
    assert.ok(rejected.every(v => v.reason));
  } finally {
    temp.cleanup();
  }
});

// ── 准入筛查批级降级：单批失败只回退该批，其余批次照常裁决 ──
test('准入筛查：批次失败仅回退该批实体并记录告警，其余批次裁决仍生效', async () => {
  const temp = createTempPendingFiles();
  try {
    const candidates = [];
    // 32 个实体触发三批（BATCH_SIZE=15）；第 31、32 个在第三批
    for (let i = 1; i <= 30; i++) {
      candidates.push({ review_status: 'approved', summary: `Noise Tool ${i} 与 Good Tool ${i} 发布。` });
    }
    candidates.push({ review_status: 'approved', summary: 'iPhone 17 Pro 1x 拍摄演示。' });
    candidates.push({ review_status: 'approved', summary: 'Grok Voice Transcribe 2.0 正式发布。' });
    const llmExtract = async text => {
      const out = [];
      for (let i = 1; i <= 30; i++) {
        if (text.includes(`Good Tool ${i}`)) out.push({ name: `Good Tool ${i}`, type: 'tool' });
      }
      if (text.includes('iPhone')) out.push({ name: 'iPhone 17 Pro 1x', type: 'tool' });
      if (text.includes('Grok Voice Transcribe 2.0')) out.push({ name: 'Grok Voice Transcribe 2.0', type: 'model' });
      return out;
    };
    const admissionReview = async batch => {
      if (batch.some(e => e.name.includes('iPhone')) || batch.some(e => e.name.includes('Grok'))) {
        throw new Error('批次超时');
      }
      return batch.map(e => ({ original_name: e.name, decision: 'accept', reason: '合格' }));
    };
    const result = await feedbackFromSummaries({ candidates }, { feedback: { llm_extract: true } }, {
      tools: [],
      glossary: [],
      llmExtract,
      admissionReview,
      pendingToolFile: temp.pendingToolFile,
      pendingConceptFile: temp.pendingConceptFile,
    });
    // 第一批 30 个正常 accept
    assert.equal(result.toolsPending.some(c => c.name === 'Good Tool 1'), true, '首批实体正常保留');
    // 第二批失败：iPhone 与 Grok 均保留第一轮结果（fail-open，不静默丢）
    assert.equal(result.toolsPending.some(c => c.name.includes('iPhone')), true, '失败批实体 fail-open 保留');
    assert.equal(result.toolsPending.some(c => c.name === 'Grok Voice Transcribe 2.0'), true);
    assert.ok(result.diagnostics.warnings.some(w => w.includes('准入筛查批次失败')), '批级失败记入告警');
  } finally {
    temp.cleanup();
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
