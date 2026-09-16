'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConfigDomain } = require('../../src/maintenance/workbench/config-domain');

const files = { news: 'news', view: 'view', refresh: 'refresh', aliases: 'aliases', exclusions: 'exclusions', series: 'series', catalog: 'catalog' };

function fixtures() {
  return {
    news: {
      schema_version: 1,
      schedule: { youtube_cron: '0 0 * * *', x_cron_hot: '30 0 * * *' },
      collection: { enabled: true, concurrency: 5, request_timeout_ms: 15000, twitter_api_base_url: 'https://private.invalid' },
      review: { l2_enabled: true },
      keywords: { content_keywords: ['ai'], youtube_queries: ['AI news'], x_discovery_queries: [{ id: 'release', query: 'launch', max_pages: 1 }], excluded_content_keywords: ['spam'] },
      x_accounts: ['OpenAI'], account_groups: [{ id: 'g1', label: 'group', handles: ['OpenAI'], priority: 1, max_pages: 1, high_frequency: false }],
      feedback: { tool_feedback: true, llm_model: 'model-a' }, transcripts: { notify_count: '3to5' },
      scoring: { weights: { long_term_quality: 0.2 }, type_preference_score: { ai_tool: 90 }, neutral_score: 50 },
      long_term_quality: { observation_score_range: [20, 60], observation_period_count: 3 },
    },
    view: { schema_version: 1, default_dimensions: ['composite', 'value'], radar_dimension_cap: 12, model_cap: 5 },
    refresh: { schema_version: 1, sources: { openrouter: { interval_hours: 48, full_every: 10, count: 2, last_run: '2026-09-01T00:00:00.000Z', url: 'https://private.invalid' } } },
    aliases: { schema_version: 2, vendor_aliases: { qwen: ['qwen'] }, entries: [{ model_key: 'qwen--qwen3', display: 'Qwen3', catalog_aliases: ['qwen3'] }], never_merge: [['a', 'b']] },
    exclusions: { schema_version: 1, rules: [{ vendor: 'openai', identity_prefix: 'gpt-6', identities: ['gpt-5'], reason: 'manual policy' }] },
    series: { schema_version: 1, series: [{ series_key: 'qwen--qwen3', display: 'Qwen3', vendor: 'qwen', order: 1, match: { vendor: 'qwen', identity_prefix: 'qwen3' }, member_rules: [{ identity: 'qwen3', display: 'base', order: 0 }] }] },
  };
}

function domainWith(overrides = {}) {
  const source = { ...fixtures(), ...overrides };
  return createConfigDomain({
    files,
    readJson: file => {
      if (!(file in source)) throw new Error('missing fixture');
      if (source[file] instanceof Error) throw source[file];
      return source[file];
    },
    loadCatalogConfig: () => source.catalog || { enabled: true, provider: 'zhipu', model: 'glm-test', protocol: 'messages', retrieval_provider: 'tavily', timeout_ms: 1000, max_search_queries: 2, max_pages: 3, max_responses_calls: 4, max_synthesis_calls: 1, max_repair_calls: 1 },
    providers: { test: { name: 'test', label: 'Test', protocol: 'chat', defaultModel: 'test-model', implemented: true, chatEndpoint: 'https://private.invalid' } },
    env: { ZHIPU_API_KEY: 'secret', DEEPSEEK_API_KEY: '', TAVILY_API_KEY: 'secret', YOUTUBE_API_KEY: undefined, X_API_KEY: 'secret', OPENAI_API_KEY: null, ANTHROPIC_API_KEY: 'secret' },
  });
}

test('配置域按固定四组输出逐字段安全投影', () => {
  const result = domainWith().read();
  assert.deepEqual(result.groups.map(group => group.id), ['news', 'comparison', 'catalog_ai', 'environment']);
  for (const group of result.groups) {
    assert.deepEqual(Object.keys(group).sort(), ['id', 'label', 'sections', 'status']);
    assert.equal(group.status, 'ok');
    for (const part of group.sections) {
      assert.equal(Array.isArray(part.values), true);
      assert.equal(Array.isArray(part.collections), true);
      for (const item of [...part.values, ...part.collections]) assert.equal(typeof item.key, 'string');
    }
  }
  assert.equal(result.schema_version, 1);
  assert.equal(result.mode, 'read_only');
  const serialized = JSON.stringify(result);
  for (const forbidden of ['must-not-appear', 'private.invalid', 'absolute_path', 'api_key', 'url']) assert.equal(serialized.includes(forbidden), false, forbidden);
  const newsSections = Object.fromEntries(result.groups[0].sections.map(section => [section.id, section]));
  const comparisonSections = Object.fromEntries(result.groups[1].sections.map(section => [section.id, section]));
  const catalogSections = Object.fromEntries(result.groups[2].sections.map(section => [section.id, section]));
  const environmentSections = Object.fromEntries(result.groups[3].sections.map(section => [section.id, section]));
  assert.equal(newsSections.collection.values.find(item => item.key === 'enabled').value, true);
  assert.deepEqual(newsSections.long_term_quality.collections[0].items, [20, 60]);
  assert.equal(newsSections.long_term_quality.values.some(item => item.key === 'observation_score_range'), false);
  assert.equal(newsSections.x_sources.collections[1].items[0].id, 'g1');
  assert.equal(comparisonSections.refresh_policy.collections[0].items[0].interval_hours, 48);
  assert.equal(comparisonSections.refresh_state.collections[0].items[0].count, 2);
  assert.equal(catalogSections.effective.values.find(item => item.key === 'provider').value, 'zhipu');
  assert.equal(catalogSections.providers.collections[0].items[0].default_model, 'test-model');
  const credentials = Object.fromEntries(environmentSections.credentials.collections[0].items.map(item => [item.key, item.status]));
  assert.deepEqual(credentials, { zhipu: 'configured', deepseek: 'unconfigured', tavily: 'configured', youtube: 'unconfigured', x: 'configured', openai: 'unconfigured', anthropic: 'configured' });
  assert.equal(environmentSections.network.values.find(item => item.key === 'network_probe_performed').value, false);
});

