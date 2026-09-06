'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let isHiddenHistory, buildSeriesIndex, matchSeries, deriveWordForms;
test.before(async () => {
  ({ isHiddenHistory, buildSeriesIndex, matchSeries, deriveWordForms } = await import('../../src/web/js/data/model-series-index.mjs'));
});

function card(id, overrides = {}) {
  return {
    id: `tool-card:${id}`,
    tool_key: id,
    vendor_key: 'openai',
    title: id,
    vendor_label: 'OpenAI',
    theme: 'general',
    scenes: [],
    search_terms: [],
    detail_ref: { kind: 'tool-level3', id: `tool-level3:${id}` },
    detail_kind: 'api_model',
    ...overrides,
  };
}

function detail(id, overrides = {}) {
  return { id: `tool-level3:${id}`, detail_kind: 'api_model', visibility: overrides.visibility, ...overrides };
}

function level2(id, overrides = {}) {
  return {
    id,
    vendor_key: 'openai',
    title: id.replace('vendor-level2:openai:', ''),
    series_kind: overrides.series_kind ?? null,
    detail_refs: overrides.detail_refs || [],
    ...overrides,
  };
}

function sampleCards() {
  return [
    card('gpt-5-6-sol', { title: 'GPT-5.6 Sol', search_terms: ['GPT-5.6 Sol', 'GPT'] }),
    card('gpt-5-6-terra', { title: 'GPT-5.6 Terra', search_terms: ['GPT-5.6 Terra', 'GPT'] }),
    card('gpt-4o', { title: 'GPT-4o', search_terms: ['GPT-4o'] }),
    card('writer-pro', { title: '写作助手 Pro', detail_kind: 'tool', search_terms: ['写作助手'] }),
  ];
}

