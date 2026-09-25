'use strict';

const { normalizeModelIdentity } = require('../../shared/model-key-contract');
const { hostOf } = require('./identity-receipts');

function safeIdentityKey(value) {
  try { return normalizeModelIdentity(value); } catch { return null; }
}

function identityAppearsInBody(identityKey, bodyText) {
  const identity = String(identityKey || '').trim().replace(/(\d)\.(\d)/g, '$1-$2');
  const body = String(bodyText || '');
  if (!identity || !body) return false;
  const escaped = identity.split('-').filter(Boolean)
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\-_.]?');
  return Boolean(escaped && new RegExp(escaped, 'i').test(body));
}

function candidateIdentityKeysOf(candidate, name) {
  const vendor = String(candidate?.vendor_hint || '').trim();
  const vendorPrefix = vendor ? vendor.split(/[-\s]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_]+') : '';
  const vendorFreeName = vendorPrefix ? name.replace(new RegExp(`^${vendorPrefix}[\\s\\-_]+`, 'i'), '').trim() : '';
  const values = [name, candidate?.identity_key, vendorFreeName, ...(Array.isArray(candidate?.identity_aliases) ? candidate.identity_aliases : [])];
  return [...new Set(values.flatMap(value => {
    const identity = safeIdentityKey(value);
    return identity ? [identity, identity.replace(/(\d)\.(\d)/g, '$1-$2')] : [];
  }))];
}

function identityEquivalent(left, right) {
  const normalizedLeft = safeIdentityKey(left);
  const normalizedRight = safeIdentityKey(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const decimalHyphen = value => value.replace(/(\d)\.(\d)/g, '$1-$2');
  return normalizedLeft === normalizedRight || decimalHyphen(normalizedLeft) === decimalHyphen(normalizedRight);
}

function canonicalCandidateIdentity(candidate, name, suggestion) {
  const direct = [candidate?.identity_key, name, ...(Array.isArray(candidate?.identity_aliases) ? candidate.identity_aliases : [])];
  const matching = direct.find(value => identityEquivalent(value, suggestion));
  if (matching) return safeIdentityKey(matching);
  const vendor = String(candidate?.vendor_hint || '').trim();
  const prefix = vendor ? vendor.split(/[-\s]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_]+') : '';
  const vendorFreeName = prefix ? name.replace(new RegExp(`^${prefix}[\\s\\-_]+`, 'i'), '').trim() : '';
  return safeIdentityKey(vendorFreeName) || safeIdentityKey(suggestion);
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.au', 'net.au', 'org.au', 'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'co.kr', 'com.br', 'com.sg', 'com.tw', 'com.hk']);

function registrableDomainForIdentity(host) {
  const labels = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  return MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? labels.slice(-3).join('.') : suffix;
}

function vendorDomainIndex(policy, vendorKey, officialUrls) {
  const owners = new Map();
  const add = (url, owner) => {
    const domain = registrableDomainForIdentity(hostOf(url));
    if (!domain) return;
    if (!owners.has(domain)) owners.set(domain, new Set());
    owners.get(domain).add(owner);
  };
  for (const vendor of policy?.vendors || []) {
    for (const family of vendor.families || []) add(family.evidence?.url, vendor.vendor_key);
  }
  for (const url of officialUrls || []) add(url, vendorKey);
  return owners;
}

module.exports = {
  identityAppearsInBody,
  candidateIdentityKeysOf,
  identityEquivalent,
  canonicalCandidateIdentity,
  registrableDomainForIdentity,
  vendorDomainIndex,
};
