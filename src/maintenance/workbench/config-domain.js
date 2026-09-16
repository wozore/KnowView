'use strict';

const { readJson: defaultReadJson } = require('../../shared/json-store');
const { envValue } = require('../../shared/env');
const { AI_CONFIG_FILES, NEWS_FILES, COMPARISON_FILES } = require('../../shared/paths');
const { loadAiModuleConfig } = require('../../catalog/ai-config');
const { AI_PROVIDERS } = require('../../shared/providers');

const CREDENTIALS = Object.freeze({
  zhipu: 'ZHIPU_API_KEY', deepseek: 'DEEPSEEK_API_KEY', tavily: 'TAVILY_API_KEY',
  youtube: 'YOUTUBE_API_KEY', x: 'X_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
});
const SOURCE_NAMES = Object.freeze(['openrouter', 'lmarena', 'livebench', 'llm_stats']);
const NEWS_FIELDS = Object.freeze({
  schedule: ['youtube_cron', 'youtube_tz', 'youtube_interval_hours', 'youtube_window_days', 'x_cron_hot', 'x_cron_cold', 'x_tz', 'tool_update_review_hour_utc', 'tool_update_review_minute_utc'],
  collection: ['enabled', 'youtube_search_max_per_run', 'youtube_search_cost_units', 'youtube_daily_quota_units', 'youtube_videos_batch_size', 'youtube_comments_top_n', 'x_credits_per_hot_run', 'x_credits_per_cold_run', 'x_credits_per_tweet', 'x_credits_per_article', 'x_tweets_per_request_max', 'max_output_items_daily', 'min_output_items_daily', 'max_output_with_youtube', 'review_top_pure_x', 'review_top_with_youtube', 'ai_top_input_max', 'concurrency', 'request_timeout_ms', 'max_retries', 'retry_base_ms'],
  review: ['l1_input_include_comments', 'l1_comments_top_n', 'l1_confidence_auto_approve', 'l1_confidence_auto_discard', 'l2_enabled'],
  feedback: ['tool_feedback', 'concept_feedback', 'llm_extract', 'llm_model'],
  transcripts: ['notify_count'],
});
const NEWS_TOP_FIELDS = ['schema_version', 'platforms_supported', 'schedule', 'collection', 'long_term_quality', 'review', 'keywords', 'x_accounts', 'account_groups', 'feedback', 'transcripts', 'scoring', 'manual_folder'];
const KEYWORD_FIELDS = ['content_keywords', 'youtube_queries', 'x_discovery_queries', 'excluded_content_keywords', 'excluded_youtube_queries', 'excluded_x_discovery_queries', 'refine_rule_top_n', 'refine_batch_size', 'refine_max_output', 'refine_timeout_ms'];
const LONG_TERM_FIELDS = ['observation_period_count', 'observation_score_range', 'window_n', 'window_months_youtube', 'window_months_x', 'min_samples', 'neutral_score'];
const SCORING_FIELDS = ['weights', 'type_preference_score', 'neutral_score'];
const WEIGHT_FIELDS = ['long_term_quality', 'recent_timeliness', 'light_user_experience', 'source_reliability', 'interaction_quality', 'type_preference'];
const SCORE_FIELDS = ['ai_tool', 'ai_product', 'ai_concept', 'ai_industry', 'ai_technology', 'other', 'unclassified'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failure() {
  return Object.assign(new Error('配置读取失败'), { code: 'CONFIG_READ_FAILED', status: 500 });
}

function required(readJson, file, versions = [1]) {
  try {
    const value = readJson(file);
    if (!isObject(value) || !versions.includes(value.schema_version)) throw failure();
    return value;
  } catch (error) {
    if (error?.code === 'CONFIG_READ_FAILED') throw error;
    throw failure();
  }
}

function assertKeys(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure();
}

function assertScalar(value) {
  if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) throw failure();
}

function assertType(value, predicate) {
  if (!predicate(value)) throw failure();
}

function valueItems(source, fields, sourceName) {
  if (!isObject(source)) throw failure();
  return fields.filter(field => Object.prototype.hasOwnProperty.call(source, field)).map(key => {
    assertScalar(source[key]);
    return { key, label: key, value: source[key], source: sourceName, status: 'effective' };
  });
}