function sampleLevel2s(level3s) {
  return [
    level2('vendor-level2:openai:gpt-5-6', { title: 'GPT-5.6', detail_refs: [
      { kind: 'tool-level3', id: 'tool-level3:gpt-5-6-sol' },
      { kind: 'tool-level3', id: 'tool-level3:gpt-5-6-terra' },
    ] }),
    level2('vendor-level2:openai:gpt-4', { title: 'GPT-4', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:gpt-4o' }] }),
  ];
}

function sampleLevel3s() {
  return [detail('gpt-5-6-sol'), detail('gpt-5-6-terra'), detail('gpt-4o')];
}

function sampleIndex() {
  return buildSeriesIndex({ toolCards: sampleCards(), level2s: sampleLevel2s(), level3s: sampleLevel3s() });
}

test('isHiddenHistory 仅对显式 hidden_history 为真（undefined 视为可见）', () => {
  assert.equal(isHiddenHistory({ visibility: 'hidden_history' }), true);
  assert.equal(isHiddenHistory({ visibility: 'visible' }), false);
  assert.equal(isHiddenHistory({}), false);
  assert.equal(isHiddenHistory(null), false);
});

test('deriveWordForms 产出整词与首段词形', () => {
  assert.deepEqual(deriveWordForms('GPT-5.6 Sol'), ['GPT-5.6 Sol', 'GPT']);
  assert.deepEqual(deriveWordForms('GPT-5.6'), ['GPT-5.6', 'GPT']);
  assert.deepEqual(deriveWordForms('写作助手'), ['写作助手']);
  assert.deepEqual(deriveWordForms(''), []);
});

test('buildSeriesIndex 存量回退：无 series_kind 但任一成员 api_model 记为系列', () => {
  const index = sampleIndex();
  assert.deepEqual(index.series.map(entry => entry.series_id), ['vendor-level2:openai:gpt-5-6', 'vendor-level2:openai:gpt-4']);
});

test('buildSeriesIndex 非模型系列（tool_series/无 api_model 成员）不入索引', () => {
  const index = buildSeriesIndex({
    toolCards: [card('writer-pro', { detail_kind: 'tool' })],
    level2s: [
      level2('vendor-level2:openai:writing', { title: '写作', series_kind: 'tool_series', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:writer-pro' }] }),
      level2('vendor-level2:openai:empty', { title: '空组', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:writer-pro' }] }),
    ],
    level3s: [{ id: 'tool-level3:writer-pro', detail_kind: 'tool' }],
  });
  assert.deepEqual(index.series, []);
});

test('buildSeriesIndex 剔除 hidden_history 成员（卡与三级任一隐藏即剔除）', () => {
  const hiddenCard = card('gpt-5-6-terra', { title: 'GPT-5.6 Terra', visibility: 'hidden_history' });
  const index = buildSeriesIndex({
    toolCards: [card('gpt-5-6-sol', { title: 'GPT-5.6 Sol' }), hiddenCard],
    level2s: [level2('vendor-level2:openai:gpt-5-6', { title: 'GPT-5.6', detail_refs: [
      { kind: 'tool-level3', id: 'tool-level3:gpt-5-6-sol' },
      { kind: 'tool-level3', id: 'tool-level3:gpt-5-6-terra' },
    ] })],
    level3s: [detail('gpt-5-6-sol'), detail('gpt-5-6-terra', { visibility: 'hidden_history' })],
  });
  assert.deepEqual(index.series[0].member_cards.map(item => item.tool_key), ['gpt-5-6-sol']);
});

test('matchSeries 系列词返回全部可见成员且 role 为 series', () => {
  const result = matchSeries(sampleIndex(), 'GPT-5.6 有什么新特性');
  assert.ok(result);
  assert.equal(result.role, 'series');
  assert.deepEqual(result.entries.map(entry => entry.card.tool_key), ['gpt-5-6-sol', 'gpt-5-6-terra']);
  assert.deepEqual(result.entries[0].series_context, {
    series_id: 'vendor-level2:openai:gpt-5-6',
    series_title: 'GPT-5.6',
    role: 'series',
    member_count: 2,
  });
});

test('matchSeries 更长成员词只返回该成员且 role 为 member', () => {
  const result = matchSeries(sampleIndex(), 'GPT-5.6 Sol 怎么样');
  assert.ok(result);
  assert.equal(result.role, 'member');
  assert.deepEqual(result.entries.map(entry => entry.card.tool_key), ['gpt-5-6-sol']);
  assert.equal(result.entries[0].series_context.role, 'member');
  assert.equal(result.entries[0].series_context.series_title, 'GPT-5.6');
});

test('matchSeries 系列词与成员词等长时系列优先', () => {
  // 成员卡 "GPT-4o" 首段词形 "gpt" 与系列标题 "GPT-5.6" 的 "gpt-5-6" 无关；
  // 构造等长场景：系列标题与成员 title 同词形长度 "writer"。
  const index = buildSeriesIndex({
    toolCards: [card('writer', { title: 'Writer' })],
    level2s: [level2('vendor-level2:openai:writer', { title: 'Writer', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:writer' }] })],
    level3s: [detail('writer')],
  });
  const result = matchSeries(index, 'Writer');
  assert.ok(result);
  assert.equal(result.role, 'series');
  assert.deepEqual(result.entries.map(entry => entry.card.tool_key), ['writer']);
});

test('matchSeries 非系列成员的一般工具不进入系列层（交由 content 平铺层）', () => {
  assert.equal(matchSeries(sampleIndex(), '写作助手好吗'), null);
});

test('matchSeries 无命中与空输入返回 null', () => {
  assert.equal(matchSeries(sampleIndex(), '完全无关的查询词'), null);
  assert.equal(matchSeries(null, 'GPT'), null);
  assert.equal(matchSeries(sampleIndex(), ''), null);
});

test('matchSeries 大小写与全角归一化匹配', () => {
  const result = matchSeries(sampleIndex(), 'ｇｐｔ－４ｏ 怎么样');
  assert.ok(result);
  assert.equal(result.role, 'member');
  assert.equal(result.entries[0].card.tool_key, 'gpt-4o');
  assert.equal(result.entries[0].series_context.series_title, 'GPT-4');
});
