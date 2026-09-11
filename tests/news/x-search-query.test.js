/**
 * x-search-query.test.js —— X Advanced Search 查询构造与安全门禁纯领域单元测试
 *
 * 运行：node --test tests/news/x-search-query.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHandle,
  buildAccountGroupQuery,
  buildDiscoveryQuery,
  generateQueryHash,
  validateAccountGroups,
} = require('../../src/news/collectors/x-search/query-contract');

const MOCK_WINDOW = {
  since_unix: 1788955200,
  until_unix: 1788998400,
};

test('normalizeHandle: 去 @、trim、小写化', () => {
  assert.equal(normalizeHandle('@OpenAI'), 'openai');
  assert.equal(normalizeHandle('  @AnthropicAI  '), 'anthropicai');
  assert.equal(normalizeHandle('deepseek_ai'), 'deepseek_ai');
  assert.equal(normalizeHandle(''), '');
  assert.equal(normalizeHandle(null), '');
});

test('buildAccountGroupQuery: 构造标准 Advanced Search 查询语句', () => {
  const group = {
    id: 'g1',
    handles: ['OpenAI', '@AnthropicAI', 'GoogleDeepMind'],
  };
  const query = buildAccountGroupQuery(group, MOCK_WINDOW);
  assert.equal(
    query,
    '(from:OpenAI OR from:AnthropicAI OR from:GoogleDeepMind) since_time:1788955200 until_time:1788998400'
  );
});

test('buildAccountGroupQuery: 单 Handle 组合法构造', () => {
  const group = { id: 'g_single', handles: ['OpenAI'] };
  const query = buildAccountGroupQuery(group, MOCK_WINDOW);
  assert.equal(query, '(from:OpenAI) since_time:1788955200 until_time:1788998400');
});

test('buildAccountGroupQuery: 门禁拦截 handles 超过 16 个', () => {
  const handles = Array.from({ length: 17 }, (_, i) => `acc_${i}`);
  assert.throws(
    () => buildAccountGroupQuery({ id: 'g_overflow', handles }, MOCK_WINDOW),
    /exceeds max handles limit of 16/
  );
});

test('buildAccountGroupQuery: 门禁拦截组内重复 Handle', () => {
  assert.throws(
    () => buildAccountGroupQuery({ id: 'g_dup', handles: ['OpenAI', '@openai'] }, MOCK_WINDOW),
    /contains duplicate handle/
  );
});

test('buildAccountGroupQuery: 门禁拦截总长度超过 768 字符', () => {
  // 16 个长 handle，使总长度超过 768
  const longHandles = Array.from({ length: 16 }, (_, i) => `super_long_handle_name_exceeding_boundaries_${i}_xxxxxxxxxxxxxxx`);
  assert.throws(
    () => buildAccountGroupQuery({ id: 'g_long', handles: longHandles }, MOCK_WINDOW),
    /exceeds max length 768/
  );
});

test('buildAccountGroupQuery: 缺少 handles 或 window 抛错', () => {
  assert.throws(() => buildAccountGroupQuery({ id: 'g_empty', handles: [] }, MOCK_WINDOW), /has no handles/);
  assert.throws(() => buildAccountGroupQuery({ id: 'g1', handles: ['a'] }, null), /Invalid window/);
});

test('buildDiscoveryQuery: 在原 query 后正确追加时间窗口', () => {
  const item = { id: 'd1', query: '(AI OR LLM) (release OR launch)' };
  const query = buildDiscoveryQuery(item, MOCK_WINDOW);
  assert.equal(query, '(AI OR LLM) (release OR launch) since_time:1788955200 until_time:1788998400');
});

test('buildDiscoveryQuery: 拦截超过 768 字符的 query', () => {
  const longQuery = 'x'.repeat(740);
  assert.throws(
    () => buildDiscoveryQuery({ id: 'd_long', query: longQuery }, MOCK_WINDOW),
    /exceeds max length 768/
  );
});

test('generateQueryHash: 稳定 sha256 截短且不同输入产生不同 hash', () => {
  const hash1 = generateQueryHash('queryA', MOCK_WINDOW);
  const hash2 = generateQueryHash('queryA', MOCK_WINDOW);
  const hash3 = generateQueryHash('queryB', MOCK_WINDOW);

  assert.equal(hash1, hash2, '相同输入生成相同 hash');
  assert.notEqual(hash1, hash3, '不同 query 生成不同 hash');
  assert.equal(hash1.length, 16, 'hash 长度为 16');
});

test('validateAccountGroups: 完整性与并集校验', () => {
  const groups = [
    { id: 'g1', handles: ['OpenAI', 'AnthropicAI'] },
    { id: 'g2', handles: ['deepseek_ai'] },
  ];
  const expected = ['openai', 'anthropicai', 'deepseek_ai'];

  assert.equal(validateAccountGroups(groups, expected), true);

  // 跨组重复拦截
  assert.throws(
    () => validateAccountGroups([
      { id: 'g1', handles: ['OpenAI'] },
      { id: 'g2', handles: ['@openai'] },
    ]),
    /appears in multiple groups/
  );

  // 组 ID 重复拦截
  assert.throws(
    () => validateAccountGroups([
      { id: 'g1', handles: ['OpenAI'] },
      { id: 'g1', handles: ['deepseek_ai'] },
    ]),
    /Duplicate group id/
  );

  // 并集与预期不符拦截
  assert.throws(
    () => validateAccountGroups(groups, ['openai', 'anthropicai']),
    /does not match expected/
  );
});
