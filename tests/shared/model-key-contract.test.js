'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VENDOR_KEY_RE,
  normalizeModelIdentity,
  modelKeyOf,
  parseModelKey,
  isModelIdentity,
  isModelKey,
  findModelKeyCollisions,
} = require('../../src/shared/model-key-contract');

function assertCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, new RegExp(code));
    return;
  }
  assert.fail(`期望抛出 ${code}，但未抛错`);
}

test('normalizeModelIdentity 契约样例：GPT-5.6 Sol', () => {
  assert.equal(normalizeModelIdentity('GPT-5.6 Sol'), 'gpt-5.6-sol');
});

test('normalizeModelIdentity 契约样例：全角 ＧＰＴ－５.６', () => {
  assert.equal(normalizeModelIdentity('ＧＰＴ－５.６'), 'gpt-5.6');
});

test('normalizeModelIdentity 契约样例：GPT 5.6_Sol', () => {
  assert.equal(normalizeModelIdentity('GPT 5.6_Sol'), 'gpt-5.6-sol');
});

test('normalizeModelIdentity 契约样例：a.b 点号左右非数字折叠为 -', () => {
  assert.equal(normalizeModelIdentity('a.b'), 'a-b');
});

test('normalizeModelIdentity 版本小数点仅在两侧均为数字时保留', () => {
  assert.equal(normalizeModelIdentity('flux.2 pro'), 'flux-2-pro');
  assert.equal(normalizeModelIdentity('kling 2.6'), 'kling-2.6');
  assert.equal(normalizeModelIdentity('v.5'), 'v-5');
  assert.equal(normalizeModelIdentity('5.'), '5');
  assert.equal(normalizeModelIdentity('claude..sonnet'), 'claude-sonnet');
});

test('normalizeModelIdentity 破折号家族与连续折叠、首尾清理', () => {
  assert.equal(normalizeModelIdentity('GLM —5 Turbo'), 'glm-5-turbo');
  assert.equal(normalizeModelIdentity('o3–mini'), 'o3-mini');
  assert.equal(normalizeModelIdentity('deepseek--chat__v3'), 'deepseek-chat-v3');
  assert.equal(normalizeModelIdentity('-leading-dot.'), 'leading-dot');
});

test('normalizeModelIdentity 空输入 fail-closed 抛 MODEL_IDENTITY_EMPTY', () => {
  assertCode(() => normalizeModelIdentity(''), 'MODEL_IDENTITY_EMPTY');
  assertCode(() => normalizeModelIdentity('   '), 'MODEL_IDENTITY_EMPTY');
  assertCode(() => normalizeModelIdentity(null), 'MODEL_IDENTITY_EMPTY');
  assertCode(() => normalizeModelIdentity(undefined), 'MODEL_IDENTITY_EMPTY');
  assertCode(() => normalizeModelIdentity('---'), 'MODEL_IDENTITY_EMPTY');
  assertCode(() => normalizeModelIdentity('...'), 'MODEL_IDENTITY_EMPTY');
});

test('normalizeModelIdentity 幂等', () => {
  const once = normalizeModelIdentity('GPT 5.6 Sol');
  assert.equal(normalizeModelIdentity(once), once);
});

test('modelKeyOf 拼接 vendor 与归一化 identity', () => {
  assert.equal(modelKeyOf('openai', 'GPT-5.6 Sol'), 'openai-gpt-5.6-sol');
  assert.equal(modelKeyOf('black-forest-labs', 'FLUX.2 Pro'), 'black-forest-labs-flux-2-pro');
  assert.equal(modelKeyOf('kuaishou', 'kling-2.6-pro'), 'kuaishou-kling-2.6-pro');
});

test('modelKeyOf 非法 vendor_key 抛 VENDOR_KEY_INVALID', () => {
  assertCode(() => modelKeyOf('OpenAI', 'gpt'), 'VENDOR_KEY_INVALID');
  assertCode(() => modelKeyOf('open_ai', 'gpt'), 'VENDOR_KEY_INVALID');
  assertCode(() => modelKeyOf('', 'gpt'), 'VENDOR_KEY_INVALID');
  assertCode(() => modelKeyOf('-openai', 'gpt'), 'VENDOR_KEY_INVALID');
  assertCode(() => modelKeyOf('openai-', 'gpt'), 'VENDOR_KEY_INVALID');
  assertCode(() => modelKeyOf(null, 'gpt'), 'VENDOR_KEY_INVALID');
});

