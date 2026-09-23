'use strict';

/**
 * model-identity-verification.js —— 模型/系列官方身份核验（fail-closed）
 *
 * 职责：把"待补候选名"核验为"官方正文背书的 model/series 身份"，产出
 * verdict + receipt。不变量（T1 契约冻结）：
 *   - 绝不按名称建卡：无官方正文、名称未出现在官方域正文、证据冲突、
 *     预算耗尽、缺 AI、低置信 → { ok:false, code:IDENTITY_* }；
 *   - registry/登记表命中只是官方 URL 域提示，不免除正文核验；
 *   - AI 只建议：vendor_key 经政策归一化程序重算，model_key 必须由
 *     modelKeyOf 程序重算，identity 必须命中官方域正文（identityAppearsInBody）；
 *   - Receipt 五条件复用：候选名、catalog revision、policy revision、
 *     bridge revision、官方 URL+正文 hash 全等且 ≤24h。
 * 所有网络/AI 调用一律经 adapters/context 注入；本模块自身零网络。
 *
 * receipts 文件单一写者 = 本模块（readIdentityReceipts/appendIdentityReceipts），
 * 追加 + 7 天 TTL 压缩；默认路径 data/manual/tools/identity-receipts.json（测试可注入）。
 */

const { modelKeyOf, normalizeModelIdentity, VENDOR_KEY_RE } = require('../../shared/model-key-contract');
const { revisionOf } = require('../core/catalog-revision');
const {
  RECEIPT_TTL_MS,
  sha256Of,
  receiptIdOf,
  hostOf,
  registrableDomainOf,
  readIdentityReceipts,
  appendIdentityReceipts,
} = require('./identity-receipts');

const IDENTITY_VERIFICATION_TTL_MS = 24 * 3600 * 1000;
const IDENTITY_LOW_CONFIDENCE_THRESHOLD = 0.5;
const IDENTITY_ENTITY_CLASSES = Object.freeze(['model', 'series']);

function fail(code, error) {
  return { ok: false, code, error };
}

function isOfficialSocialDomain(domain) { return domain === 'x.com' || domain === 'twitter.com'; }

/** AI 建议 prompt（真实 adapter 使用；本模块只约定结构）。 */
function buildIdentitySuggestInstructions() {
  return '你只负责依据官方正文判断候选名是否为真实可调用的 AI 实体，并给出身份建议，不决定最终归属。硬性规则：' +
    '1) entity_class 只能取 model（官方以独立可调用型号发布的具体模型）或 series（版本代际/产品线，其下可有具体型号）。' +
    '2) 判断是否独立实体只依据官方可调用性/能力/价格/状态证据（官方模型列表、API 文档、定价页），禁止按名称后缀或档位词猜测。' +
    '3) vendor_key 只能取候选官方域名归属的厂商小写 slug；无法确定填 unknown。' +
    '4) identity 是候选名归一化形态（小写、连字符分隔），必须来自官方正文原词，禁止编造。' +
    '5) confidence 为 0~1：正文无直接证据时必须 <0.5。' +
    '输出 JSON：{"entity_class":string,"vendor_key":string,"identity":string,"series_title":string|null,"family":string|null,"confidence":number,"reasons":string[]}，禁止额外字段。';
}

/** 校验 AI 建议结构（fail-closed：结构非法一律拒绝）。 */
function validateIdentitySuggestionValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!IDENTITY_ENTITY_CLASSES.includes(value.entity_class)) return false;
  if (typeof value.vendor_key !== 'string' || !value.vendor_key) return false;
  if (typeof value.identity !== 'string' || !value.identity) return false;
  if (value.series_title !== null && typeof value.series_title !== 'string') return false;
  if (value.family !== null && typeof value.family !== 'string') return false;
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) return false;
  if (!Array.isArray(value.reasons)) return false;
  return true;
}

/**
 * 官方域正文命中判定：identity 段间允许空白/连字符/下划线/点号弹性
 * （normalize 折叠掉的分隔符在正文里可能是任意一种），
 * 'gpt-5.6' 命中 "GPT-5.6"、"gpt 5.6"、"gpt5.6"；'claude-opus-4-8' 命中 "Claude Opus 4.8"。
 */
function identityAppearsInBody(identityKey, bodyText) {
  const identity = String(identityKey || '').trim();
  const body = String(bodyText || '');
  if (!identity || !body) return false;
  const escaped = identity
    .split('-')
    .filter(Boolean)
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\-_.]?');
  if (!escaped) return false;
  return new RegExp(escaped, 'i').test(body);
}

