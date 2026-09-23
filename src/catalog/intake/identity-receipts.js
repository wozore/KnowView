'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { writeJsonAtomic } = require('../../shared/json-store');

const RECEIPT_TTL_MS = 7 * 24 * 3600 * 1000;

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
    evidence: receipt.evidence,
  });
  return `receipt-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12)}`;
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
function seriesReceiptNames(options = {}, catalogRevision = null) {
  const receipts = Array.isArray(options.identityReceipts) ? options.identityReceipts : readIdentityReceipts();
  return new Set(receipts
    .filter(receipt => receipt && receipt.entity_class === 'series'
      && (!catalogRevision || receipt.catalog_revision === catalogRevision))
    .map(receipt => String(receipt.candidate_name || '').trim().toLowerCase())
    .filter(Boolean));
}

module.exports = {
  RECEIPT_TTL_MS,
  sha256Of,
  receiptIdOf,
  hostOf,
  registrableDomainOf,
  readIdentityReceipts,
  appendIdentityReceipts,
  seriesReceiptNames,
};
