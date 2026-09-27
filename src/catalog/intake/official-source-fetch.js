'use strict';

const { canonicalizeUrl } = require('../../shared/web-source-contract');

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function utcDateFromMilliseconds(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1000000000000) return null;
  try { return new Date(timestamp).toISOString().slice(0, 10); } catch { return null; }
}

function dateFromMetadataValue(value) {
  if (typeof value === 'number') return utcDateFromMilliseconds(value);
  const text = String(value || '').trim();
  if (/^\d{13}$/.test(text)) return utcDateFromMilliseconds(text);
  const date = text.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1];
  if (!date || !isIsoDate(date)) return null;
  if (text.includes('T') && Number.isNaN(Date.parse(text))) return null;
  return date;
}

function attributesOf(tag) {
  const attributes = {};
  for (const match of String(tag || '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function dateModifiedOf(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === 'datemodified') {
      const date = dateFromMetadataValue(item);
      if (date) return date;
    }
    const nested = dateModifiedOf(item, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function updatedDateMetadata(html) {
  const raw = String(html || '');
  for (const match of raw.matchAll(/lastModifiedTime["']?\s*[:=]\s*["']?(\d{13})["']?/gi)) {
    const date = utcDateFromMilliseconds(match[1]);
    if (date) return { updated_date: date, updated_date_kind: 'official_page_update', updated_date_field: 'lastModifiedTime' };
  }
  for (const match of raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[0].slice(0, match[0].indexOf('>') + 1))) continue;
    try {
      const date = dateModifiedOf(JSON.parse(match[1]));
      if (date) return { updated_date: date, updated_date_kind: 'official_page_update', updated_date_field: 'dateModified' };
    } catch { /* Ignore malformed JSON-LD and continue to other explicit page metadata. */ }
  }
  for (const match of raw.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attributesOf(match[0]);
    const field = String(attributes.property || attributes.name || '').toLowerCase();
    if (!['article:modified_time', 'og:updated_time'].includes(field)) continue;
    const date = dateFromMetadataValue(attributes.content);
    if (date) return { updated_date: date, updated_date_kind: 'official_page_update', updated_date_field: field };
  }
  for (const match of raw.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/gi)) {
    const attributes = attributesOf(match[0].slice(0, match[0].indexOf('>') + 1));
    const label = match[0].replace(/<[^>]+>/g, ' ');
    const marked = /datemodified/i.test(attributes.itemprop || '')
      || /updated|modified/i.test(`${attributes.class || ''} ${attributes.id || ''}`)
      || /updated\s+at|更新时间/i.test(label);
    if (!marked) continue;
    const date = dateFromMetadataValue(attributes.datetime);
    if (date) return { updated_date: date, updated_date_kind: 'official_page_update', updated_date_field: 'time.datetime' };
  }
  const visible = [
    [/\bUpdated\s+at\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i, 'visible_updated_at'],
    [/更新时间\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i, 'visible_updated_date'],
  ];
  for (const [pattern, field] of visible) {
    const date = raw.match(pattern)?.[1];
    if (date && isIsoDate(date)) return { updated_date: date, updated_date_kind: 'official_page_update', updated_date_field: field };
  }
  return null;
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchOfficialSources(sources, options = {}) {
  const normalized = (Array.isArray(sources) ? sources : [])
    .map(source => ({ ...source, url: canonicalizeUrl(source?.url) }))
    .filter(source => source.url);
  const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { ok: false, pages: [], failed: normalized.map(source => ({ url: source.url, error: 'FETCH_UNAVAILABLE' })) };
  const pages = [];
  const failed = [];
  for (const source of normalized) {
    try {
      const response = await fetchFn(source.url, { signal: AbortSignal.timeout(options.timeoutMs || 15000) });
      if (!response?.ok) {
        failed.push({ url: source.url, error: `HTTP_${response?.status || 0}` });
        continue;
      }
      const html = await response.text();
      const bodyText = textFromHtml(html).slice(0, options.maxBodyChars || 20000);
      const updatedDate = updatedDateMetadata(html);
      if (bodyText || updatedDate) pages.push({ url: source.url, body_text: bodyText, ...(updatedDate || {}) });
      else failed.push({ url: source.url, error: 'OFFICIAL_SOURCE_EMPTY' });
    } catch (error) {
      failed.push({ url: source.url, error: String(error?.code || error?.name || 'OFFICIAL_SOURCE_FETCH_FAILED') });
    }
  }
  return { ok: pages.length > 0, pages, failed };
}

module.exports = { textFromHtml, fetchOfficialSources };
