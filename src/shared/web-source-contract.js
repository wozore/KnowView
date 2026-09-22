'use strict';

const TRAILING_URL_PUNCTUATION = /[`'"“”‘’.,;:!?\)\]}>，。；：！？、）】》」』…]+$/u;

function canonicalizeUrl(value) {
  if (typeof value !== 'string') return '';
  let candidate = value.trim().replace(/^<+|>+$/g, '');
  while (TRAILING_URL_PUNCTUATION.test(candidate)) candidate = candidate.replace(TRAILING_URL_PUNCTUATION, '');
  if (!/^https?:\/\//i.test(candidate)) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeDomain(value) {
  if (typeof value !== 'string') return '';
  let candidate = value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!candidate) return '';
  try {
    if (/^https?:\/\//i.test(candidate)) candidate = new URL(candidate).hostname;
  } catch {
    return '';
  }
  candidate = candidate.replace(/\.+$/g, '');
  if (!candidate || candidate.includes('/') || candidate.includes(':') || /\s/u.test(candidate)) return '';
  return candidate;
}

function hostnameOf(value) {
  const url = canonicalizeUrl(value);
  if (!url) return '';
  try { return new URL(url).hostname.toLowerCase().replace(/\.+$/g, ''); } catch { return ''; }
}

function hostMatchesDomain(host, domain) {
  const normalizedHost = normalizeDomain(host);
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedHost || !normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function urlMatchesDomains(url, domains) {
  const host = hostnameOf(url);
  return Boolean(host && Array.isArray(domains) && domains.some(domain => hostMatchesDomain(host, domain)));
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const url = canonicalizeUrl(value.url || value.link || value.href);
  if (!url) return null;
  const title = String(value.title || value.name || url).trim().slice(0, 240);
  const excerpt = String(value.excerpt ?? value.content ?? value.raw_content ?? value.snippet ?? '').trim().slice(0, 1200);
  const source = { url, title: title || url, excerpt };
  if (Number.isFinite(value.score)) source.score = value.score;
  return source;
}

function normalizeSources(values) {
  const sources = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const source = normalizeSource(value);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return sources;
}

function filterSourcesByDomains(sources, includeDomains = [], excludeDomains = []) {
  const include = (Array.isArray(includeDomains) ? includeDomains : []).map(normalizeDomain).filter(Boolean);
  const exclude = (Array.isArray(excludeDomains) ? excludeDomains : []).map(normalizeDomain).filter(Boolean);
  return (Array.isArray(sources) ? sources : []).filter(source => {
    const host = hostnameOf(source?.url);
    if (!host) return false;
    if (include.length && !include.some(domain => hostMatchesDomain(host, domain))) return false;
    return !exclude.some(domain => hostMatchesDomain(host, domain));
  });
}

module.exports = {
  canonicalizeUrl,
  normalizeDomain,
  hostnameOf,
  hostMatchesDomain,
  urlMatchesDomains,
  normalizeSource,
  normalizeSources,
  filterSourcesByDomains,
};
