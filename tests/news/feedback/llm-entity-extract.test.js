'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEntityExtractInstructions,
  validateExtractOutput,
  toEntityList,
  toNameList,
  extractEntitiesWithLlm,
} = require('../../../src/news/feedback/llm-entity-extract');
const { createCostLedger } = require('../../../src/catalog/core/index');

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function ledger() {
  return createCostLedger({ responses_calls: 5, synthesis_calls: 0 });
}

test('buildEntityExtractInstructions 覆盖类型化输出、系列定义与核验降级规则', () => {
  const text = buildEntityExtractInstructions();
  assert.match(text, /概念/);
  assert.match(text, /工具/);
  assert.match(text, /模型/);
  assert.match(text, /套餐/);
  assert.match(text, /多词名不拆散/);
  assert.match(text, /检查一遍/);
  assert.match(text, /禁止编造/);
  // 输出带类型 {name, type}，笼统名标 vague
  assert.match(text, /\{name, type\}/);
  assert.match(text, /"vague"/);
  assert.match(text, /可灵|通义千问|豆包/);
  // series 定义：版本代际/产品线，其下可有具体型号
  assert.match(text, /"series"/);
  assert.match(text, /GPT-5\.6/);
  assert.match(text, /GLM-5\.3/);
  assert.match(text, /具体型号/);
  // model 定义：官方独立可调用型号；无法确定时标 model 交官方核验
  assert.match(text, /独立可调用/);
  assert.match(text, /不得自行降级/);
  // 旧示例已删：GPT-5.6 不再作为具体 model 示例出现在 model 定义行
  assert.doesNotMatch(text, /具体模型[^；]*GPT-5\.6/);
});

test('validateExtractOutput 只接受类型数组 [{name,type}]，旧格式一律 invalid', () => {
  // 类型数组 [{name, type}]（含 series）
  assert.equal(validateExtractOutput([{ name: 'Cursor', type: 'tool' }]), true);
  assert.equal(validateExtractOutput([{ name: 'Qwen3.8-Max', type: 'model' }, { name: 'RAG', type: 'concept' }]), true);
  assert.equal(validateExtractOutput([{ name: 'GPT-5.6', type: 'series' }]), true);
  assert.equal(validateExtractOutput([]), true);
  assert.equal(validateExtractOutput([{ name: 'a' }]), false);          // 缺 type
  assert.equal(validateExtractOutput([{ name: 'a', type: 'bogus' }]), false); // 非法 type
  assert.equal(validateExtractOutput([{ name: 1, type: 'tool' }]), false);   // name 非字符串
  assert.equal(validateExtractOutput([{ name: 'a', type: 'tool' }, 2]), false); // 混合
  // 旧版裸字符串数组 / {names} / {entities} 一律 invalid（调用方按设计降级正则）
  assert.equal(validateExtractOutput(['a', 'b']), false);
  assert.equal(validateExtractOutput({ names: ['a', 'b'] }), false);
  assert.equal(validateExtractOutput({ entities: ['a'] }), false);
  assert.equal(validateExtractOutput([1, 2]), false);
  assert.equal(validateExtractOutput({}), false);
  assert.equal(validateExtractOutput(null), false);
});

test('toEntityList 只保留带合法类型的对象项，无类型字符串忽略不兜底', () => {
  assert.deepEqual(toEntityList([{ name: ' DeepSeek ', type: 'tool' }, { name: '', type: 'tool' }]), [{ name: 'DeepSeek', type: 'tool' }]);
  // 裸字符串数组：全部忽略（不再兜底 tool）
  assert.deepEqual(toEntityList(['RAG', 'vibe coding']), []);
  assert.deepEqual(toEntityList({ names: ['RAG'] }), []);
  assert.deepEqual(toEntityList({ entities: ['a'] }), []);
  // 非法 type 对象：忽略（不静默降级）
  assert.deepEqual(toEntityList([{ name: 'X', type: 'bogus' }]), []);
  assert.deepEqual(toEntityList(null), []);
  assert.deepEqual(toEntityList([{ name: 'Kling 2.6 Pro', type: 'model' }, { name: 'GPT-5.6', type: 'series' }, { name: '可灵', type: 'vague' }]),
    [{ name: 'Kling 2.6 Pro', type: 'model' }, { name: 'GPT-5.6', type: 'series' }, { name: '可灵', type: 'vague' }]);
});

test('toNameList 仅取名称', () => {
  assert.deepEqual(toNameList([{ name: 'Cursor', type: 'tool' }, { name: 'RAG', type: 'concept' }]), ['Cursor', 'RAG']);
  assert.deepEqual(toNameList(['DeepSeek', '']), []);
});

test('extractEntitiesWithLlm 成功返回带类型实体（含 series），请求带 Bearer', async () => {
  let captured;
  const entities = await extractEntitiesWithLlm('Claude Code 和 GLM-5.3 都很强。', {
    ledger: ledger(),
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return response({ output_text: '[{"name":"Claude Code","type":"tool"},{"name":"GLM-5.3","type":"series"}]' });
    },
  });
  assert.deepEqual(entities, [
    { name: 'Claude Code', type: 'tool' },
    { name: 'GLM-5.3', type: 'series' },
  ]);
  assert.equal(captured.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'deepseek-v4-flash');
  // 本地 Bonsai 分支：instructions/input 折叠为 system/user messages，带关闭思维链
  assert.equal(captured.body.messages[0].role, 'system');
  assert.match(captured.body.messages[0].content, /订阅套餐/);
  assert.equal(captured.body.messages[1].role, 'user');
  assert.equal(captured.body.messages[1].content, JSON.stringify({ text: 'Claude Code 和 GLM-5.3 都很强。' }));
  assert.deepEqual(captured.body.chat_template_kwargs, { enable_thinking: false });
});

test('extractEntitiesWithLlm 模型输出旧格式 {names} 判非法抛错（调用方降级正则）', async () => {
  await assert.rejects(
    extractEntitiesWithLlm('文本', {
      ledger: ledger(),
      apiKey: 'test-key',
      model: 'm',
      fetchImpl: async () => response({ output_text: '{"names":["Cursor"]}' }),
    }),
  );
});

test('extractEntitiesWithLlm 调用失败抛错（供注入层降级正则）', async () => {
  await assert.rejects(
    extractEntitiesWithLlm('文本', {
      ledger: ledger(),
      apiKey: 'test-key',
      model: 'm',
      fetchImpl: async () => response({ error: 'boom' }, false, 500),
    }),
    /boom/,
  );
});

test('extractEntitiesWithLlm 经 catalogApi 注入自建账本与模型兜底', async () => {
  let created = 0;
  const entities = await extractEntitiesWithLlm('RAG 技术。', {
    catalogApi: {
      createEntityLedger: () => { created += 1; return createCostLedger({ responses_calls: 1, synthesis_calls: 0 }); },
      resolveEntityModel: () => 'm-injected',
    },
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'm-injected', 'model 由 catalogApi.resolveEntityModel 兜底');
      return response({ output_text: '[{"name":"RAG","type":"concept"}]' });
    },
  });
  assert.equal(created, 1, '账本由 catalogApi.createEntityLedger 构建');
  assert.deepEqual(entities, [{ name: 'RAG', type: 'concept' }]);
});

test('extractEntitiesWithLlm 缺 ledger 与 catalogApi 时 fail-closed 抛错', async () => {
  await assert.rejects(
    extractEntitiesWithLlm('RAG 技术。', {
      apiKey: 'test-key',
      model: 'm',
      fetchImpl: async () => response({ output_text: '[]' }),
    }),
    /createEntityLedger/,
  );
});
