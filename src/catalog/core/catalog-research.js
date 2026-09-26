'use strict';

const crypto = require('crypto');
const { canonicalizeUrl } = require('../../shared/tavily-client');

const DEFAULT_LIMITS = Object.freeze({
  search_queries: 3,
  pages: 8,
  responses_calls: 8,
  synthesis_calls: 1,
});

const PAGE_UPDATE_FIELDS = new Set([
  'lastModifiedTime', 'dateModified', 'article:modified_time', 'og:updated_time',
  'time.datetime', 'visible_updated_at', 'visible_updated_date',
]);

function createCostLedger(limits = {}, initialSpent = {}) {
  const normalizedLimits = { ...DEFAULT_LIMITS, ...limits };
  const spent = Object.fromEntries(Object.keys(normalizedLimits).map(key => [key, Number(initialSpent[key] || 0)]));
  return {
    reserve(category, amount = 1) {
      if (!Object.prototype.hasOwnProperty.call(normalizedLimits, category)) return { ok: false, code: 'COST_CATEGORY_UNKNOWN', category };
      const count = Number(amount);
      if (!Number.isFinite(count) || count < 0) return { ok: false, code: 'COST_AMOUNT_INVALID', category };
      if (spent[category] + count > normalizedLimits[category]) return { ok: false, code: 'COST_BUDGET_EXHAUSTED', category, requested: count, remaining: normalizedLimits[category] - spent[category] };
      spent[category] += count;
      return { ok: true };
    },
    snapshot() {
      return {
        limits: { ...normalizedLimits },
        spent: { ...spent },
        remaining: Object.fromEntries(Object.keys(normalizedLimits).map(key => [key, Math.max(0, normalizedLimits[key] - spent[key])])),
      };
    },
  };
}

function hostOf(url) {
  const canonical = canonicalizeUrl(url);
  try { return new URL(canonical).hostname.toLowerCase(); } catch { return ''; }
}

// 多租户托管后缀不是任何厂商的"注册域根"：平台.openai.com 可以放宽到 openai.com，
// 但 foo.github.io 绝不能放宽到 github.io（否则所有托管项目都会被当成官方域）。
const SHARED_HOSTING_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'gitee.io',
]);

/** 取主机名的注册域根（最后两段）；主机已是根域或根是多租户托管后缀时返回 null。 */
function registrableHostOf(host) {
  const labels = String(host || '').split('.').filter(Boolean);
  if (labels.length <= 2) return null;
  const candidate = labels.slice(-2).join('.');
  return SHARED_HOSTING_SUFFIXES.has(candidate) ? null : candidate;
}

// 公共代码托管/模型分享平台不作为官方根域名（否则该平台的所有项目、Spaces、同名文档都会被误当成官方文档）
const COMMUNITY_HOST_BLOCKLIST = new Set([
  'huggingface.co',
  'github.com',
  'github.io',
  'gitlab.com',
  'gitee.com',
]);

// 身份核验/登记表生成的授权 kind：与普通 official_hint 同等作为信任根。
// 搜索 provider 返回的 source_kind=official 只是候选标记，绝不能据此建立信任根。
const AUTHORIZED_SOURCE_KINDS = new Set(['official_hint', 'identity_verified', 'verified_official']);
const OFFICIAL_SOCIAL_HOSTS = new Set(['x.com', 'twitter.com']);

function authorizedSourcesOf(seed) {
  return (seed.discovery_sources || []).filter(source => source?.url && AUTHORIZED_SOURCE_KINDS.has(source?.kind));
}

function authorizedUrlsOf(seed) {
  return new Set([seed.official_url, ...authorizedSourcesOf(seed).map(source => source.url)]
    .map(canonicalizeUrl).filter(Boolean));
}

function officialRootsOf(seed) {
  const explicit = canonicalizeUrl(seed.official_url);
  const hinted = authorizedSourcesOf(seed).map(source => canonicalizeUrl(source.url));
  const hosts = [...new Set([explicit, ...hinted]
    .filter(Boolean)
    .map((url, index) => ({ host: hostOf(url), explicit: index === 0 && Boolean(explicit) }))
    .filter(item => item.host && (item.explicit || !COMMUNITY_HOST_BLOCKLIST.has(item.host)))
    .map(item => item.host))];
  // 同厂商官方域按注册域根放行：platform.openai.com 的公告/帮助页常落在 openai.com 主域，
  // 闸门只认精确子域会把厂商主站的发布证据挡在门外（多租户托管后缀不放宽）。
  const roots = new Set(hosts);
  for (const host of hosts) {
    const root = registrableHostOf(host);
    if (root && !COMMUNITY_HOST_BLOCKLIST.has(root)) roots.add(root);
  }
  return [...roots];
}

