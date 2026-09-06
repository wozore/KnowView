'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { writeJsonAtomic } = require('../../shared/json-store');

const RECEIPT_TTL_MS = 7 * 24 * 3600 * 1000;

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

module.exports = { RECEIPT_TTL_MS, readIdentityReceipts, appendIdentityReceipts };
