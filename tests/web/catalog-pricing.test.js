'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let toolCards;
let renderToolLevel3;
let originalDocument;
let originalWindow;
test.before(async () => {
  originalDocument = global.document;
  originalWindow = global.window;
  global.document = {
    createElement() {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() {
          return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
        },
      };
    },
  };
  global.window = { location: { href: 'https://example.com/' } };
  toolCards = await import('../../src/web/js/views/tool-cards.js');
  ({ renderToolLevel3 } = await import('../../src/web/js/views/tool-preview-level3.js'));
});
test.after(() => {
  if (originalDocument === undefined) delete global.document;
  else global.document = originalDocument;
  if (originalWindow === undefined) delete global.window;
  else global.window = originalWindow;
});

function plan(id, title, amount, currency, billingPeriod, conditions = '') {
  return {
    id: `tool-level3:${id}`,
    vendor_key: 'moonshot',
    detail_kind: 'subscription_plan',
    title,
    plan: { amount, currency, billing_period: billingPeriod, conditions },
  };
}

function detail(overrides = {}) {
  return {
    id: 'tool-level3:kimi-code',
    vendor_key: 'moonshot',
    detail_kind: 'tool',
    theme: 'dev',
    title: 'Kimi Code',
    official_url: 'https://example.com/kimi-code',
    summary: 'Coding agent',
    one_m_context: { status: 'not_applicable', reason: '不适用。' },
    api_pricing: { status: 'not_applicable', reason: '不是 API 单价记录。' },
    plan: { status: 'not_applicable', reason: '产品按会员方案访问。' },
    applicable_scenarios: [],
    inapplicable_scenarios: [],
    sources: [],
    subscription_plan_refs: [
      { kind: 'tool-level3', id: 'tool-level3:kimi-andante' },
      { kind: 'tool-level3', id: 'tool-level3:kimi-moderato' },
      { kind: 'tool-level3', id: 'tool-level3:kimi-allegretto' },
      { kind: 'tool-level3', id: 'tool-level3:kimi-allegro' },
    ],
    ...overrides,
  };
}

const plans = [
  plan('kimi-andante', 'Andante', 49, 'CNY', 'month'),
  plan('kimi-moderato', 'Moderato', 99, 'CNY', 'month'),
  plan('kimi-allegretto', 'Allegretto', 199, 'CNY', 'month'),
  plan('kimi-allegro', 'Allegro', 699, 'CNY', 'month'),
];

test('tool card shows a compact summary from at most two linked plan prices', () => {
  const summary = toolCards.renderPriceSummary({
    detail_ref: { id: 'tool-level3:kimi-code' },
    vendor_key: 'moonshot',
  }, detail(), plans);
  assert.match(summary, /Andante/);
  assert.match(summary, /49/);
  assert.match(summary, /Moderato/);
  assert.match(summary, /99/);
  assert.doesNotMatch(summary, /Allegretto|Allegro/);
});

test('tool detail shows every linked plan, pricing conditions, and plan navigation', () => {
  const html = renderToolLevel3({ detail: detail(), subscriptionPlans: plans });
  for (const item of plans) {
    assert.match(html, new RegExp(item.title));
    assert.ok(html.includes(String(item.plan.amount)));
    assert.ok(html.includes(`openDetail('tool-level3:${item.id.slice('tool-level3:'.length)}'`));
  }
  assert.match(html, /套餐价格/);
  assert.doesNotMatch(html, /API 价格：<\/b>不适用/);
});

test('tool detail renders an explicit disclosure when a public unit price is unavailable', () => {
  const html = renderToolLevel3({ detail: detail({
    id: 'tool-level3:mai-image-2.6',
    title: 'MAI-Image-2.6',
    subscription_plan_refs: [],
    pricing_disclosure: {
      status: 'not_published',
      text: '官方页面未列出统一单价。',
      source_urls: ['https://example.com/pricing'],
    },
    sources: [{ title: 'Official price information', url: 'https://example.com/pricing' }],
  }) });
  assert.match(html, /公开单价/);
  assert.match(html, /官方页面未列出统一单价/);
});

test('GPT Images 2.5 shows API token rates instead of ChatGPT subscription prices', () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog/tool-preview-level3.json'), 'utf8')).items;
  const item = items.find(entry => entry.id === 'tool-level3:gpt-images-2.5');
  assert.equal(item.detail_kind, 'api_model');
  assert.equal(item.api_pricing.status, 'available');
  const summary = toolCards.renderPriceSummary({ vendor_key: 'openai', detail_ref: { id: item.id } }, item, items);
  assert.match(summary, /图像输入 \$8 \/ 百万 tokens/);
  assert.match(summary, /图像输出 \$30 \/ 百万 tokens/);
  const html = renderToolLevel3({ detail: item, subscriptionPlans: items });
  assert.match(html, /<h5>API 价格<\/h5>/);
  assert.match(html, /GPT-Image-2\.5 Flare \/ Sunburst API/);
  assert.match(html, /图像输入<strong>\$8<\/strong><small> \/ 百万 tokens/);
  assert.match(html, /图像输出<strong>\$30<\/strong><small> \/ 百万 tokens/);
  assert.match(html, /文本输入<strong>\$5<\/strong><small> \/ 百万 tokens/);
  assert.doesNotMatch(html, /ChatGPT Go/);
  assert.doesNotMatch(html, /额外使用费用/);
});

test('MAI-Image-2.6 shows a channel-specific API price with source', () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog/tool-preview-level3.json'), 'utf8')).items;
  const item = items.find(entry => entry.id === 'tool-level3:mai-image-2.6');
  assert.equal(item.detail_kind, 'api_model');
  assert.equal(item.api_pricing.status, 'available');
  const summary = toolCards.renderPriceSummary({ vendor_key: 'microsoft', detail_ref: { id: item.id } }, item, items);
  assert.match(summary, /图像输入 \$8 \/ 百万 tokens/);
  assert.match(summary, /图像输出 \$38 \/ 百万 tokens/);
  const html = renderToolLevel3({ detail: item });
  assert.match(html, /<h5>API 价格<\/h5>/);
  assert.match(html, /OpenRouter API 渠道/);
  assert.match(html, /图像输入<strong>\$8<\/strong><small> \/ 百万 tokens/);
  assert.match(html, /图像输出<strong>\$38<\/strong><small> \/ 百万 tokens/);
  assert.match(html, /文本输入<strong>\$5<\/strong><small> \/ 百万 tokens/);
  assert.match(html, /Azure 费用以实际报价为准/);
  assert.match(html, /openrouter\.ai\/microsoft\/mai-image-2\.6/);
  assert.doesNotMatch(html, /额外使用费用/);
});

test('Hy Image 3.5 Preview separates token usage from CNY amount in price display', () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog/tool-preview-level3.json'), 'utf8')).items;
  const item = items.find(entry => entry.id === 'tool-level3:hy-image-3.5');
  const html = renderToolLevel3({ detail: item });
  assert.match(html, /参考费用<strong>¥0\.15<\/strong><small> \/ 张/);
  assert.match(html, /官方参考用量 15,000 tokens\/张/);
  assert.doesNotMatch(html, /¥15,000/);
});

test('non-numeric MiMo pricing notes render as text instead of currency or NaN', () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog/tool-preview-level3.json'), 'utf8')).items;
  const item = items.find(entry => entry.id === 'tool-level3:mimo-v2-5-pro');
  const html = renderToolLevel3({ detail: item });
  assert.match(html, /按套餐规定/);
  assert.match(html, /限时免费/);
  assert.doesNotMatch(html, /¥NaN|¥按套餐规定|¥限时免费/);
});
