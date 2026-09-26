'use strict';

const { modelKeyOf, normalizeModelIdentity } = require('../../shared/model-key-contract');
const { candidateIdentityKeysOf } = require('./model-identity-verification');

function identityKeyOf(value) {
  try { return normalizeModelIdentity(value); } catch { return null; }
}

function alreadyCompleteToolInCatalog(card, options, snapshot, registryLookup) {
  const identity = identityKeyOf(card?.name || card?.title);
  if (!identity) return false;
  let registry = {};
  try { registry = typeof registryLookup === 'function' ? registryLookup(card, options) || {} : {}; } catch {}
  const vendorKey = card?.vendor_key || card?.vendor_hint || registry.vendor_key || null;
  const matchesIdentity = record => identityKeyOf(record?.title) === identity || identityKeyOf(record?.tool_key) === identity;
  const tools = (Array.isArray(snapshot?.['tool-card']) ? snapshot['tool-card'] : []).filter(matchesIdentity);
  if (tools.length) return vendorKey ? tools.some(tool => tool.vendor_key === vendorKey) : tools.length === 1;
  const details = (Array.isArray(snapshot?.['tool-level3']) ? snapshot['tool-level3'] : [])
    .filter(record => record.detail_kind === 'tool' && matchesIdentity(record));
  return vendorKey ? details.some(detail => detail.vendor_key === vendorKey) : details.length === 1;
}

function alreadyCompleteInCatalog(card, options, modelIndex, registryLookup, snapshot) {
  const modelAxis = card?.entity_type === 'model' || card?.detail_kind_hint === 'api_model';
  if (!modelAxis) {
    if (card?.intake_outcome === 'already_complete') return true;
    return card?.entity_type === 'tool' || card?.detail_kind_hint === 'tool'
      ? alreadyCompleteToolInCatalog(card, options, snapshot, registryLookup)
      : false;
  }
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

module.exports = { alreadyCompleteInCatalog, alreadyCompleteToolInCatalog };
