'use strict';

const { plannedWebSearchRequests } = require('../../shared/web-search');
const { canonicalizeUrl } = require('../../shared/web-source-contract');

function searchProvidersOf(options = {}) {
  return {
    primary: options.searchProvider ?? options.search_provider ?? 'zhipu_web_search',
    fallback: options.searchFallbackProvider ?? options.search_fallback_provider ?? 'tavily',
  };
}

function searchAttemptMultiplier(options = {}) {
  const providers = searchProvidersOf(options);
  return providers.fallback && providers.fallback !== providers.primary ? 2 : 1;
}

function officialUrlsOf(card, registryHit) {
  return [...new Set([
    ...(Array.isArray(card?.official_urls) ? card.official_urls : []),
    ...(registryHit?.ok ? (Array.isArray(registryHit.official_urls) ? registryHit.official_urls : []) : []),
    ...(registryHit?.ok && registryHit.official_url ? [registryHit.official_url] : []),
  ].map(canonicalizeUrl).filter(Boolean))];
}

function identitySearchRequestBounds(cards, options = {}, lookupRegistryForCard) {
  const { primary, fallback } = searchProvidersOf(options);
  let primaryRequests = 0;
  let fallbackRequests = 0;
  for (const card of cards || []) {
    const registry = typeof lookupRegistryForCard === 'function' ? lookupRegistryForCard(card, options) : null;
    const urls = officialUrlsOf(card, registry);
    const includeDomains = [...new Set(urls.map(url => new URL(url).hostname.toLowerCase().replace(/^www\./, '')))];
    primaryRequests += plannedWebSearchRequests({ provider: primary, includeDomains });
    if (fallback && fallback !== primary) fallbackRequests += plannedWebSearchRequests({ provider: fallback, includeDomains });
  }
  return { primary: primaryRequests, fallback: fallbackRequests };
}

function estimateResolutionNeed(cards, options = {}, lookupRegistryForCard) {
  let paid = 0;
  let free = 0;
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    const hit = typeof lookupRegistryForCard === 'function' ? lookupRegistryForCard(card, options) : { ok: false };
    if (hit.ok) free += 1; else paid += 1;
  }
  const modelCards = (cards || []).filter(card => card.entity_type === 'series'
    || card.entity_type === 'model' || card.detail_kind_hint === 'api_model');
  const modelAxisCount = modelCards.length;
  const searchMultiplier = searchAttemptMultiplier(options);
  const verificationSearchRequests = identitySearchRequestBounds(modelCards, options, lookupRegistryForCard);
  return {
    cards_paid: paid,
    cards_free: free,
    vendor_search_primary_upper_bound: paid,
    vendor_search_fallback_upper_bound: searchMultiplier > 1 ? paid : 0,
    vendor_search_upper_bound: paid * searchMultiplier,
    vendor_responses_upper_bound: paid,
    verification_search_primary_upper_bound: verificationSearchRequests.primary,
    verification_search_upper_bound: verificationSearchRequests.primary + verificationSearchRequests.fallback,
    verification_search_fallback_upper_bound: verificationSearchRequests.fallback,
    verification_extract_upper_bound: modelAxisCount * 3,
    verification_responses_upper_bound: modelAxisCount * 4,
  };
}

module.exports = { searchProvidersOf, searchAttemptMultiplier, identitySearchRequestBounds, estimateResolutionNeed };