/** Receipt 五条件复用：候选名/catalog/policy/bridge revision/官方 URL+hash 全等且 ≤24h。 */
function findReusableReceipt(receipts, expected, now = Date.now()) {
  const nowMs = Number.isFinite(now) ? now : Date.parse(now);
  const expectedUrls = normalizedUrlSet(expected.officialUrls);
  const expectedIdentity = safeIdentityKey(expected.candidateName);
  for (const receipt of receipts || []) {
    if (!receipt || typeof receipt !== 'object') continue;
    if (!expectedIdentity || receipt.identity_key !== expectedIdentity) continue;
    if (receipt.catalog_revision !== expected.catalogRevision) continue;
    if (receipt.policy_revision !== expected.policyRevision) continue;
    if (receipt.bridge_revision !== expected.bridgeRevision) continue;
    const evidence = receipt.evidence || {};
    const evidenceUrls = Array.isArray(evidence.official_urls) && evidence.official_urls.length
      ? evidence.official_urls
      : [evidence.official_url];
    if (!sameUrlSet(evidenceUrls, expectedUrls)) continue;
    if (typeof evidence.official_url !== 'string' || !expectedUrls.includes(evidence.official_url)) continue;
    if (typeof evidence.content_hash !== 'string' || !evidence.content_hash) continue;
    const verifiedMs = Date.parse(receipt.verified_at || '');
    if (!Number.isFinite(verifiedMs) || nowMs - verifiedMs > IDENTITY_VERIFICATION_TTL_MS) continue;
    return receipt;
  }
  return null;
}

function safeIdentityKey(name) { try { return normalizeModelIdentity(name); } catch { return null; } }
function normalizedUrlSet(values) { return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort(); }
function sameUrlSet(left, right) { const a = normalizedUrlSet(left); const b = normalizedUrlSet(right); return a.length === b.length && a.every((value, index) => value === b[index]); }

function sourceEvidenceOf(urls, pages, sourceRole = 'identity_evidence') { const byUrl = new Map((pages || []).map(page => [String(page.url || '').trim(), page])); return normalizedUrlSet(urls).map(url => ({ url, source_kind: 'identity_verified', source_role: sourceRole, ...(byUrl.get(url)?.content_hash ? { content_hash: byUrl.get(url).content_hash } : {}) })); }

function vendorKeyViaPolicy(policy, vendorKey, normalizeVendorKey) {
  if (typeof normalizeVendorKey === 'function') return normalizeVendorKey(policy, vendorKey);
  const text = String(vendorKey || '').trim().toLowerCase();
  return VENDOR_KEY_RE.test(text) ? text : null;
}

/**
 * 核验模型/系列官方身份（fail-closed）。
 * @param {object} candidate { name, entity_type, vendor_hint?, official_urls? }
 * @param {object} context { snapshot, policy, policyRevision, bridgeRevision, receipts?, ledger, now?, suggestIdentity?, normalizeVendorKey? }
 * @param {object} adapters { discoverOfficialSources, acquireOfficialSources }
 * @returns {Promise<{ok:true, verdict, receipt, reused?:boolean} | {ok:false, code, error?}>}
 */