test('Catalog 缺失 local override 使用注入的有效默认值，覆盖值按有效接口读取', () => {
  const defaulted = domainWith({ catalog: undefined }).read();
  const defaultSection = defaulted.groups[2].sections.find(section => section.id === 'effective');
  assert.equal(defaultSection.values.find(item => item.key === 'model').value, 'glm-test');
  const overridden = domainWith({ catalog: { enabled: false, provider: 'test', model: 'override', protocol: 'chat', retrieval_provider: 'tavily', max_pages: 9 } }).read();
  const overrideSections = Object.fromEntries(overridden.groups[2].sections.map(section => [section.id, section]));
  assert.equal(overrideSections.effective.values.find(item => item.key === 'model').value, 'override');
  assert.equal(overrideSections.limits.values.find(item => item.key === 'max_pages').value, 9);
});

test('必需版本化配置缺失、损坏或版本错误统一 fail-closed', () => {
  for (const key of ['news', 'view', 'refresh', 'aliases', 'exclusions', 'series']) {
    assert.throws(() => domainWith({ [key]: new Error('internal path') }).read(), error => error.code === 'CONFIG_READ_FAILED' && error.status === 500);
  }
  assert.throws(() => domainWith({ view: { schema_version: 99 } }).read(), error => error.code === 'CONFIG_READ_FAILED');
  assert.throws(() => domainWith({ catalog: new Error('damaged local override') }).read(), error => error.code === 'CONFIG_READ_FAILED');
});

test('嵌套白名单字段出现对象注入时 fail-closed 且错误不含敏感值', () => {
  const base = fixtures();
  const cases = [
    {
      label: 'news schedule scalar',
      overrides: { news: { ...base.news, schedule: { ...base.news.schedule, youtube_cron: { api_key: 'secret-schedule' } } } },
    },
    {
      label: 'catalog limits scalar',
      overrides: { catalog: { enabled: true, provider: 'test', model: 'model', protocol: 'chat', retrieval_provider: 'tavily', max_pages: { endpoint: 'https://secret.invalid' } } },
    },
    {
      label: 'comparison policy nested endpoint',
      overrides: { refresh: { ...base.refresh, sources: { openrouter: { ...base.refresh.sources.openrouter, endpoint: { api_key: 'secret-policy' } } } } },
    },
    {
      label: 'comparison policy nested api key',
      overrides: { refresh: { ...base.refresh, sources: { openrouter: { ...base.refresh.sources.openrouter, interval_hours: { api_key: 'secret-policy-key' } } } } },
    },
    {
      label: 'comparison state nested endpoint',
      overrides: { refresh: { ...base.refresh, sources: { openrouter: { ...base.refresh.sources.openrouter, last_run: { endpoint: 'https://secret-state.invalid' } } } } },
    },
    {
      label: 'comparison state nested api key',
      overrides: { refresh: { ...base.refresh, sources: { openrouter: { ...base.refresh.sources.openrouter, last_run: { api_key: 'secret-state' } } } } },
    },
  ];
  for (const item of cases) {
    assert.throws(() => domainWith(item.overrides).read(), error => {
      assert.equal(error.code, 'CONFIG_READ_FAILED', item.label);
      assert.equal(error.status, 500, item.label);
      assert.equal(error.message.includes('secret'), false, item.label);
      return true;
    });
  }
});

test('环境状态读取异常只投影 unknown，且不做网络探测', () => {
  const source = fixtures();
  const result = createConfigDomain({
    files,
    readJson: file => source[file],
    loadCatalogConfig: () => ({ provider: 'local', model: 'bonsai', protocol: 'chat', retrieval_provider: 'tavily' }),
    providers: {},
    env: name => { if (name === 'X_API_KEY') throw new Error('unavailable'); return undefined; },
  }).read();
  const environment = result.groups[3].sections.find(section => section.id === 'credentials');
  const xCredential = environment.collections[0].items.find(item => item.key === 'x');
  assert.equal(xCredential.status, 'unknown');
  const network = result.groups[3].sections.find(section => section.id === 'network');
  assert.equal(network.values.find(item => item.key === 'network_probe_performed').value, false);
});
