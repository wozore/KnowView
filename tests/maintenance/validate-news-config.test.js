/**
 * validate-news-config.test.js — 热点配置与 last-run credits 账本校验
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNewsConfig, validateLastRun } = require('../../src/maintenance/validate-news');

const BASE_VALID_CONFIG = {
  schedule: {
    x_cron_hot: '30 0 * * *',
    x_cron_cold: '30 12 * * *',
  },
  collection: {
    enabled: true,
    x_credits_per_hot_run: 7500,
    x_credits_per_cold_run: 2500,
    x_credits_per_tweet: 15,
    x_credits_per_article: 100,
    x_tweets_per_request_max: 20,
  },
  x_accounts: [
    'OpenAI', 'deepseek_ai', 'ChatGPTapp', 'midjourney', 'GroqLLC', 'lmsysorg',
    'xiaohu', 'testingcatalog', 'emollick', 'nima_owji', 'NVIDIAAI',
  ],
  account_groups: [
    { id: 'g1', label: '组1', handles: ['OpenAI'], priority: 1, max_pages: 1, high_frequency: false },
    { id: 'g2', label: '组2', handles: ['deepseek_ai'], priority: 2, max_pages: 1, high_frequency: false },
    { id: 'g3', label: '组3', handles: ['ChatGPTapp'], priority: 3, max_pages: 1, high_frequency: false },
    { id: 'g4', label: '组4', handles: ['midjourney'], priority: 4, max_pages: 1, high_frequency: false },
    { id: 'g5', label: '组5', handles: ['GroqLLC'], priority: 5, max_pages: 1, high_frequency: false },
    { id: 'g6', label: '组6', handles: ['lmsysorg'], priority: 6, max_pages: 1, high_frequency: false },
    { id: 'g7', label: '组7', handles: ['xiaohu', 'testingcatalog', 'emollick', 'nima_owji', 'NVIDIAAI'], priority: 7, max_pages: 1, high_frequency: true },
  ],
  keywords: {
    content_keywords: ['ai', 'llm'],
    youtube_queries: ['OpenAI Sora'],
    x_discovery_queries: [
      { id: 'release-events', query: '(AI OR LLM) (launch OR release)', max_pages: 1 },
    ],
    excluded_content_keywords: ['robot'],
    excluded_youtube_queries: [],
    excluded_x_discovery_queries: [],
  },
};

const VALID_LAST_RUN = {
  schema_version: 1,
  run_id: 'test-run',
  collected_at: '2026-08-12T02:00:00.000Z',
  platforms: ['x'],
  collectors: {
    youtube: { status: 'not_run', items: 0 },
    x: {
      status: 'partial',
      items: 5,
      credits: {
        used: 515,
        budget: 7500,
        tweets: 1,
        articles: 0,
        requests: { total: 4, tweet: 2, article: 2, retries: 2 },
      },
    },
  },
};

function collectErrors(validate, data) {
  const errors = [];
  const valid = validate(data, message => errors.push(message));
  return { valid, errors };
}

test('validateNewsConfig 接受合法完整配置', () => {
  assert.deepEqual(collectErrors(validateNewsConfig, BASE_VALID_CONFIG), { valid: true, errors: [] });
});

test('validateNewsConfig 接受实际生产配置文件 news-config-v2.json', () => {
  const file = path.resolve(__dirname, '../../data/news/config/news-config-v2.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = collectErrors(validateNewsConfig, cfg);
  assert.equal(res.valid, true, `生产配置应通过校验，实际报错: ${res.errors.join('; ')}`);
});

test('validateNewsConfig 拒绝弃用字段 (fail-closed)', () => {
  const deprecatedCases = [
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_run: 3750 } }, 'collection.x_credits_per_run'],
    [{ ...BASE_VALID_CONFIG, keywords: { ...BASE_VALID_CONFIG.keywords, ai_keywords: ['ai'] } }, 'keywords.ai_keywords'],
    [{ ...BASE_VALID_CONFIG, keywords: { ...BASE_VALID_CONFIG.keywords, excluded_keywords: ['robot'] } }, 'keywords.excluded_keywords'],
    [{ ...BASE_VALID_CONFIG, schedule: { ...BASE_VALID_CONFIG.schedule, x_cron_first: '0 5 * * *' } }, 'schedule.x_cron_first'],
    [{ ...BASE_VALID_CONFIG, schedule: { ...BASE_VALID_CONFIG.schedule, x_cron_second: '0 14 * * *' } }, 'schedule.x_cron_second'],
  ];

  for (const [cfg, field] of deprecatedCases) {
    const res = collectErrors(validateNewsConfig, cfg);
    assert.equal(res.valid, false, `包含旧字段 ${field} 时应被拒绝`);
    assert.ok(res.errors.some(msg => msg.includes(field)), `错误信息应指出 ${field}`);
  }
});

test('validateNewsConfig 拒绝非法 collection 字段', () => {
  const cases = [
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, enabled: 'true' } }, 'enabled'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_hot_run: -1 } }, 'x_credits_per_hot_run'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_hot_run: 7501 } }, 'x_credits_per_hot_run'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_cold_run: -1 } }, 'x_credits_per_cold_run'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_cold_run: 2501 } }, 'x_credits_per_cold_run'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_tweet: 14 } }, 'x_credits_per_tweet'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_credits_per_article: 99 } }, 'x_credits_per_article'],
    [{ ...BASE_VALID_CONFIG, collection: { ...BASE_VALID_CONFIG.collection, x_tweets_per_request_max: 19 } }, 'x_tweets_per_request_max'],
  ];

  for (const [cfg, field] of cases) {
    const res = collectErrors(validateNewsConfig, cfg);
    assert.equal(res.valid, false, `${field} 非法时应失败`);
    assert.ok(res.errors.some(msg => msg.includes(field)));
  }
});

test('validateNewsConfig 拒绝非法 schedule 字段', () => {
  const cases = [
    [{ ...BASE_VALID_CONFIG, schedule: null }, 'schedule'],
    [{ ...BASE_VALID_CONFIG, schedule: { x_cron_cold: '30 12 * * *' } }, 'x_cron_hot'],
    [{ ...BASE_VALID_CONFIG, schedule: { x_cron_hot: ' ', x_cron_cold: '30 12 * * *' } }, 'x_cron_hot'],
    [{ ...BASE_VALID_CONFIG, schedule: { x_cron_hot: '30 0 * * *' } }, 'x_cron_cold'],
  ];

  for (const [cfg, field] of cases) {
    const res = collectErrors(validateNewsConfig, cfg);
    assert.equal(res.valid, false, `${field} 非法时应失败`);
  }
});

test('validateNewsConfig 拒绝非法 account_groups 与 handle 不一致', () => {
  // 组数不等于 7
  const sixGroups = BASE_VALID_CONFIG.account_groups.slice(0, 6);
  assert.equal(collectErrors(validateNewsConfig, { ...BASE_VALID_CONFIG, account_groups: sixGroups }).valid, false);

  // 组内 handle 重复
  const dupInGroup = structuredClone(BASE_VALID_CONFIG);
  dupInGroup.account_groups[0].handles = ['OpenAI', 'openai'];
  assert.equal(collectErrors(validateNewsConfig, dupInGroup).valid, false);

  // 跨组 handle 重叠
  const crossGroupOverlap = structuredClone(BASE_VALID_CONFIG);
  crossGroupOverlap.account_groups[1].handles.push('openai');
  assert.equal(collectErrors(validateNewsConfig, crossGroupOverlap).valid, false);

  // G7 high_frequency 不匹配
  const badG7 = structuredClone(BASE_VALID_CONFIG);
  badG7.account_groups[6].high_frequency = false;
  assert.equal(collectErrors(validateNewsConfig, badG7).valid, false);

  // G7 缺少高频账号
  const g7MissingHf = structuredClone(BASE_VALID_CONFIG);
  g7MissingHf.account_groups[6].handles = ['xiaohu'];
  g7MissingHf.x_accounts = ['OpenAI', 'deepseek_ai', 'ChatGPTapp', 'midjourney', 'GroqLLC', 'lmsysorg', 'xiaohu'];
  assert.equal(collectErrors(validateNewsConfig, g7MissingHf).valid, false);

  // account_groups 并集与 x_accounts 不一致（x_accounts 多出账号）
  const xAccExtra = structuredClone(BASE_VALID_CONFIG);
  xAccExtra.x_accounts.push('extra_account');
  assert.equal(collectErrors(validateNewsConfig, xAccExtra).valid, false);

  // x_accounts 存在重复
  const xAccDup = structuredClone(BASE_VALID_CONFIG);
  xAccDup.x_accounts.push('OpenAI');
  assert.equal(collectErrors(validateNewsConfig, xAccDup).valid, false);

  // 缺少 g7 组（把 g7 换成 g8 且 high_frequency=false）
  const noG7Config = structuredClone(BASE_VALID_CONFIG);
  noG7Config.account_groups[6].id = 'g8';
  noG7Config.account_groups[6].high_frequency = false;
  const noG7Res = collectErrors(validateNewsConfig, noG7Config);
  assert.equal(noG7Res.valid, false);
  assert.ok(noG7Res.errors.some(msg => msg.includes('g7')));

  // 单组 handle 超过 16
  const tooManyHandlesConfig = structuredClone(BASE_VALID_CONFIG);
  const extraHandles = Array.from({ length: 17 }, (_, i) => `acc_${i}`);
  tooManyHandlesConfig.account_groups[0].handles = extraHandles;
  tooManyHandlesConfig.x_accounts = [
    ...extraHandles,
    ...BASE_VALID_CONFIG.x_accounts.filter(h => h !== 'OpenAI'),
  ];
  const tooManyHandlesRes = collectErrors(validateNewsConfig, tooManyHandlesConfig);
  assert.equal(tooManyHandlesRes.valid, false);
  assert.ok(tooManyHandlesRes.errors.some(msg => msg.includes('超过 16')));
});

test('validateNewsConfig 拒绝非法 keywords 配置', () => {
  // 缺少段落
  const missingSection = structuredClone(BASE_VALID_CONFIG);
  delete missingSection.keywords.content_keywords;
  assert.equal(collectErrors(validateNewsConfig, missingSection).valid, false);

  // content_keywords 为空
  const emptyContentKw = structuredClone(BASE_VALID_CONFIG);
  emptyContentKw.keywords.content_keywords = [];
  assert.equal(collectErrors(validateNewsConfig, emptyContentKw).valid, false);

  // 正向词与排除词重叠
  const overlapKw = structuredClone(BASE_VALID_CONFIG);
  overlapKw.keywords.excluded_content_keywords = ['ai'];
  assert.equal(collectErrors(validateNewsConfig, overlapKw).valid, false);

  // x_discovery_queries 包含动态时间操作符
  const timeOpKw = structuredClone(BASE_VALID_CONFIG);
  timeOpKw.keywords.x_discovery_queries[0].query = 'AI since_time:12345';
  assert.equal(collectErrors(validateNewsConfig, timeOpKw).valid, false);

  const timeOpParen1 = structuredClone(BASE_VALID_CONFIG);
  timeOpParen1.keywords.x_discovery_queries[0].query = '(AI) (since_time:123)';
  assert.equal(collectErrors(validateNewsConfig, timeOpParen1).valid, false);

  const timeOpParen2 = structuredClone(BASE_VALID_CONFIG);
  timeOpParen2.keywords.x_discovery_queries[0].query = '(until:2026-09-10)';
  assert.equal(collectErrors(validateNewsConfig, timeOpParen2).valid, false);

  // x_discovery_queries 长度超限
  const longQueryKw = structuredClone(BASE_VALID_CONFIG);
  longQueryKw.keywords.x_discovery_queries[0].query = 'a'.repeat(769);
  assert.equal(collectErrors(validateNewsConfig, longQueryKw).valid, false);

  // x_discovery_queries max_pages 不为 1
  const badMaxPages = structuredClone(BASE_VALID_CONFIG);
  badMaxPages.keywords.x_discovery_queries[0].max_pages = 2;
  assert.equal(collectErrors(validateNewsConfig, badMaxPages).valid, false);

  // x_discovery_queries id 重复
  const dupXId = structuredClone(BASE_VALID_CONFIG);
  dupXId.keywords.x_discovery_queries.push({ id: 'release-events', query: 'other', max_pages: 1 });
  assert.equal(collectErrors(validateNewsConfig, dupXId).valid, false);
});

test('validateLastRun 接受完整自洽且 budget <= 7500 的 X credits 账本', () => {
  assert.deepEqual(collectErrors(validateLastRun, VALID_LAST_RUN), { valid: true, errors: [] });
});

test('validateLastRun 拒绝超预算、负数和请求统计不自洽', () => {
  const cases = [
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, used: 8000 } } } },
      'used',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, budget: 7501 } } } },
      'budget',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, tweets: -1 } } } },
      'tweets',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, requests: { total: 5, tweet: 2, article: 2, retries: 2 } } } } },
      'total',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, requests: { total: 4, tweet: 2, article: 2, retries: 5 } } } } },
      'retries',
    ],
  ];

  for (const [lastRun, field] of cases) {
    const result = collectErrors(validateLastRun, lastRun);
    assert.equal(result.valid, false, `${field} 非法时应失败`);
    assert.ok(result.errors.some(message => message.includes(field)));
  }
});