async function verifyModelIdentity(candidate, context, adapters) {
  const name = String(candidate?.name || '').trim();
  if (!name) return fail('IDENTITY_EVIDENCE_MISSING', '候选名为空');
  const now = context?.now || new Date();
  const nowMs = typeof now === 'number' ? now : Date.parse(new Date(now).toISOString());
  const officialUrls = (Array.isArray(candidate.official_urls) && candidate.official_urls.length)
    ? candidate.official_urls
    : (candidate.official_url ? [candidate.official_url] : []);

  // 0. Receipt 五条件复用（零网络零 AI）
  const catalogRevision = revisionOf(context?.snapshot);
  const reusable = findReusableReceipt(context?.receipts || [], {
    candidateName: name,
    officialUrls,
    catalogRevision,
    policyRevision: context?.policyRevision,
    bridgeRevision: context?.bridgeRevision,
  }, nowMs);
  if (reusable) {
    return { ok: true, reused: true, verdict: { entity_class: reusable.entity_class, vendor_key: reusable.vendor_key, model_key: reusable.model_key, series_title: reusable.series_title, family: reusable.family, confidence: reusable.confidence, evidence: { ...reusable.evidence }, reasons: ['receipt_reused'] }, receipt: reusable };
  }

  // 1. 预算门禁（fail-closed：无账本视为预算不可证明）
  const ledger = context?.ledger;
  const reserve = category => (ledger && typeof ledger.reserve === 'function'
    ? ledger.reserve(category, 1)
    : { ok: false, code: 'COST_BUDGET_EXHAUSTED', category });
  const discoverAdapter = adapters && typeof adapters.discoverOfficialSources === 'function' ? adapters.discoverOfficialSources : null;
  const acquireAdapter = adapters && typeof adapters.acquireOfficialSources === 'function' ? adapters.acquireOfficialSources : null;
  if (!discoverAdapter || !acquireAdapter) return fail('IDENTITY_EVIDENCE_MISSING', '缺少官方源 adapters');

  // 2. 官方源发现 → 获取正文
  if (!reserve('search_queries').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'search_queries 预算耗尽');
  let sources = [];
  try {
    sources = await discoverAdapter({ name, entity_type: candidate.entity_type, official_urls: officialUrls }) || [];
  } catch (error) {
    return fail('IDENTITY_EVIDENCE_MISSING', `官方源发现失败: ${error.message}`);
  }
  if (!Array.isArray(sources) || !sources.length) return fail('IDENTITY_EVIDENCE_MISSING', '无官方源命中');
  if (!reserve('pages').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'pages 预算耗尽');
  let pages = [];
  try {
    pages = await acquireAdapter(sources) || [];
  } catch (error) {
    return fail('IDENTITY_EVIDENCE_MISSING', `官方正文获取失败: ${error.message}`);
  }
  pages = (Array.isArray(pages) ? pages : []).filter(page => page && typeof page.body_text === 'string' && page.body_text.trim());
  if (!pages.length) return fail('IDENTITY_EVIDENCE_MISSING', '官方正文为空');
  for (const page of pages) {
    page.content_hash = typeof page.content_hash === 'string' && page.content_hash ? page.content_hash : sha256Of(page.body_text);
  }

  // 3. AI 建议（注入；缺 AI 一律 fail-closed）
  if (typeof context?.suggestIdentity !== 'function') return fail('IDENTITY_AI_UNAVAILABLE', '未注入 suggestIdentity');
  if (!reserve('responses_calls').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'responses_calls 预算耗尽');
  let suggestion;
  try {
    suggestion = await context.suggestIdentity({ candidate: { ...candidate, name }, pages, instructions: buildIdentitySuggestInstructions() });
  } catch (error) {
    return fail('IDENTITY_AI_UNAVAILABLE', `身份建议调用失败: ${error.message}`);
  }
  if (!suggestion || suggestion.ok === false) {
    const code = suggestion?.code === 'COST_BUDGET_EXHAUSTED' ? 'IDENTITY_BUDGET_EXHAUSTED' : 'IDENTITY_AI_UNAVAILABLE';
    return fail(code, suggestion?.error || suggestion?.code || '身份建议不可用');
  }
  const value = suggestion.value !== undefined ? suggestion.value : suggestion;
  if (!validateIdentitySuggestionValue(value)) return fail('IDENTITY_AI_UNAVAILABLE', '身份建议结构非法');

  // 4. 确定性核验：AI 只建议，一切关键字段程序重算
  if (value.confidence < IDENTITY_LOW_CONFIDENCE_THRESHOLD) {
    return fail('IDENTITY_LOW_CONFIDENCE', `置信度 ${value.confidence} 低于阈值`);
  }
  const vendorKey = vendorKeyViaPolicy(context?.policy, value.vendor_key, context?.normalizeVendorKey);
  if (!vendorKey) return fail('IDENTITY_LOW_CONFIDENCE', `厂商未通过政策归一化: ${value.vendor_key}`);
  let identityKey;
  try { identityKey = normalizeModelIdentity(value.identity); } catch { return fail('IDENTITY_AI_UNAVAILABLE', 'identity 归一化失败'); }
  const hitPages = pages.filter(page => identityAppearsInBody(identityKey, page.body_text));
  if (!hitPages.length) return fail('IDENTITY_NAME_NOT_IN_BODY', `正文未命中 ${identityKey}`);

  // 证据冲突：多个不同注册域的官方正文均命中同名候选（归属矛盾）
  const hitDomains = [...new Set(hitPages.map(page => registrableDomainOf(hostOf(page.url))).filter(Boolean))];
  const declaredSocialDomains = new Set(officialUrls
    .map(url => registrableDomainOf(hostOf(url)))
    .filter(isOfficialSocialDomain));
  const conflictingDomains = hitDomains.filter(domain => !declaredSocialDomains.has(domain));
  if (conflictingDomains.length > 1) return fail('IDENTITY_EVIDENCE_CONFLICT', `多域证据冲突: ${conflictingDomains.join(',')}`);

  const modelKey = modelKeyOf(vendorKey, identityKey);
  const hitPage = hitPages[0];
  const evidence = { official_url: hitPage.url, official_urls: officialUrls, content_hash: hitPage.content_hash, sources: sourceEvidenceOf(officialUrls, pages) };
  const verdict = {
    entity_class: value.entity_class,
    vendor_key: vendorKey,
    model_key: modelKey,
    series_title: value.series_title,
    family: value.family,
    confidence: value.confidence,
    evidence,
    reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : [],
  };
  const receipt = {
    receipt_id: null,
    candidate_name: name,
    identity_key: identityKey,
    entity_class: verdict.entity_class,
    vendor_key: verdict.vendor_key,
    model_key: verdict.model_key,
    series_title: verdict.series_title,
    family: verdict.family,
    confidence: verdict.confidence,
    evidence: { ...evidence },
    catalog_revision: catalogRevision,
    policy_revision: context?.policyRevision ?? null,
    bridge_revision: context?.bridgeRevision ?? null,
    verified_at: new Date(nowMs).toISOString(),
  };
  receipt.receipt_id = receiptIdOf(receipt);
  return { ok: true, verdict, receipt };
}

