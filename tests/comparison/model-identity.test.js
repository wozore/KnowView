'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeVendor,
  normalizeVersionSeparators,
  parseModelNameMetadata,
  removeTerminalOfferings,
  resolveModelIdentity,
} = require('../../src/comparison/identity/model-identity');

test('模型身份：跨源点号/连字符版本号统一，服务方式不生成新实体', () => {
  const lmarena = resolveModelIdentity({ source: 'lmarena', rawName: 'Claude Opus 4.8', vendorHint: 'anthropic' });
  const livebench = resolveModelIdentity({ source: 'livebench', rawName: 'claude-opus-4-8-high', vendorHint: 'anthropic' });
  const lmarenaDegree = resolveModelIdentity({ source: 'lmarena', rawName: 'claude-opus-4-8-xhigh', vendorHint: 'anthropic' });
  const batch = resolveModelIdentity({ source: 'openrouter', rawName: 'anthropic/claude-opus-4.8-batch' });
  const fast = resolveModelIdentity({ source: 'openrouter', rawName: 'anthropic/claude-opus-4.8-fast' });

  assert.equal(lmarena.model_key, 'anthropic--claude-opus-4.8');
  assert.equal(livebench.model_key, lmarena.model_key);
  assert.equal(lmarenaDegree.model_key, lmarena.model_key);
  assert.equal(batch.model_key, lmarena.model_key);
  assert.equal(fast.model_key, lmarena.model_key);
  assert.deepEqual(batch.offerings, ['batch']);
  assert.deepEqual(fast.offerings, ['fast']);
});

test('模型身份：参数规模、MoE 与能力模式是实体身份，绝不被互并', () => {
  const keys = [
    'qwen/qwen3-8b',
    'qwen/qwen3-32b',
    'qwen/qwen3-235b-a22b',
    'qwen/qwen3-235b-a22b-thinking',
  ].map(rawName => resolveModelIdentity({ source: 'openrouter', rawName }).model_key);

  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [
    'qwen--qwen3-8b',
    'qwen--qwen3-32b',
    'qwen--qwen3-235b-a22b',
    'qwen--qwen3-235b-a22b-thinking',
  ]);
});

test('模型身份：日期不属于实体主键，作为修订信息保留', () => {
  const older = resolveModelIdentity({ source: 'openrouter', rawName: 'deepseek/deepseek-v4-flash-0423' });
  const newer = resolveModelIdentity({ source: 'openrouter', rawName: 'deepseek/deepseek-v4-flash-0731' });

  assert.equal(older.model_key, 'deepseek--deepseek-v4-flash');
  assert.equal(newer.model_key, older.model_key);
  assert.equal(older.revision, '0423');
  assert.equal(newer.revision, '0731');
});

test('模型身份：评测环境位于 degree 之后时仍归并为同一模型', () => {
  const high = resolveModelIdentity({ source: 'lmarena', rawName: 'GPT 5.5 (High)', vendorHint: 'openai' });
  const xhigh = resolveModelIdentity({ source: 'lmarena', rawName: 'GPT 5.5 (xHigh)', vendorHint: 'openai' });
  const harnessHigh = resolveModelIdentity({ source: 'lmarena', rawName: 'gpt-5.5-high (codex-harness)', vendorHint: 'openai' });
  const harnessXhigh = resolveModelIdentity({ source: 'lmarena', rawName: 'gpt-5.5-xhigh (codex-harness)', vendorHint: 'openai' });

  for (const resolved of [high, xhigh, harnessHigh, harnessXhigh]) {
    assert.equal(resolved.model_key, 'openai--gpt-5.5');
  }
  assert.equal(high.degree, 'high');
  assert.equal(xhigh.degree, 'xhigh');
  assert.equal(harnessHigh.degree, 'high');
  assert.equal(harnessXhigh.degree, 'xhigh');
  assert.equal(harnessHigh.evaluation_profile, 'codex-harness');
  assert.equal(harnessXhigh.evaluation_profile, 'codex-harness');
  assert.deepEqual(parseModelNameMetadata('lmarena', 'gpt-image-1.5-high-fidelity'), {
    model_name: 'gpt-image-1.5-high-fidelity',
    degree: null,
    evaluation_profile: null,
    ambiguous_tokens: [],
  });
  assert.deepEqual(parseModelNameMetadata('lmarena', 'Deepseek V4 Flash (High) (20260731)'), {
    model_name: 'deepseek-v4-flash-20260731',
    degree: 'high',
    evaluation_profile: null,
    ambiguous_tokens: [],
  });
});

