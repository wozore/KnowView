'use strict';

const { modelKeyOf } = require('../../shared/model-key-contract');
const { candidateIdentityKeysOf } = require('./model-identity-verification');

function alreadyCompleteInCatalog(card, options, modelIndex, registryLookup) {
  const modelAxis = card?.entity_type === 'model' || card?.detail_kind_hint === 'api_model';
  if (!modelAxis) return card?.intake_outcome === 'already_complete';
  const registry = registryLookup(card, options);
  if (card.model_key && modelIndex.has(card.model_key)) return true;
  const vendorKey = card.vendor_key || card.vendor_hint || registry.vendor_key
    || (registry.matched_entry_kind === 'vendor' ? registry.matched_key : null);
  if (!vendorKey) return card.intake_outcome === 'already_complete';
  const identityAliases = [...new Set([
    ...(Array.isArray(card.identity_aliases) ? card.identity_aliases : []),
    ...(Array.isArray(registry.identity_aliases) ? registry.identity_aliases : []),
  ])];
  const identities = candidateIdentityKeysOf({ ...card, vendor_hint: vendorKey, identity_aliases: identityAliases }, String(card.name || card.title || '').trim());
  for (const rawKey of [...identities, ...(card.model_key ? [card.model_key] : [])]) {
    const identity = String(rawKey).startsWith(`${vendorKey}-`) ? String(rawKey).slice(vendorKey.length + 1) : rawKey;
    try { if (modelIndex.has(modelKeyOf(vendorKey, identity))) return true; }
    catch { if (card.intake_outcome === 'already_complete') return true; }
  }
  return false;
}

module.exports = { alreadyCompleteInCatalog };