/**
 * 目录存量 model_key 索引：显式 model_key 优先，存量回退 modelKeyOf(vendor_key, title)。
 * @returns {Map<string, Array<{kind,id,detail_id,tool_card_id,visibility}>>}
 */
function catalogModelKeyIndex(snapshot) {
  const index = new Map();
  const add = (record, kind) => {
    if (!record || typeof record !== 'object') return;
    let key = typeof record.model_key === 'string' && record.model_key ? record.model_key : null;
    if (!key) {
      const vendor = String(record.vendor_key || '').trim();
      const title = String(record.title || '').trim();
      if (!vendor || !title) return;
      try { key = modelKeyOf(vendor, title); } catch { return; }
    }
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      kind,
      id: record.id,
      detail_id: kind === 'tool-level3' ? record.id : (record.detail_ref?.id || null),
      tool_card_id: kind === 'tool-card' ? record.id : (record.tool_card_id || null),
      visibility: record.visibility || 'visible',
    });
  };
  for (const detail of snapshot?.['tool-level3'] || []) add(detail, 'tool-level3');
  for (const card of snapshot?.['tool-card'] || []) add(card, 'tool-card');
  return index;
}

/**
 * 系列成员发现：官方域搜索系列页 → AI 结构化成员清单 → 成员名必须出现在官方正文。
 * @param {object} verdict verifyModelIdentity 的成功 verdict（entity_class='series'）
 * @param {object} adapters { discoverOfficialSources, acquireOfficialSources }
 * @param {object} context { ledger, suggestSeriesMembers?, now? }
 * @returns {Promise<{ok:true, members:[{name,identity_key,evidence}]} | {ok:false, code, error?}>}
 */