test('VENDOR_KEY_RE 接受含短横线小写 slug', () => {
  assert.equal(VENDOR_KEY_RE.test('black-forest-labs'), true);
  assert.equal(VENDOR_KEY_RE.test('kuaishou'), true);
  assert.equal(VENDOR_KEY_RE.test('a'), true);
  assert.equal(VENDOR_KEY_RE.test('Black-Forest'), false);
  assert.equal(VENDOR_KEY_RE.test('a--b'), false);
});

test('parseModelKey 最长前缀切分支持含短横线厂商', () => {
  const vendors = ['openai', 'black-forest-labs', 'black'];
  assert.deepEqual(
    parseModelKey('black-forest-labs-flux-2-pro', vendors),
    { vendor_key: 'black-forest-labs', identity: 'flux-2-pro' },
  );
  assert.deepEqual(parseModelKey('openai-gpt-5.6-sol', vendors), { vendor_key: 'openai', identity: 'gpt-5.6-sol' });
  assert.deepEqual(parseModelKey('black-turbo', vendors), { vendor_key: 'black', identity: 'turbo' });
});

test('parseModelKey 无命中与非法输入返回 null', () => {
  const vendors = ['openai'];
  assert.equal(parseModelKey('zhipu-glm-5', vendors), null);
  assert.equal(parseModelKey('openai-', vendors), null);
  assert.equal(parseModelKey('openai', vendors), null);
  assert.equal(parseModelKey('', vendors), null);
  assert.equal(parseModelKey(null, vendors), null);
  assert.equal(parseModelKey('openai-gpt', null), null);
  assert.equal(parseModelKey('openai-gpt', []), null);
});

test('isModelIdentity 仅接受已归一化形态', () => {
  assert.equal(isModelIdentity('gpt-5.6-sol'), true);
  assert.equal(isModelIdentity('gpt-5.6'), true);
  assert.equal(isModelIdentity('flux-2-pro'), true);
  assert.equal(isModelIdentity('5.6'), true);
  assert.equal(isModelIdentity('GPT-5.6'), false);
  assert.equal(isModelIdentity('gpt--5'), false);
  assert.equal(isModelIdentity('-gpt'), false);
  assert.equal(isModelIdentity('gpt_5'), false);
  assert.equal(isModelIdentity('a.b'), false);
  assert.equal(isModelIdentity('gpt 5'), false);
  assert.equal(isModelIdentity(''), false);
  assert.equal(isModelIdentity(null), false);
  assert.equal(isModelIdentity(42), false);
});

test('isModelKey 语法判定', () => {
  assert.equal(isModelKey('openai-gpt-5.6-sol'), true);
  assert.equal(isModelKey('kuaishou-kling-2.6-pro'), true);
  assert.equal(isModelKey('black-forest-labs-flux-2'), true);
  assert.equal(isModelKey('openai-5.6'), true);
  assert.equal(isModelKey('gpt-5.6-sol'), true);
  assert.equal(isModelKey('a.b'), false);
  assert.equal(isModelKey('-gpt-5'), false);
  assert.equal(isModelKey('gpt-'), false);
  assert.equal(isModelKey('gpt'), false);
  assert.equal(isModelKey(''), false);
  assert.equal(isModelKey(null), false);
});

test('findModelKeyCollisions 返回重复分组且跳过缺失键', () => {
  const entries = [
    { id: 'tool-level3:a', model_key: 'openai-gpt-5.6' },
    { id: 'tool-level3:b', model_key: 'openai-gpt-5.6' },
    { id: 'tool-level3:c', model_key: 'kuaishou-kling-2.6-pro' },
    { id: 'tool-level3:d' },
    { id: 'tool-level3:e', model_key: '' },
    'not-an-object',
  ];
  assert.deepEqual(findModelKeyCollisions(entries), [
    { model_key: 'openai-gpt-5.6', members: ['tool-level3:a', 'tool-level3:b'] },
  ]);
  assert.deepEqual(findModelKeyCollisions([]), []);
  assert.deepEqual(findModelKeyCollisions(null), []);
  assert.deepEqual(findModelKeyCollisions([{ model_key: 'only-one' }]), []);
});