test('模型身份：厂商别名统一，但仅模型 key 相同才合并', () => {
  assert.equal(normalizeVendor('mistralai'), 'mistral');
  assert.equal(normalizeVendor('alibaba'), 'qwen');
  assert.equal(normalizeVendor('zai-org'), 'zhipu');
  assert.equal(normalizeVersionSeparators('claude-opus-4-8'), 'claude-opus-4.8');
  assert.deepEqual(removeTerminalOfferings('gpt-5.6-sol-batch-free'), { identity: 'gpt-5.6-sol', offerings: ['batch', 'free'], isPreview: false });
  assert.deepEqual(removeTerminalOfferings('gemini-3-flash-preview'), { identity: 'gemini-3-flash', offerings: [], isPreview: true });
});

test('模型身份：人工精确 alias 优先于自动规则', () => {
  const registry = {
    schema_version: 2,
    entries: [{
      model_key: 'anthropic--claude-opus-4.8',
      display: 'Claude Opus 4.8',
      aliases: { lmarena: ['Claude Opus 4.8 (High)'] },
    }],
  };
  const resolved = resolveModelIdentity({ source: 'lmarena', rawName: 'Claude Opus 4.8 (High)', registry });
  assert.equal(resolved.model_key, 'anthropic--claude-opus-4.8');
  assert.equal(resolved.matched_alias, true);
});

test('模型身份：-preview 剥离并作为 Preview revision 保留，与正式版共享 model_key', () => {
  const formal = resolveModelIdentity({ source: 'lmarena', rawName: 'gemini-3-flash', vendorHint: 'google' });
  const preview = resolveModelIdentity({ source: 'openrouter', rawName: 'google/gemini-3-flash-preview' });

  assert.equal(formal.model_key, 'google--gemini-3-flash');
  assert.equal(preview.model_key, 'google--gemini-3-flash');
  assert.equal(formal.revision, null);
  assert.equal(preview.revision, 'Preview');
});

test('模型身份：degree 提取支持可选 -preview 后缀，正确识别 degree 并保留 preview', () => {
  const parsed = parseModelNameMetadata('lmarena', 'deepseek-v4-pro-high-preview');
  assert.equal(parsed.degree, 'high');
  assert.equal(parsed.model_name, 'deepseek-v4-pro-preview');

  const resolved = resolveModelIdentity({ source: 'lmarena', rawName: 'deepseek-v4-pro-high-preview', vendorHint: 'deepseek' });
  assert.equal(resolved.model_key, 'deepseek--deepseek-v4-pro');
  assert.equal(resolved.degree, 'high');
  assert.equal(resolved.revision, 'Preview');
});

test('模型身份：Inception 厂商别名配置使各源 Mercury 2 实体归并', () => {
  const registry = {
    schema_version: 2,
    vendor_aliases: {
      inceptionlabs: ['inception', 'inception-ai'],
    },
  };
  const fromOpenRouter = resolveModelIdentity({ source: 'openrouter', rawName: 'inception/mercury-2', registry });
  const fromLmArena = resolveModelIdentity({ source: 'lmarena', rawName: 'mercury-2', vendorHint: 'inception-ai', registry });

  assert.equal(fromOpenRouter.vendor, 'inceptionlabs');
  assert.equal(fromLmArena.vendor, 'inceptionlabs');
  assert.equal(fromOpenRouter.model_key, 'inceptionlabs--mercury-2');
  assert.equal(fromLmArena.model_key, 'inceptionlabs--mercury-2');
});
