'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let featured;
let dataFilters;
test.before(async () => {
  featured = await import('../../src/web/js/views/featured.js');
  dataFilters = await import('../../src/web/js/data/data-filters.js');
});

test('featured picks stay active on their expiry day and expire the next day', () => {
  const pick = { tool_id: 'some-tool', featured_until: '2026-09-17' };
  assert.equal(featured.isFeaturedActive(pick, '2026-09-16'), true);
  assert.equal(featured.isFeaturedActive(pick, '2026-09-17'), true);
  assert.equal(featured.isFeaturedActive(pick, '2026-09-18'), false);
});

test('featured picks without expiry info are kept and null picks are dropped', () => {
  assert.equal(featured.isFeaturedActive({ tool_id: 'no-expiry' }, '2026-01-01'), true);
  assert.equal(featured.isFeaturedActive(null, '2026-01-01'), false);
});

test('beijing date key converts by fixed UTC+8 offset', () => {
  assert.equal(featured.beijingDateKeyOf(new Date('2026-09-17T15:30:00Z')), '2026-09-17');
  assert.equal(featured.beijingDateKeyOf(new Date('2026-09-17T16:30:00Z')), '2026-09-18');
  assert.equal(featured.beijingDateKeyOf(new Date('2026-01-01T16:30:00Z')), '2026-01-02');
});

test('matchesActiveFilters ANDs access, price, theme, and scene', () => {
  const item = { access_level: '开放', price_badge: 'free', theme: 'dev', scenes: ['写代码', '数据分析'] };
  const all = { access: 'all', price: 'all', theme: 'all', scene: 'all' };
  assert.equal(dataFilters.matchesActiveFilters(item, all), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, access: '开放' }), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, access: '受限' }), false);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, price: 'free' }), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, price: 'paid' }), false);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, theme: 'dev' }), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, theme: 'media' }), false);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, scene: '写代码' }), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, scene: '写论文' }), false);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, access: '开放', price: 'free', theme: 'dev', scene: '数据分析' }), true);
  assert.equal(dataFilters.matchesActiveFilters(item, { ...all, theme: 'dev', scene: '写论文' }), false);
  assert.equal(dataFilters.matchesActiveFilters(null, all), false);
  assert.equal(dataFilters.matchesActiveFilters(item, null), true);
  assert.equal(dataFilters.matchesActiveFilters({ scenes: [] }, { access: 'all', price: 'all', theme: 'all', scene: '写代码' }), false);
});

test('vendor cards ignore theme and scene filters but keep access and price', () => {
  const all = { access: 'all', price: 'all', theme: 'all', scene: 'all' };
  const vendor = { access_level: '开放', price_badge: 'free' };
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, theme: 'dev' }), true);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, scene: '写论文' }), true);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, theme: 'dev', scene: '写论文' }), true);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, access: '开放' }), true);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, access: '受限' }), false);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, price: 'free' }), true);
  assert.equal(dataFilters.matchesVendorActiveFilters(vendor, { ...all, price: 'paid' }), false);
  assert.equal(dataFilters.matchesVendorActiveFilters(null, all), false);
});

test('vendor search includes series and model names but excludes hidden history details', () => {
  const text = dataFilters.vendorSearchTextOf(
    { vendor_key: 'openai', title: 'OpenAI', search_terms: ['API'] },
    [{ vendor_key: 'openai', title: 'OpenAI 产品' }],
    [{ vendor_key: 'openai', id: 'vendor-level2:openai:gpt-image', title: 'GPT-Image', detail_refs: [{ id: 'tool-level3:gpt-images-2-5' }, { id: 'tool-level3:old-image' }] }],
    [{ vendor_key: 'openai', id: 'tool-level3:gpt-images-2-5', title: 'GPT Images 2.5' }, { vendor_key: 'openai', id: 'tool-level3:old-image', title: 'Old Image', visibility: 'hidden_history' }],
  );
  assert.match(text, /gpt-image/);
  assert.match(text, /gpt images 2\.5/);
  assert.doesNotMatch(text, /old image/);
});

test('tool view full AND semantics stay unchanged alongside the vendor subset wrapper', () => {
  const all = { access: 'all', price: 'all', theme: 'all', scene: 'all' };
  const tool = { access_level: '开放', price_badge: 'free', theme: 'dev', scenes: ['写论文'] };
  assert.equal(dataFilters.matchesActiveFilters(tool, { ...all, theme: 'dev', scene: '写论文' }), true);
  assert.equal(dataFilters.matchesActiveFilters(tool, { ...all, theme: 'media', scene: '写论文' }), false);
  assert.equal(dataFilters.matchesActiveFilters({ access_level: '开放', price_badge: 'free' }, { ...all, theme: 'dev' }), false);
});

test('collectSceneOptions dedupes, sorts by frequency, and caps the result', () => {
  const items = [
    { scenes: ['写论文', '写代码'] },
    { scenes: ['写论文'] },
    { scenes: ['写论文', '画画'] },
    { scenes: [] },
    {},
  ];
  const options = dataFilters.collectSceneOptions(items);
  assert.deepEqual(options.map(option => option.value), ['写论文', '写代码', '画画']);
  assert.deepEqual(options.map(option => option.count), [3, 1, 1]);
  assert.equal(dataFilters.collectSceneOptions(items, 2).length, 2);
  assert.deepEqual(dataFilters.collectSceneOptions([]), []);
  assert.deepEqual(dataFilters.collectSceneOptions(null), []);
});