async function discoverSeriesMembers(verdict, adapters, context = {}) {
  if (!verdict || !verdict.model_key) return fail('IDENTITY_EVIDENCE_MISSING', '缺少系列 verdict');
  const discoverAdapter = adapters && typeof adapters.discoverOfficialSources === 'function' ? adapters.discoverOfficialSources : null;
  const acquireAdapter = adapters && typeof adapters.acquireOfficialSources === 'function' ? adapters.acquireOfficialSources : null;
  if (!discoverAdapter || !acquireAdapter) return fail('IDENTITY_EVIDENCE_MISSING', '缺少官方源 adapters');
  const ledger = context?.ledger;
  const reserve = category => (ledger && typeof ledger.reserve === 'function'
    ? ledger.reserve(category, 1)
    : { ok: false, code: 'COST_BUDGET_EXHAUSTED', category });
  if (!reserve('search_queries').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'search_queries 预算耗尽');
  let sources = [];
  const evidenceUrls = Array.isArray(verdict.evidence?.official_urls) && verdict.evidence.official_urls.length
    ? verdict.evidence.official_urls
    : (verdict.evidence?.official_url ? [verdict.evidence.official_url] : []);
  if (evidenceUrls.length) {
    sources = evidenceUrls.map(url => ({ url, title: `${verdict.series_title || verdict.model_key} Official`, source_kind: 'official' }));
  } else {
    try {
      sources = await discoverAdapter({
        name: verdict.series_title || verdict.model_key,
        entity_type: 'series',
        official_urls: [],
      }) || [];
    } catch (error) {
      return fail('IDENTITY_EVIDENCE_MISSING', `系列页发现失败: ${error.message}`);
    }
  }
  if (!Array.isArray(sources) || !sources.length) return fail('IDENTITY_EVIDENCE_MISSING', '无系列页命中');
  if (!reserve('pages').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'pages 预算耗尽');
  let pages = [];
  try {
    pages = await acquireAdapter(sources) || [];
  } catch (error) {
    return fail('IDENTITY_EVIDENCE_MISSING', `系列页正文获取失败: ${error.message}`);
  }
  pages = (Array.isArray(pages) ? pages : []).filter(page => page && typeof page.body_text === 'string' && page.body_text.trim());
  if (!pages.length) return fail('IDENTITY_EVIDENCE_MISSING', '系列页正文为空');
  for (const page of pages) {
    page.content_hash = typeof page.content_hash === 'string' && page.content_hash ? page.content_hash : sha256Of(page.body_text);
  }
  if (typeof context?.suggestSeriesMembers !== 'function') return fail('IDENTITY_AI_UNAVAILABLE', '未注入 suggestSeriesMembers');
  if (!reserve('responses_calls').ok) return fail('IDENTITY_BUDGET_EXHAUSTED', 'responses_calls 预算耗尽');
  let suggestion;
  try {
    suggestion = await context.suggestSeriesMembers({ verdict, pages });
  } catch (error) {
    return fail('IDENTITY_AI_UNAVAILABLE', `成员清单调用失败: ${error.message}`);
  }
  const list = suggestion && Array.isArray(suggestion.members) ? suggestion.members : (suggestion?.value?.members || []);
  // 系列前缀门禁：成员 identity 必须以系列 identity 为前缀（modelKeyOf(vendor, identity) 的层级契约）。
  // 防御 AI 把正文里的计费档位/文档栏目名（如 "Avatar 实时版"）误提为成员——它们虽出现在正文，
  // 但与系列无命名层级关系。
  const seriesIdentity = String(verdict.model_key || '').slice(String(verdict.vendor_key || '').length + 1);
  const members = [];
  for (const item of list || []) {
    const memberName = String(item?.name || '').trim();
    if (!memberName) continue;
    let identityKey;
    try { identityKey = normalizeModelIdentity(item.identity || memberName); } catch { continue; }
    if (seriesIdentity && !identityKey.startsWith(seriesIdentity + '-')) continue;
    const candidatePages = pages.filter(page => identityAppearsInBody(identityKey, page.body_text));
    if (!candidatePages.length) continue;
    candidatePages.sort((a, b) => (b.body_text?.length || 0) - (a.body_text?.length || 0));
    const hitPage = candidatePages[0];
    members.push({
      name: memberName,
      identity_key: identityKey,
      model_key: modelKeyOf(verdict.vendor_key, identityKey),
      evidence: { official_url: hitPage.url, official_urls: evidenceUrls, content_hash: hitPage.content_hash, sources: sourceEvidenceOf(evidenceUrls, pages, 'series_member_evidence') },
    });
  }

  // 确定性保底：若 AI 建议输出波动导致空列表，直接从官方正文中提取规范的系列子型号
  if (!members.length && seriesIdentity) {
    const escapedTitle = (verdict.series_title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:${escapedTitle}|${seriesIdentity.split('-').map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_\\s.]?')})[-_\\s]+([A-Za-z0-9]+)`, 'gi');
    for (const page of pages) {
      let match;
      while ((match = pattern.exec(page.body_text)) !== null) {
        const sub = match[1];
        const fullName = `${seriesIdentity}-${sub}`;
        try {
          const idKey = normalizeModelIdentity(fullName);
          if (idKey.startsWith(seriesIdentity + '-') && !members.some(x => x.identity_key === idKey)) {
            members.push({
              name: fullName,
              identity_key: idKey,
              model_key: modelKeyOf(verdict.vendor_key, idKey),
              evidence: { official_url: page.url, official_urls: evidenceUrls, content_hash: page.content_hash, sources: sourceEvidenceOf(evidenceUrls, pages, 'series_member_evidence') },
            });
          }
        } catch {}
      }
    }
  }

  return { ok: true, members };
}

module.exports = {
  IDENTITY_VERIFICATION_TTL_MS,
  RECEIPT_TTL_MS,
  IDENTITY_LOW_CONFIDENCE_THRESHOLD,
  buildIdentitySuggestInstructions,
  validateIdentitySuggestionValue,
  identityAppearsInBody,
  findReusableReceipt,
  verifyModelIdentity,
  catalogModelKeyIndex,
  discoverSeriesMembers,
  readIdentityReceipts,
  appendIdentityReceipts,
};