function isTrustedOfficialUrl(url, roots) {
  const host = hostOf(url);
  return Boolean(host && roots.some(root => host === root || host.endsWith(`.${root}`)));
}

function sourceIdOf(url) {
  const canonical = canonicalizeUrl(url) || String(url || '').trim();
  return `source-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

function dedupeBy(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function costFailure(reservation) {
  return {
    ok: false,
    code: reservation.code,
    category: reservation.category,
    requested: reservation.requested,
    remaining: reservation.remaining,
    error: `${reservation.category} 成本预算不足`,
  };
}

function scopeKey(scope) {
  return `${scope.kind}:${scope.subject?.key || ''}`;
}

function scopeRefsOf(source) {
  if (Array.isArray(source?.discovered_for)) return source.discovered_for.filter(Boolean);
  if (source?.discovered_for) return [source.discovered_for];
  return [];
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function pageUpdateMetadataOf(source) {
  if (source?.updated_date_kind !== 'official_page_update' || !PAGE_UPDATE_FIELDS.has(source?.updated_date_field) || !isIsoDate(source?.updated_date)) return null;
  return { updated_date: source.updated_date, updated_date_kind: 'official_page_update', updated_date_field: source.updated_date_field };
}
function normalizeIdentityText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function modelIdentitiesOf(seed) {
  const modelKey = String(seed?.model_key || '');
  const modelIdentity = modelKey.startsWith(`${seed?.vendor_key || ''}-`)
    ? modelKey.slice(String(seed.vendor_key).length + 1) : modelKey;
  return [seed?.name, seed?.identity_key, seed?.tool_key, seed?.detail_key, modelIdentity]
    .map(normalizeIdentityText).filter(identity => identity.length >= 5);
}

function sourceUrlMatchesModelIdentity(source, seed) {
  let urlPath = '';
  try { urlPath = new URL(source?.url).pathname; } catch { /* Invalid URLs are rejected by OfficialSource normalization. */ }
  let decodedPath = urlPath;
  try { decodedPath = decodeURIComponent(urlPath); } catch { /* Keep the canonical encoded path. */ }
  const pagePath = normalizeIdentityText(decodedPath);
  return modelIdentitiesOf(seed).some(identity => pagePath.includes(identity));
}
function isModelSpecificDetailSource(source, plan) {
  const scope = (plan?.research_scopes || []).find(item => item.kind === 'detail');
  return Boolean(scope && scopeRefsOf(source).includes(scopeKey(scope)) && sourceUrlMatchesModelIdentity(source, plan.seed));
}

function needsReleaseDateMetadata(plan, scope, missingFields, sources) {
  if (scope.kind !== 'detail' || !(missingFields || []).includes('detail.release_date')) return false;
  if (isIsoDate(plan.seed?.known_fields?.integrated_release_date)) return false;
  return !sourcesForScope(sources, scope).some(source => pageUpdateMetadataOf(source) && isModelSpecificDetailSource(source, plan));
}

function canReuseDetailPageForDate(plan, scope, missingFields, sources, attemptedIds) {
  return scope.kind === 'detail'
    && missingFields.length === 1
    && missingFields[0] === 'detail.release_date'
    && sourcesForScope(sources, scope).some(source => !attemptedIds.has(source.source_id) && sourceUrlMatchesModelIdentity(source, plan.seed));
}
function normalizeSource(source, roots, authorizedUrls = new Set()) {
  const url = canonicalizeUrl(source?.url);
  if (!url || !isTrustedOfficialUrl(url, roots)) return null;
  const host = hostOf(url);
  if (OFFICIAL_SOCIAL_HOSTS.has(host) && !authorizedUrls.has(url)) return null;
  const normalized = {
    ...source,
    source_id: source.source_id || sourceIdOf(url),
    url,
    title: String(source.title || url).trim(),
    excerpt: String(source.excerpt || '').trim(),
    discovered_for: scopeRefsOf(source),
  };
  for (const field of ['updated_date', 'updated_date_kind', 'updated_date_field']) delete normalized[field];
  Object.assign(normalized, pageUpdateMetadataOf(source) || {});
  if (normalized.content && !['direct_fetch', 'tavily_extract'].includes(normalized.content_origin)) normalized.content = '';
  return normalized;
}

function addSources(sources, candidates, scope, roots, warnings, authorizedUrls = new Set()) {
  const ref = scopeKey(scope);
  for (const candidate of candidates) {
    const discoveryCandidate = { ...candidate };
    for (const field of ['updated_date', 'updated_date_kind', 'updated_date_field']) delete discoveryCandidate[field];
    const normalized = normalizeSource(discoveryCandidate, roots, authorizedUrls);
    if (!normalized) {
      warnings.push(`${scope.kind}: 已忽略无效或非官方来源 URL`);
      continue;
    }
    const existing = sources.find(source => source.url === normalized.url);
    if (existing) {
      existing.discovered_for = [...new Set([...scopeRefsOf(existing), ref])];
      if (!existing.title || existing.title === existing.url) existing.title = normalized.title;
      if (!existing.excerpt) existing.excerpt = normalized.excerpt;
      continue;
    }
    sources.push({
      ...normalized,
      discovered_for: [ref],
    });
  }
}

function sourcesForScope(sources, scope) {
  const ref = scopeKey(scope);
  return sources.filter(source => scopeRefsOf(source).includes(ref));
}

function fieldScopeKind(field) {
  const dot = String(field || '').indexOf('.');
  return dot > 0 ? field.slice(0, dot) : null;
}

function scopeKindsOfFields(fields) {
  return [...new Set((fields || []).map(fieldScopeKind).filter(kind => ['vendor', 'group', 'detail'].includes(kind)))];
}

async function callResearchAdapter(adapter, input, fallbackCode) {
  try { return await adapter(input); }
  catch (error) { return { ok: false, code: error?.code || fallbackCode, error: error?.message || fallbackCode, failed_scope: scopeKey(input.scope) }; }
}

async function researchCatalog(plan, adapters, options = {}) {
  if (!plan || !Array.isArray(plan.research_scopes)) return { ok: false, code: 'RESEARCH_PLAN_INVALID', error: '缺少 ResearchPlan' };
  if (!adapters?.discover || !adapters?.acquire) return { ok: false, code: 'RESEARCH_ADAPTERS_REQUIRED', error: '缺少 discover/acquire adapter' };
  const existing = options.existingResearch || {};
  const ledger = createCostLedger(options.limits, existing.cost?.spent);
  const roots = officialRootsOf(plan.seed || {});
  const authorizedUrls = authorizedUrlsOf(plan.seed || {});
  let sources = dedupeBy([...(existing.official_sources || [])].map(source => normalizeSource(source, roots, authorizedUrls)).filter(Boolean), source => source.url);
  const warnings = [...(existing.warnings || [])];
  const pageUpdateRefetchAttemptedIds = new Set(existing.research_progress?.page_update_refetch_attempted_ids || []);
  const missingFields = options.missingFields || existing.missing_fields || [];
  const completedScopes = new Set(existing.completed_scopes || existing.research_progress?.completed_scopes || []);
  const missingKinds = scopeKindsOfFields(missingFields);
  const uncompletedKinds = plan.research_scopes
    .filter(scope => !completedScopes.has(scopeKey(scope)))
    .map(scope => scope.kind);
  const hasReusableBody = sources.some(source => typeof source.content === 'string' && source.content.trim());
  const neededKinds = hasReusableBody
    ? [...new Set([...missingKinds, ...uncompletedKinds])]
    : [...new Set(plan.research_scopes.map(scope => scope.kind))];
  const failWithProgress = failure => ({
    ...failure,
    ok: false,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
    research_progress: {
      completed_scopes: [...completedScopes],
      failed_scope: failure.failed_scope || null,
      page_update_refetch_attempted_ids: [...pageUpdateRefetchAttemptedIds],
    },
  });

  // seed 声明的授权来源（official_hint/identity_verified）无条件预置：它们已过身份核验或人工登记，
  // 不依赖搜索引擎是否返回，保证后续 scope 至少抓取这些正文。
  const declaredScopes = plan.research_scopes.filter(scope => neededKinds.includes(scope.kind));
  for (const scope of declaredScopes) {
    addSources(sources, authorizedSourcesOf(plan.seed || {}).map(source => ({
      url: source.url,
      title: source.url,
      excerpt: '',
      kind: source.kind,
      ...(source.content_hash ? { content_hash: source.content_hash } : {}),
    })), scope, roots, warnings, authorizedUrls);
  }

  const pendingScopes = plan.research_scopes.filter(scope => {
    const key = scopeKey(scope);
    return neededKinds.includes(scope.kind) && !(completedScopes.has(key) && !missingFields.length);
  });
  for (const [scopeIndex, scope] of pendingScopes.entries()) {
    const key = scopeKey(scope);
    let reservation;
    const reuseSpecificPage = canReuseDetailPageForDate(plan, scope, missingFields, sources, pageUpdateRefetchAttemptedIds);
    if (!reuseSpecificPage) {
      reservation = ledger.reserve('search_queries', 1);
      if (!reservation.ok) return failWithProgress(costFailure(reservation));
      const discovered = await callResearchAdapter(adapters.discover, { plan, scope, missing_predicates: scope.predicates, ledger }, 'RESEARCH_DISCOVER_FAILED');
      if (discovered?.ok === false) return failWithProgress({ ...discovered, failed_scope: key });
      if (discovered?.fallback_error) warnings.push(`${scope.kind}: 备用搜索失败（${discovered.fallback_error.code || 'WEB_SEARCH_FAILED'}）`);
      const discoveredSources = Array.isArray(discovered?.sources) ? discovered.sources : [];
      const knownUrls = new Set(sources.map(source => source.url));
      const declaredUrls = new Set(authorizedSourcesOf(plan.seed || {}).map(source => canonicalizeUrl(source.url)).filter(Boolean));
      const narrowedHit = discoveredSources.some(source => {
        const canonical = canonicalizeUrl(source?.url);
        return canonical && (declaredUrls.has(canonical) || !knownUrls.has(canonical) && isTrustedOfficialUrl(canonical, roots));
      });
      addSources(sources, discoveredSources, scope, roots, warnings, authorizedUrls);

      if (missingFields.length || !narrowedHit) {
        const remainingNarrow = pendingScopes.length - scopeIndex - 1;
        if (ledger.snapshot().remaining.search_queries >= 1 + remainingNarrow) {
          reservation = ledger.reserve('search_queries', 1);
          const widened = await callResearchAdapter(adapters.discover, { plan, scope, missing_predicates: scope.predicates, ledger, domain_scope: 'registrant' }, 'RESEARCH_DISCOVER_FAILED');
          if (widened?.ok === false) warnings.push(`${scope.kind}: 扩域搜索失败已忽略（${widened.code || 'RESEARCH_DISCOVER_FAILED'}）`);
          else {
            if (widened?.fallback_error) warnings.push(`${scope.kind}: 扩域备用搜索失败（${widened.fallback_error.code || 'WEB_SEARCH_FAILED'}）`);
            addSources(sources, Array.isArray(widened?.sources) ? widened.sources : [], scope, roots, warnings, authorizedUrls);
          }
        } else {
          warnings.push(`${scope.kind}: 搜索预算不足以安全扩域，跳过扩域搜索`);
        }
      }
    }

    const refreshPageDate = needsReleaseDateMetadata(plan, scope, missingFields, sources);
    const scopedSources = sourcesForScope(sources, scope);
    const updateTargets = refreshPageDate ? scopedSources.filter(source => isModelSpecificDetailSource(source, plan)) : [];
    const toAcquireAll = [...updateTargets, ...scopedSources.filter(source => !source.content && !updateTargets.includes(source))];
    const remainingPages = ledger.snapshot().remaining?.pages || 0;
    const toAcquire = toAcquireAll.slice(0, remainingPages);
    if (toAcquireAll.length > toAcquire.length) {
      warnings.push(`${scope.kind}: 待抓取页面数 (${toAcquireAll.length}) 超出剩余预算 (${remainingPages})，已自动截取前 ${toAcquire.length} 页`);
    }
    if (toAcquire.length) {
      reservation = ledger.reserve('pages', toAcquire.length);
      if (!reservation.ok) return failWithProgress(costFailure(reservation));
      for (const source of toAcquire) {
        if (updateTargets.includes(source)) pageUpdateRefetchAttemptedIds.add(source.source_id);
      }
      const acquired = await callResearchAdapter(adapters.acquire, { plan, scope, sources: toAcquire, ledger }, 'RESEARCH_ACQUIRE_FAILED');
      if (acquired?.ok === false) return failWithProgress({ ...acquired, failed_scope: key });
      const byUrl = new Map((acquired?.contents || []).map(item => [canonicalizeUrl(item.url), item])
        .filter(([url, item]) => url && (item?.content || pageUpdateMetadataOf(item))));
      for (const source of toAcquire) {
        const fetched = byUrl.get(source.url);
        if (fetched?.content) {
          source.content = String(fetched.content).trim();
          source.content_origin = fetched.content_origin || 'tavily_extract';
        }
        Object.assign(source, pageUpdateMetadataOf(fetched) || {});
      }
      for (const failure of acquired?.failed || []) {
        if (failure?.url) warnings.push(`${failure.url}: ${failure.error || '正文提取失败'}`);
      }
    }
    completedScopes.add(key);
  }

  return {
    ok: true,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
    research_progress: {
      completed_scopes: [...completedScopes],
      failed_scope: null,
      page_update_refetch_attempted_ids: [...pageUpdateRefetchAttemptedIds],
    },
    _cost_ledger: ledger,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  createCostLedger,
  canonicalizeUrl,
  registrableHostOf,
  authorizedSourcesOf,
  authorizedUrlsOf,
  officialRootsOf,
  isTrustedOfficialUrl,
  sourceIdOf,
  sourcesForScope,
  pageUpdateMetadataOf,
  sourceUrlMatchesModelIdentity,
  scopeKindsOfFields,
  researchCatalog,
};
