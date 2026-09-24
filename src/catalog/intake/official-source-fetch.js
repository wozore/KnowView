'use strict';

const { canonicalizeUrl } = require('../../shared/web-source-contract');

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
      const bodyText = textFromHtml(await response.text()).slice(0, options.maxBodyChars || 20000);
      if (bodyText) pages.push({ url: source.url, body_text: bodyText });
      else failed.push({ url: source.url, error: 'OFFICIAL_SOURCE_EMPTY' });
    } catch (error) {
      failed.push({ url: source.url, error: String(error?.code || error?.name || 'OFFICIAL_SOURCE_FETCH_FAILED') });
    }
  }
  return { ok: pages.length > 0, pages, failed };
}

module.exports = { textFromHtml, fetchOfficialSources };
