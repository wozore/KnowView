'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { writeJsonAtomic } = require('../../shared/json-store');
const { normalizeModelIdentity } = require('../../shared/model-key-contract');

const RECEIPT_TTL_MS = 7 * 24 * 3600 * 1000;
const IDENTITY_VERIFICATION_TTL_MS = 24 * 3600 * 1000;

function sha256Of(text) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(text || ''), 'utf8')).digest('hex')}`;
}

function receiptIdOf(receipt) {
  const basis = JSON.stringify({
    identity_key: receipt.identity_key,
    model_key: receipt.model_key,
    catalog_revision: receipt.catalog_revision,
    policy_revision: receipt.policy_revision,
    bridge_revision: receipt.bridge_revision,
    identity_aliases: normalizedIdentitySet(receipt.identity_aliases),
    evidence: receipt.evidence,
  });
  return `receipt-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12)}`;
}

function normalizedUrlSet(values) { return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort(); }
function sameUrlSet(left, right) { const a = normalizedUrlSet(left); const b = normalizedUrlSet(right); return a.length === b.length && a.every((value, index) => value === b[index]); }
function normalizedIdentitySet(values) {
  return [...new Set((Array.isArray(values) ? values : []).flatMap(value => {
    try { return [normalizeModelIdentity(value)]; } catch { return []; }
  }))].sort();
}

function findReusableReceipt(receipts, expected, now = Date.now()) {
  const nowMs = Number.isFinite(now) ? now : Date.parse(now);
  const expectedUrls = normalizedUrlSet(expected.officialUrls);
  const expectedIdentities = normalizedIdentitySet(expected.candidateIdentityKeys || [expected.candidateName]);
  if (!expectedIdentities.length) return null;
  let reusable = null;
  let newestVerifiedMs = -Infinity;
  for (const receipt of receipts || []) {
    if (!receipt || typeof receipt !== 'object' || !normalizedIdentitySet([receipt.identity_key])
      .some(identity => expectedIdentities.includes(identity))) continue;
    if (receipt.catalog_revision !== expected.catalogRevision) continue;
    if (receipt.policy_revision !== expected.policyRevision) continue;
    if (receipt.bridge_revision !== expected.bridgeRevision) continue;
    if (JSON.stringify(normalizedIdentitySet(receipt.identity_aliases)) !== JSON.stringify(normalizedIdentitySet(expected.identityAliases))) continue;
    const evidence = receipt.evidence || {};
    const candidateUrls = Array.isArray(receipt.candidate_official_urls)
      ? receipt.candidate_official_urls
      : (Array.isArray(evidence.official_urls) && evidence.official_urls.length ? evidence.official_urls : [evidence.official_url]);
    const evidenceUrls = Array.isArray(evidence.official_urls) && evidence.official_urls.length
      ? evidence.official_urls
      : [evidence.official_url];
    if (!sameUrlSet(candidateUrls, expectedUrls)) continue;
    if (typeof evidence.official_url !== 'string' || !normalizedUrlSet(evidenceUrls).includes(evidence.official_url)) continue;
    if (typeof evidence.content_hash !== 'string' || !evidence.content_hash) continue;
    const verifiedMs = Date.parse(receipt.verified_at || '');
    if (!Number.isFinite(verifiedMs) || nowMs - verifiedMs > IDENTITY_VERIFICATION_TTL_MS) continue;
    if (verifiedMs > newestVerifiedMs) {
      reusable = receipt;
      newestVerifiedMs = verifiedMs;
    }
  }
  return reusable;
}

function sourceEvidenceOf(urls, pages, sourceRole = 'identity_evidence') {
  const byUrl = new Map((pages || []).map(page => [String(page.url || '').trim(), page]));
  return normalizedUrlSet(urls).map(url => ({
    url,
    source_kind: 'identity_verified',
    source_role: sourceRole,
    ...(byUrl.get(url)?.content_hash ? { content_hash: byUrl.get(url).content_hash } : {}),
  }));
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function registrableDomainOf(host) {
  const parts = String(host || '').split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function receiptsFileOf(options = {}) {
  return options.file || CATALOG_GENERATOR_FILES.identityReceipts || path.join('data', 'manual', 'tools', 'identity-receipts.json');
}

function readIdentityReceipts(options = {}) {
  const file = receiptsFileOf(options);
  try {
    if (!fs.existsSync(file)) return [];
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.receipts)) return [];
    return value.receipts.filter(receipt => receipt && typeof receipt === 'object' && receipt.receipt_id);
  } catch {
    return [];
  }
}

function appendIdentityReceipts(newReceipts, options = {}) {
  const file = receiptsFileOf(options);
  const now = options.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const merged = new Map(readIdentityReceipts(options).map(receipt => [receipt.receipt_id, receipt]));
  for (const receipt of newReceipts || []) {
    if (receipt && receipt.receipt_id) merged.set(receipt.receipt_id, receipt);
  }
  const kept = [...merged.values()]
    .filter(receipt => {
      const verifiedMs = Date.parse(receipt.verified_at || '');
      return Number.isFinite(verifiedMs) && nowMs - verifiedMs <= RECEIPT_TTL_MS;
    })
    .sort((a, b) => String(a.receipt_id).localeCompare(String(b.receipt_id)));
  const payload = { schema_version: 1, kind: 'identity_receipts', count: kept.length, generated_at: new Date(nowMs).toISOString(), receipts: kept };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, 'identity-receipts');
  return kept;
}

/** 粗筛：当前目录 revision 下被核验判定为 series 的候选名集合（严格五条件复用仍由核验层裁决）。 */
function seriesReceiptNames(options = {}, catalogRevision = null, candidates = []) {
  const receipts = Array.isArray(options.identityReceipts) ? options.identityReceipts : readIdentityReceipts();
  const byName = new Map((candidates || []).map(candidate => [String(candidate?.name || '').trim().toLowerCase(), candidate]));
  const requestedNow = options.now instanceof Date ? options.now.getTime()
    : Number.isFinite(options.now) ? options.now
      : Date.parse(options.now || new Date().toISOString());
  const nowMs = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  return new Set(receipts
    .filter(receipt => {
      if (!receipt || receipt.entity_class !== 'series' || (catalogRevision && receipt.catalog_revision !== catalogRevision)) return false;
      const verifiedAt = Date.parse(receipt.verified_at || '');
      if (!Number.isFinite(verifiedAt) || nowMs - verifiedAt > RECEIPT_TTL_MS) return false;
      const candidateName = String(receipt.candidate_name || '').trim();
      const candidate = byName.get(candidateName.toLowerCase());
      const identities = [candidateName, candidate?.identity_key, ...(Array.isArray(candidate?.identity_aliases) ? candidate.identity_aliases : [])]
        .flatMap(value => {
          try {
            const identity = normalizeModelIdentity(value);
            return [identity, identity.replace(/(\d)\.(\d)/g, '$1-$2')];
          } catch { return []; }
        });
      let receiptIdentity = '';
      try { receiptIdentity = normalizeModelIdentity(receipt.identity_key); } catch { return false; }
      return identities.includes(receiptIdentity);
    })
    .map(receipt => String(receipt.candidate_name || '').trim().toLowerCase())
    .filter(Boolean));
}

module.exports = {
  RECEIPT_TTL_MS,
  IDENTITY_VERIFICATION_TTL_MS,
  sha256Of,
  receiptIdOf,
  normalizedUrlSet,
  findReusableReceipt,
  sourceEvidenceOf,
  hostOf,
  registrableDomainOf,
  readIdentityReceipts,
  appendIdentityReceipts,
  seriesReceiptNames,
};