function optionalStringList(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return [];
  const value = source[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw failure();
  return value.map(item => item);
}

function optionalNumberList(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return [];
  const value = source[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw failure();
  return value.map(item => item);
}

function collection(key, label, items, sourceName) {
  return { key, label, count: items.length, items, source: sourceName, status: 'effective' };
}

function section(id, label, values, collections) {
  return { id, label, values, collections };
}

function group(id, label, sections) {
  return { id, label, status: 'ok', sections };
}

function projectDiscoveryQueries(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw failure();
  return value.map(item => {
    assertKeys(item, ['id', 'query', 'max_pages']);
    assertType(item.id, value => typeof value === 'string');
    assertType(item.query, value => typeof value === 'string');
    assertType(item.max_pages, value => Number.isInteger(value) && value >= 0);
    return { id: item.id, query: item.query, max_pages: item.max_pages };
  });
}

function projectAccountGroups(value) {
  if (!Array.isArray(value)) throw failure();
  return value.map(item => {
    assertKeys(item, ['id', 'label', 'handles', 'priority', 'max_pages', 'high_frequency']);
    assertType(item.id, value => typeof value === 'string');
    assertType(item.label, value => typeof value === 'string');
    assertType(item.handles, value => Array.isArray(value) && value.every(handle => typeof handle === 'string'));
    assertType(item.priority, value => Number.isInteger(value) && value >= 0);
    assertType(item.max_pages, value => Number.isInteger(value) && value >= 0);
    assertType(item.high_frequency, value => typeof value === 'boolean');
    return { id: item.id, label: item.label, handles: item.handles.map(handle => handle), priority: item.priority, max_pages: item.max_pages, high_frequency: item.high_frequency };
  });
}

function numericEntries(source, fields, sourceName) {
  assertKeys(source, fields);
  return fields.filter(key => Object.prototype.hasOwnProperty.call(source, key)).map(key => {
    assertType(source[key], value => typeof value === 'number' && Number.isFinite(value));
    return { key, value: source[key], source: sourceName, status: 'effective' };
  });
}

function validateNewsConfig(raw) {
  assertKeys(raw, NEWS_TOP_FIELDS);
  for (const key of ['schedule', 'collection', 'review', 'keywords', 'feedback', 'transcripts', 'scoring', 'long_term_quality']) {
    if (raw[key] !== undefined && !isObject(raw[key])) throw failure();
  }
  if (!isObject(raw.schedule) || !isObject(raw.collection) || !isObject(raw.review) || !isObject(raw.keywords) || !isObject(raw.feedback) || !isObject(raw.transcripts) || !isObject(raw.scoring)) throw failure();
  assertKeys(raw.schedule, NEWS_FIELDS.schedule);
  assertKeys(raw.collection, [...NEWS_FIELDS.collection, 'twitter_api_base_url']);
  assertKeys(raw.review, NEWS_FIELDS.review);
  assertKeys(raw.keywords, KEYWORD_FIELDS);
  assertKeys(raw.feedback, NEWS_FIELDS.feedback);
  assertKeys(raw.transcripts, NEWS_FIELDS.transcripts);
  assertKeys(raw.scoring, SCORING_FIELDS);
  assertKeys(raw.long_term_quality || {}, LONG_TERM_FIELDS);
  if (!Array.isArray(raw.x_accounts) || raw.x_accounts.some(item => typeof item !== 'string')) throw failure();
  projectAccountGroups(raw.account_groups);
  projectDiscoveryQueries(raw.keywords.x_discovery_queries);
  if (raw.collection.twitter_api_base_url !== undefined) assertType(raw.collection.twitter_api_base_url, value => typeof value === 'string');
  if (raw.manual_folder !== undefined) assertType(raw.manual_folder, value => typeof value === 'string');
  return true;
}

function projectNews(raw) {
  validateNewsConfig(raw);
  const keywords = raw.keywords;
  const scoring = raw.scoring;
  const longTerm = raw.long_term_quality || {};
  const source = 'versioned';
  return group('news', '新闻采集', [
    section('schema', 'Schema', valueItems(raw, ['schema_version'], source), [collection('platforms_supported', 'Platforms supported', optionalStringList(raw, 'platforms_supported'), source)]),
    section('schedule', 'Schedule', valueItems(raw.schedule, NEWS_FIELDS.schedule, source), []),
    section('collection', 'Collection', valueItems(raw.collection, NEWS_FIELDS.collection, source), []),
    section('long_term_quality', 'Long-term quality', valueItems(longTerm, LONG_TERM_FIELDS.filter(key => key !== 'observation_score_range'), source), [collection('observation_score_range', 'Observation score range', optionalNumberList(longTerm, 'observation_score_range'), source)]),
    section('review', 'Review', valueItems(raw.review, NEWS_FIELDS.review, source), []),
    section('keywords', 'Keywords', valueItems(keywords, ['refine_rule_top_n', 'refine_batch_size', 'refine_max_output', 'refine_timeout_ms'], source), [
      collection('content_keywords', 'Content keywords', optionalStringList(keywords, 'content_keywords'), source),
      collection('youtube_queries', 'YouTube queries', optionalStringList(keywords, 'youtube_queries'), source),
      collection('x_discovery_queries', 'X discovery queries', projectDiscoveryQueries(keywords.x_discovery_queries), source),
      collection('excluded_content_keywords', 'Excluded content keywords', optionalStringList(keywords, 'excluded_content_keywords'), source),
      collection('excluded_youtube_queries', 'Excluded YouTube queries', optionalStringList(keywords, 'excluded_youtube_queries'), source),
      collection('excluded_x_discovery_queries', 'Excluded X discovery queries', optionalStringList(keywords, 'excluded_x_discovery_queries'), source),
    ]),
    section('x_sources', 'X sources', [], [
      collection('accounts', 'Accounts', raw.x_accounts.map(item => item), source),
      collection('account_groups', 'Account groups', projectAccountGroups(raw.account_groups), source),
    ]),
    section('feedback', 'Feedback', valueItems(raw.feedback, NEWS_FIELDS.feedback, source), []),
    section('transcripts', 'Transcripts', valueItems(raw.transcripts, NEWS_FIELDS.transcripts, source), []),
    section('scoring', 'Scoring', valueItems(scoring, ['neutral_score'], source), [
      collection('weights', 'Weights', numericEntries(scoring.weights, WEIGHT_FIELDS, source), source),
      collection('type_preference_score', 'Type preference score', numericEntries(scoring.type_preference_score, SCORE_FIELDS, source), source),
    ]),
  ]);
}

function projectRefreshSources(raw, mode) {
  if (!isObject(raw.sources) || Object.keys(raw.sources).some(name => !SOURCE_NAMES.includes(name))) throw failure();
  return SOURCE_NAMES.filter(name => Object.prototype.hasOwnProperty.call(raw.sources, name)).map(name => {
    const value = raw.sources[name];
    assertKeys(value, ['interval_hours', 'full_every', 'count', 'last_run', 'release', 'url']);
    assertType(value.interval_hours, item => Number.isFinite(item) && item >= 0);
    assertType(value.full_every, item => Number.isFinite(item) && item >= 0);
    if (value.release !== undefined) assertType(value.release, item => typeof item === 'string');
    if (value.url !== undefined) assertType(value.url, item => typeof item === 'string');
    if (mode === 'state') {
      assertType(value.count, item => Number.isFinite(item) && item >= 0);
      assertType(value.last_run, item => item === null || typeof item === 'string');
    }
    return mode === 'policy'
      ? { key: name, interval_hours: value.interval_hours, full_every: value.full_every, release: value.release }
      : { key: name, count: value.count, last_run: value.last_run };
  });
}

function projectAliasEntries(value) {
  if (!Array.isArray(value)) throw failure();
  return value.map(item => {
    assertKeys(item, ['model_key', 'display', 'catalog_aliases', 'aliases']);
    assertType(item.model_key, value => typeof value === 'string');
    assertType(item.display, value => typeof value === 'string');
    const aliases = item.aliases === undefined ? {} : item.aliases;
    assertKeys(aliases, SOURCE_NAMES);
    for (const source of Object.keys(aliases)) {
      if (!Array.isArray(aliases[source]) || aliases[source].some(alias => typeof alias !== 'string')) throw failure();
    }
    return { model_key: item.model_key, display: item.display, catalog_aliases: optionalStringList(item, 'catalog_aliases') };
  });
}

function projectAliases(value) {
  assertKeys(value, ['schema_version', 'vendor_aliases', 'entries', 'never_merge']);
  if (!isObject(value.vendor_aliases)) throw failure();
  const vendorAliases = Object.entries(value.vendor_aliases).map(([key, aliases]) => {
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) throw failure();
    return { key, aliases: aliases.map(alias => alias) };
  });
  if (!Array.isArray(value.never_merge) || value.never_merge.some(item => !Array.isArray(item) || item.some(model => typeof model !== 'string'))) throw failure();
  return { vendorAliases, entries: projectAliasEntries(value.entries), neverMerge: value.never_merge.map(item => item.map(model => model)) };
}

function projectExclusionRules(value) {
  if (!Array.isArray(value)) throw failure();
  return value.map(item => {
    assertKeys(item, ['vendor', 'identity_prefix', 'identities', 'reason']);
    if (item.vendor !== undefined) assertType(item.vendor, value => typeof value === 'string');
    if (item.identity_prefix !== undefined) assertType(item.identity_prefix, value => typeof value === 'string');
    if (item.reason !== undefined) assertType(item.reason, value => typeof value === 'string');
    return { vendor: item.vendor, identity_prefix: item.identity_prefix, identities: optionalStringList(item, 'identities'), reason: item.reason };
  });
}

function projectSeriesItems(value) {
  if (!Array.isArray(value)) throw failure();
  return value.map(item => {
    assertKeys(item, ['series_key', 'display', 'vendor', 'order', 'match', 'member_rules']);
    for (const key of ['series_key', 'display', 'vendor']) assertType(item[key], value => typeof value === 'string');
    assertType(item.order, value => Number.isFinite(value));
    const match = item.match === undefined ? {} : item.match;
    assertKeys(match, ['vendor', 'identity', 'identity_prefix', 'identity_prefixes']);
    for (const key of ['vendor', 'identity', 'identity_prefix']) if (match[key] !== undefined) assertType(match[key], value => typeof value === 'string');
    if (match.identity_prefixes !== undefined && (!Array.isArray(match.identity_prefixes) || match.identity_prefixes.some(value => typeof value !== 'string'))) throw failure();
    const memberRules = item.member_rules === undefined ? [] : item.member_rules;
    if (!Array.isArray(memberRules)) throw failure();
    const members = memberRules.map(rule => {
      assertKeys(rule, ['identity', 'identity_prefix', 'display', 'order']);
      for (const key of ['identity', 'identity_prefix', 'display']) if (rule[key] !== undefined) assertType(rule[key], value => typeof value === 'string');
      if (rule.order !== undefined) assertType(rule.order, value => Number.isFinite(value));
      return { identity: rule.identity, identity_prefix: rule.identity_prefix, display: rule.display, order: rule.order };
    });
    return { series_key: item.series_key, display: item.display, vendor: item.vendor, order: item.order, match: { vendor: match.vendor, identity: match.identity, identity_prefix: match.identity_prefix, identity_prefixes: match.identity_prefixes === undefined ? undefined : match.identity_prefixes.map(value => value) }, member_rules: members };
  });
}

function projectComparison(view, refresh, aliases, exclusions, series) {
  assertKeys(view, ['schema_version', 'default_dimensions', 'radar_dimension_cap', 'model_cap']);
  if (!Array.isArray(view.default_dimensions) || view.default_dimensions.some(item => typeof item !== 'string')) throw failure();
  assertKeys(refresh, ['schema_version', 'sources']);
  assertKeys(aliases, ['schema_version', 'vendor_aliases', 'entries', 'never_merge']);
  assertKeys(exclusions, ['schema_version', 'rules']);
  assertKeys(series, ['schema_version', 'series']);
  const policyItems = projectRefreshSources(refresh, 'policy');
  const stateItems = projectRefreshSources(refresh, 'state');
  const aliasData = projectAliases(aliases);
  const exclusionItems = projectExclusionRules(exclusions.rules);
  const seriesItems = projectSeriesItems(series.series);
  const source = 'versioned';
  return group('comparison', '模型对比', [
    section('view', 'View', valueItems(view, ['schema_version', 'radar_dimension_cap', 'model_cap'], source), [collection('default_dimensions', 'Default dimensions', view.default_dimensions.map(item => item), source)]),
    section('refresh_policy', 'Refresh policy', valueItems(refresh, ['schema_version'], source), [collection('sources', 'Sources', policyItems, source)]),
    section('refresh_state', 'Refresh state', valueItems(refresh, ['schema_version'], 'derived'), [collection('sources', 'Sources', stateItems, 'derived')]),
    section('aliases', 'Aliases', valueItems(aliases, ['schema_version'], source), [
      collection('vendor_aliases', 'Vendor aliases', aliasData.vendorAliases, source),
      collection('entries', 'Entries', aliasData.entries, source),
      collection('never_merge', 'Never merge', aliasData.neverMerge, source),
    ]),
    section('exclusions', 'Exclusions', valueItems(exclusions, ['schema_version'], source), [collection('rules', 'Rules', exclusionItems, source)]),
    section('series', 'Series', valueItems(series, ['schema_version'], source), [collection('series', 'Series', seriesItems, source)]),
  ]);
}

function projectProviders(providers) {
  if (!isObject(providers)) throw failure();
  return Object.entries(providers).map(([name, provider]) => {
    if (!isObject(provider)) throw failure();
    assertKeys(provider, ['name', 'label', 'protocol', 'apiKeyEnv', 'messagesEndpoint', 'chatEndpoint', 'responsesEndpoint', 'defaultModel', 'implemented']);
    const providerName = provider.name === undefined ? name : provider.name;
    const label = provider.label === undefined ? name : provider.label;
    assertType(providerName, value => typeof value === 'string');
    assertType(label, value => typeof value === 'string');
    assertType(provider.protocol, value => typeof value === 'string');
    for (const key of ['apiKeyEnv', 'messagesEndpoint', 'chatEndpoint', 'responsesEndpoint']) if (provider[key] !== undefined && provider[key] !== null) assertType(provider[key], value => typeof value === 'string');
    if (provider.defaultModel !== undefined && provider.defaultModel !== null) assertType(provider.defaultModel, value => typeof value === 'string');
    if (provider.implemented !== undefined) assertType(provider.implemented, value => typeof value === 'boolean');
    return { name: providerName, label, protocol: provider.protocol, default_model: provider.defaultModel ?? null, implemented: provider.implemented !== false };
  });
}

function projectCatalog(config, providers) {
  const source = 'source_default';
  if (!isObject(config) || ['provider', 'model', 'protocol', 'retrieval_provider'].some(key => typeof config[key] !== 'string' || !config[key].trim())) throw failure();
  if (config.enabled !== undefined) assertType(config.enabled, value => typeof value === 'boolean');
  const limits = ['timeout_ms', 'max_search_queries', 'max_pages', 'max_responses_calls', 'max_synthesis_calls', 'max_repair_calls'];
  return group('catalog_ai', 'Catalog AI', [
    section('effective', 'Effective configuration', valueItems(config, ['enabled', 'provider', 'model', 'protocol', 'retrieval_provider'], source), []),
    section('limits', 'Limits', valueItems(config, limits, source), []),
    section('providers', 'Provider registry', [], [collection('providers', 'Providers', projectProviders(providers), 'source_default')]),
  ]);
}

function credentialState(name, env) {
  try {
    const value = typeof env === 'function' ? env(name) : env?.[name];
    return value == null ? 'unconfigured' : String(value).trim() ? 'configured' : 'unconfigured';
  } catch {
    return 'unknown';
  }
}

function projectEnvironment(env) {
  const credentials = Object.entries(CREDENTIALS).map(([key, variable]) => ({ key, status: credentialState(variable, env) }));
  return group('environment', '运行环境', [
    section('credentials', 'Credentials', [], [collection('credentials', 'Credentials', credentials, 'environment')]),
    section('network', 'Network', valueItems({ network_probe_performed: false }, ['network_probe_performed'], 'environment'), []),
  ]);
}

function filesOf(options) {
  const files = options.files || options.configFiles || options.paths || {};
  return {
    news: files.news || files.newsConfig || options.newsConfigFile || NEWS_FILES.configV2,
    view: files.view || files.viewConfig || options.viewConfigFile || COMPARISON_FILES.viewConfig,
    refresh: files.refresh || files.refreshConfig || options.refreshConfigFile || COMPARISON_FILES.refreshConfig,
    aliases: files.aliases || files.modelsAlias || options.modelsAliasFile || COMPARISON_FILES.modelsAlias,
    exclusions: files.exclusions || files.modelExclusions || options.modelExclusionsFile || COMPARISON_FILES.modelExclusions,
    series: files.series || files.modelSeries || options.modelSeriesFile || COMPARISON_FILES.modelSeries,
    catalog: files.catalog || files.catalogConfig || options.catalogConfigFile || AI_CONFIG_FILES.local,
  };
}

function createConfigDomain(options = {}) {
  const readJson = options.readJson || defaultReadJson;
  const files = filesOf(options);
  const loadCatalog = options.loadCatalogConfig || (name => loadAiModuleConfig(name, files.catalog));
  const providers = options.providers || AI_PROVIDERS;
  const env = options.env === undefined ? envValue : options.env;
  return Object.freeze({
    read() {
      try {
        const news = required(readJson, files.news);
        const view = required(readJson, files.view);
        const refresh = required(readJson, files.refresh);
        const aliases = required(readJson, files.aliases, [1, 2]);
        const exclusions = required(readJson, files.exclusions);
        const series = required(readJson, files.series);
        validateNewsConfig(news);
        const catalog = loadCatalog('catalog');
        if (!isObject(catalog)) throw failure();
        return {
          schema_version: 1,
          mode: 'read_only',
          groups: [projectNews(news), projectComparison(view, refresh, aliases, exclusions, series), projectCatalog(catalog, providers), projectEnvironment(env)],
        };
      } catch (error) {
        if (error?.code === 'CONFIG_READ_FAILED') throw error;
        throw failure();
      }
    },
  });
}

module.exports = { CREDENTIALS, createConfigDomain, projectNews, projectComparison, projectCatalog, projectEnvironment };
