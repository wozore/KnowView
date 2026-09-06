'use strict';

/**
 * model-identity-verification.test.js —— 官方身份核验回归（全离线）
 *
 * adapters / suggestIdentity / ledger 全部注入 mock，绝不真实联网；
 * receipts 写入临时目录注入，不触碰 data/manual/tools 真实文件。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  IDENTITY_VERIFICATION_TTL_MS,
  buildIdentitySuggestInstructions,
  validateIdentitySuggestionValue,
  identityAppearsInBody,
  findReusableReceipt,
  verifyModelIdentity,
  catalogModelKeyIndex,
  discoverSeriesMembers,
  readIdentityReceipts,
  appendIdentityReceipts,
} = require('../../src/catalog/intake/model-identity-verification');
const { emptySnapshot } = require('../../src/catalog/core/index');

function ledger(limits = {}) {
  const table = { search_queries: 10, pages: 10, responses_calls: 10, synthesis_calls: 10, ...limits };
  const spent = Object.fromEntries(Object.keys(table).map(key => [key, 0]));
  return {
    reserve(category, amount = 1) {
      if (!(category in table)) return { ok: false, code: 'COST_CATEGORY_UNKNOWN', category };
      if (spent[category] + amount > table[category]) return { ok: false, code: 'COST_BUDGET_EXHAUSTED', category };
      spent[category] += amount;
      return { ok: true };
    },
    snapshot: () => ({ limits: table, spent }),
  };
}

function adaptersFor(pages, sources = [{ url: 'https://docs.vendor.example/models/gpt-5-6' }]) {
  return {
    discoverOfficialSources: async () => sources,
    acquireOfficialSources: async () => pages,
  };
}

function goodSuggestion(overrides = {}) {
  return {
    ok: true,
    value: {
      entity_class: 'model',
      vendor_key: 'openai',
      identity: 'gpt-5.6-sol',
      series_title: 'GPT-5.6',
      family: 'gpt',
      confidence: 0.9,
      reasons: ['官方模型列表含 GPT-5.6 Sol，标注 API 可调用'],
      ...overrides,
    },
  };
}

const BODY = 'GPT 5.6 Sol 是 OpenAI 当前旗舰模型，API 可调用；定价见官方 pricing 页。Terra 与 Luna 为同代档位。';

// ── identityAppearsInBody ─────────────────────────────────────

test('identityAppearsInBody 命中分隔符变体，未出现返回 false', () => {
  assert.equal(identityAppearsInBody('gpt-5.6', 'GPT-5.6 发布了'), true);
  assert.equal(identityAppearsInBody('gpt-5.6', 'gpt 5.6 很强'), true);
  assert.equal(identityAppearsInBody('gpt-5.6', 'GPT5.6 API'), true);
  assert.equal(identityAppearsInBody('claude-opus-4-8', 'Claude Opus 4.8 发布'), true);
  assert.equal(identityAppearsInBody('gpt-5.6', '本段完全不含候选'), false);
  assert.equal(identityAppearsInBody('', '任意正文'), false);
  assert.equal(identityAppearsInBody('gpt-5.6', ''), false);
});

// ── catalogModelKeyIndex ──────────────────────────────────────

test('catalogModelKeyIndex 显式 model_key 优先，存量回退 modelKeyOf(vendor,title)', () => {
  const snap = emptySnapshot();
  snap['tool-level3'].push({ id: 'tool-level3:gpt-5.6-sol', vendor_key: 'openai', title: 'GPT-5.6 Sol', model_key: 'openai-gpt-5.6-sol' });
  snap['tool-level3'].push({ id: 'tool-level3:legacy-model', vendor_key: 'deepseek', title: 'DeepSeek V4 Flash' });
  snap['tool-card'].push({ id: 'deepseek-v4-flash', vendor_key: 'deepseek', title: 'DeepSeek V4 Flash', detail_ref: { kind: 'tool-level3', id: 'tool-level3:legacy-model' } });
  const idx = catalogModelKeyIndex(snap);
  assert.equal(idx.get('openai-gpt-5.6-sol')[0].kind, 'tool-level3', '显式 model_key 直接采用');
  // 存量无 model_key：回退 modelKeyOf(vendor_key, normalizeModelIdentity(title))——title 含品牌词时 key 为 deepseek-deepseek-v4-flash
  assert.ok(idx.has('deepseek-deepseek-v4-flash'), '存量记录按 vendor+title 程序重算');
  const entries = idx.get('deepseek-deepseek-v4-flash');
  assert.ok(entries.some(entry => entry.kind === 'tool-level3' && entry.detail_id === 'tool-level3:legacy-model'));
  assert.ok(entries.some(entry => entry.kind === 'tool-card' && entry.tool_card_id === 'deepseek-v4-flash'));
});

// ── verifyModelIdentity：成功路径 ─────────────────────────────

test('verifyModelIdentity 成功：model_key 程序重算、正文命中、receipt 五 revision 齐全', async () => {
  const snap = emptySnapshot();
  const result = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model', official_urls: ['https://docs.vendor.example/models'] },
    {
      snapshot: snap,
      policyRevision: 'policy-rev-1',
      bridgeRevision: 'bridge-rev-1',
      ledger: ledger(),
      now: new Date('2026-09-01T00:00:00Z'),
      suggestIdentity: async () => goodSuggestion(),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/models/gpt-5-6', body_text: BODY }]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verdict.vendor_key, 'openai');
  assert.equal(result.verdict.model_key, 'openai-gpt-5.6-sol', 'model_key 必须经 modelKeyOf 程序重算');
  assert.equal(result.verdict.evidence.official_url, 'https://docs.vendor.example/models/gpt-5-6');
  assert.match(result.verdict.evidence.content_hash, /^sha256:/);
  assert.equal(result.receipt.identity_key, 'gpt-5.6-sol');
  assert.equal(result.receipt.policy_revision, 'policy-rev-1');
  assert.equal(result.receipt.bridge_revision, 'bridge-rev-1');
  assert.match(result.receipt.receipt_id, /^receipt-[0-9a-f]{12}$/);
  assert.equal(result.reused, undefined);
});

// ── verifyModelIdentity：receipt 五条件复用 ───────────────────

test('verifyModelIdentity 五条件全等且 ≤24h 复用 receipt，零 adapters 调用', async () => {
  const snap = emptySnapshot();
  const { revisionOf } = require('../../src/catalog/core/catalog-revision');
  const catalogRevision = revisionOf(snap);
  const receipt = {
    receipt_id: 'receipt-aaaaaaaaaaaa',
    candidate_name: 'GPT-5.6 Sol',
    identity_key: 'gpt-5.6-sol',
    entity_class: 'model',
    vendor_key: 'openai',
    model_key: 'openai-gpt-5.6-sol',
    series_title: 'GPT-5.6',
    family: 'gpt',
    confidence: 0.9,
    evidence: { official_url: 'https://docs.vendor.example/models', content_hash: 'sha256:abc' },
    catalog_revision: catalogRevision,
    policy_revision: 'p1',
    bridge_revision: 'b1',
    verified_at: '2026-08-31T23:00:00.000Z',
  };
  let adapterCalls = 0;
  const countingAdapters = {
    discoverOfficialSources: async () => { adapterCalls += 1; return []; },
    acquireOfficialSources: async () => [],
  };
  const result = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model', official_urls: ['https://docs.vendor.example/models'] },
    {
      snapshot: snap, policyRevision: 'p1', bridgeRevision: 'b1', receipts: [receipt],
      ledger: ledger(), now: '2026-09-01T10:00:00Z',
      suggestIdentity: async () => { throw new Error('复用路径不得调 AI'); },
    },
    countingAdapters,
  );
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.verdict.model_key, 'openai-gpt-5.6-sol');
  assert.equal(adapterCalls, 0, 'receipt 复用不得访问网络');

  // TTL 过期（>24h）→ 不复用，走完整核验
  const stale = { ...receipt, verified_at: '2026-08-30T00:00:00.000Z' };
  const expired = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model', official_urls: ['https://docs.vendor.example/models'] },
    {
      snapshot: snap, policyRevision: 'p1', bridgeRevision: 'b1', receipts: [stale],
      ledger: ledger(), now: '2026-09-01T10:00:00Z',
      suggestIdentity: async () => goodSuggestion({ identity: 'gpt-5-6-sol' }),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/models', body_text: 'gpt-5-6-sol 官方正文' }]),
  );
  assert.equal(expired.ok, true);
  assert.equal(expired.reused, undefined);
  assert.ok(Date.parse(stale.verified_at) + IDENTITY_VERIFICATION_TTL_MS < Date.parse('2026-09-01T10:00:00Z'));

  // revision 漂移 → 不复用
  const drifted = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model', official_urls: ['https://docs.vendor.example/models'] },
    {
      snapshot: snap, policyRevision: 'p2', bridgeRevision: 'b1', receipts: [receipt],
      ledger: ledger(), now: '2026-09-01T10:00:00Z',
      suggestIdentity: async () => goodSuggestion(),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/models', body_text: BODY }]),
  );
  assert.equal(drifted.ok, true);
  assert.equal(drifted.reused, undefined);
});

// ── findReusableReceipt：五条件逐条 ───────────────────────────

test('findReusableReceipt 五条件缺一不可', () => {
  const base = {
    receipt_id: 'receipt-b2', candidate_name: 'X', identity_key: 'x',
    evidence: { official_url: 'https://a.example/', content_hash: 'sha256:h' },
    catalog_revision: 'c1', policy_revision: 'p1', bridge_revision: 'b1',
    verified_at: '2026-09-01T00:00:00Z',
  };
  const expected = {
    candidateName: 'X', officialUrls: ['https://a.example/'],
    catalogRevision: 'c1', policyRevision: 'p1', bridgeRevision: 'b1',
  };
  assert.equal(findReusableReceipt([base], expected, Date.parse('2026-09-01T12:00:00Z')), base);
  assert.equal(findReusableReceipt([{ ...base, identity_key: 'other' }], expected), null, '候选名不等');
  assert.equal(findReusableReceipt([{ ...base, catalog_revision: 'c2' }], expected), null, 'catalog revision 漂移');
  assert.equal(findReusableReceipt([{ ...base, policy_revision: 'p2' }], expected), null, 'policy revision 漂移');
  assert.equal(findReusableReceipt([{ ...base, bridge_revision: 'b2' }], expected), null, 'bridge revision 漂移');
  assert.equal(findReusableReceipt([{ ...base, evidence: { ...base.evidence, official_url: 'https://other.example/' } }], expected), null, '官方 URL 不等');
  assert.equal(findReusableReceipt([{ ...base, evidence: { official_url: 'https://a.example/', content_hash: '' } }], expected), null, '正文 hash 缺失');
  assert.equal(findReusableReceipt([{ ...base, verified_at: '2026-08-30T00:00:00Z' }], expected, Date.parse('2026-09-01T12:00:00Z')), null, '超过 24h');
});

// ── verifyModelIdentity：fail-closed 全码 ─────────────────────

test('verifyModelIdentity：无官方源/无正文 → IDENTITY_EVIDENCE_MISSING', async () => {
  const common = {
    snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b',
    ledger: ledger(), suggestIdentity: async () => goodSuggestion(),
  };
  const noSource = await verifyModelIdentity(
    { name: 'Ghost Model', entity_type: 'model' },
    common,
    adaptersFor([], []),
  );
  assert.equal(noSource.ok, false);
  assert.equal(noSource.code, 'IDENTITY_EVIDENCE_MISSING');

  const noBody = await verifyModelIdentity(
    { name: 'Ghost Model', entity_type: 'model' },
    common,
    adaptersFor([{ url: 'https://a.example/', body_text: '   ' }]),
  );
  assert.equal(noBody.ok, false);
  assert.equal(noBody.code, 'IDENTITY_EVIDENCE_MISSING');

  const noAdapters = await verifyModelIdentity({ name: 'X', entity_type: 'model' }, common, {});
  assert.equal(noAdapters.code, 'IDENTITY_EVIDENCE_MISSING');
});

test('verifyModelIdentity：名称未出现在官方正文 → IDENTITY_NAME_NOT_IN_BODY', async () => {
  const result = await verifyModelIdentity(
    { name: 'Phantom Model', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => goodSuggestion({ identity: 'phantom-model' }),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/x', body_text: '正文里只有别家产品和一些无关介绍，没有候选相关的条目。' }]),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDENTITY_NAME_NOT_IN_BODY');
});

test('verifyModelIdentity：多域正文同时命中 → IDENTITY_EVIDENCE_CONFLICT', async () => {
  const result = await verifyModelIdentity(
    { name: 'Contested Model', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => goodSuggestion({ identity: 'contested-model', vendor_key: 'openai' }),
    },
    adaptersFor([
      { url: 'https://docs.vendor-a.example/m', body_text: 'contested model 在此' },
      { url: 'https://docs.vendor-b.example/m', body_text: 'contested model 也在此' },
    ]),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDENTITY_EVIDENCE_CONFLICT');
});

test('verifyModelIdentity：低置信 / 厂商非法 → IDENTITY_LOW_CONFIDENCE', async () => {
  const low = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => goodSuggestion({ confidence: 0.3 }),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/m', body_text: BODY }]),
  );
  assert.equal(low.ok, false);
  assert.equal(low.code, 'IDENTITY_LOW_CONFIDENCE');

  const badVendor = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => goodSuggestion({ vendor_key: 'Unknown Vendor!' }),
    },
    adaptersFor([{ url: 'https://docs.vendor.example/m', body_text: BODY }]),
  );
  assert.equal(badVendor.ok, false);
  assert.equal(badVendor.code, 'IDENTITY_LOW_CONFIDENCE');
});

test('verifyModelIdentity：预算耗尽 → IDENTITY_BUDGET_EXHAUSTED；缺 AI → IDENTITY_AI_UNAVAILABLE', async () => {
  const exhausted = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    { snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger({ search_queries: 0 }), suggestIdentity: async () => goodSuggestion() },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }]),
  );
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'IDENTITY_BUDGET_EXHAUSTED');

  const noLedger = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    { snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', suggestIdentity: async () => goodSuggestion() },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }]),
  );
  assert.equal(noLedger.code, 'IDENTITY_BUDGET_EXHAUSTED', '无账本视为预算不可证明');

  const pagesBudget = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b',
      ledger: ledger({ pages: 0 }), suggestIdentity: async () => goodSuggestion(),
    },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }], [{ url: 'https://a.example/' }]),
  );
  assert.equal(pagesBudget.code, 'IDENTITY_BUDGET_EXHAUSTED');

  const noAi = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    { snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger() },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }]),
  );
  assert.equal(noAi.ok, false);
  assert.equal(noAi.code, 'IDENTITY_AI_UNAVAILABLE');

  const aiFail = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => ({ ok: false, code: 'PROVIDER_AUTH_REQUIRED' }),
    },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }]),
  );
  assert.equal(aiFail.code, 'IDENTITY_AI_UNAVAILABLE');

  const aiBudget = await verifyModelIdentity(
    { name: 'GPT-5.6 Sol', entity_type: 'model' },
    {
      snapshot: emptySnapshot(), policyRevision: 'p', bridgeRevision: 'b', ledger: ledger(),
      suggestIdentity: async () => ({ ok: false, code: 'COST_BUDGET_EXHAUSTED' }),
    },
    adaptersFor([{ url: 'https://a.example/', body_text: BODY }]),
  );
  assert.equal(aiBudget.code, 'IDENTITY_BUDGET_EXHAUSTED');
});

// ── discoverSeriesMembers ─────────────────────────────────────

test('discoverSeriesMembers：只有官方正文命中的成员才收，model_key 程序重算', async () => {
  const verdict = {
    entity_class: 'series', vendor_key: 'openai', model_key: 'openai-gpt-5.6',
    series_title: 'GPT-5.6', family: 'gpt', confidence: 0.9,
    evidence: { official_url: 'https://docs.vendor.example/gpt-5-6', content_hash: 'sha256:x' },
  };
  const seriesAdapters = adaptersFor(
    [{ url: 'https://docs.vendor.example/gpt-5-6', body_text: 'GPT-5.6 系列包含 GPT-5.6 Sol、GPT-5.6 Terra 与 GPT-5.6 Luna 三个可调用型号。' }],
    [{ url: 'https://docs.vendor.example/gpt-5-6' }],
  );
  const result = await discoverSeriesMembers(verdict, seriesAdapters, {
    ledger: ledger(),
    suggestSeriesMembers: async () => ({
      members: [
        { name: 'GPT-5.6 Sol' },
        { name: 'GPT-5.6 Terra' },
        { name: 'GPT-5.6 Luna' },
        { name: 'GPT-5.6 Quantum' },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.members.map(member => member.identity_key), ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], 'Quantum 未在正文出现，绝不收录');
  assert.equal(result.members[0].model_key, 'openai-gpt-5.6-sol');
  assert.match(result.members[0].evidence.content_hash, /^sha256:/);

  const noAi = await discoverSeriesMembers(verdict, seriesAdapters, { ledger: ledger() });
  assert.equal(noAi.code, 'IDENTITY_AI_UNAVAILABLE');
});

// ── receipts 文件读写（临时目录） ─────────────────────────────

test('readIdentityReceipts/appendIdentityReceipts：临时目录写入、receipt_id 去重、7 天 TTL 压缩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-receipts-'));
  const file = path.join(dir, 'identity-receipts.json');
  const options = { file, now: new Date('2026-09-01T00:00:00Z') };
  assert.deepEqual(readIdentityReceipts({ file }), [], '缺失文件回退空');

  const receipt = {
    receipt_id: 'receipt-111111111111', candidate_name: 'X', identity_key: 'x',
    evidence: { official_url: 'https://a.example/', content_hash: 'sha256:h' },
    catalog_revision: 'c', policy_revision: 'p', bridge_revision: 'b',
    verified_at: '2026-08-28T00:00:00Z',
  };
  const stale = {
    receipt_id: 'receipt-222222222222', candidate_name: 'Y', identity_key: 'y',
    evidence: { official_url: 'https://a.example/', content_hash: 'sha256:h' },
    catalog_revision: 'c', policy_revision: 'p', bridge_revision: 'b',
    verified_at: '2026-08-01T00:00:00Z', // > 7 天
  };
  const kept = appendIdentityReceipts([receipt, stale], options);
  assert.equal(kept.length, 1, '超 7 天回执被 TTL 压缩');
  assert.equal(kept[0].receipt_id, 'receipt-111111111111');
  assert.deepEqual(readIdentityReceipts({ file }), kept, '读回一致');

  const updated = { ...receipt, confidence: 0.95 };
  const merged = appendIdentityReceipts([updated], options);
  assert.equal(merged.length, 1, 'receipt_id 去重，新覆盖旧');
  assert.equal(merged[0].confidence, 0.95);

  // 损坏文件回退空
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(readIdentityReceipts({ file }), []);
});

// ── prompt 约束与 AI 结构校验 ─────────────────────────────────

test('身份建议 prompt 约束：只依据官方可调用性证据、禁止按名称后缀判断', () => {
  const text = buildIdentitySuggestInstructions();
  assert.match(text, /可调用性\/能力\/价格\/状态证据/);
  assert.match(text, /禁止按名称后缀/);
  assert.match(text, /series（版本代际\/产品线/);
  assert.match(text, /必须来自官方正文原词/);
});

test('validateIdentitySuggestionValue：结构非法一律拒绝', () => {
  assert.equal(validateIdentitySuggestionValue(goodSuggestion().value), true);
  assert.equal(validateIdentitySuggestionValue({ ...goodSuggestion().value, entity_class: 'tool' }), false);
  assert.equal(validateIdentitySuggestionValue({ ...goodSuggestion().value, confidence: 1.5 }), false);
  assert.equal(validateIdentitySuggestionValue({ ...goodSuggestion().value, identity: '' }), false);
  assert.equal(validateIdentitySuggestionValue({ ...goodSuggestion().value, reasons: 'no' }), false);
  assert.equal(validateIdentitySuggestionValue(null), false);
});
