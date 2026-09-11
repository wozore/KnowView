/**
 * validate-news.js — 知览 KnowView news 域数据校验
 *
 * 校验 news 域核心数据：news-config-v2、last-run、hotspots 与 min-candidates。
 * 失败记录独立 fail() 状态，由 validate.js 聚合为退出码。
 */

'use strict';

const fs = require('fs');
const { NEWS_FILES } = require('../shared/paths');
const { MIN_REVIEW_STATUSES } = require('../news/min/min-store');

let failed = false;

function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

function checkRequired(obj, path, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) fail(`${path}.${f} 缺失`);
  }
}

const NEWS_PLATFORMS = ['youtube', 'x'];
const SOURCE_TYPES = ['youtube_video', 'x_post', 'unknown'];
const CONTENT_TYPES = [
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified'
];

const X_CREDITS_MAX_PER_HOT_RUN = 7500, X_CREDITS_MAX_PER_COLD_RUN = 2500, X_CREDITS_MAX_BUDGET = 7500;
const X_CREDITS_MIN_PER_TWEET = 15, X_CREDITS_MIN_PER_ARTICLE = 100, X_TWEETS_MIN_PER_REQUEST_MAX = 20;
const HIGH_FREQ_HANDLES = new Set(['xiaohu', 'testingcatalog', 'emollick', 'nima_owji', 'nvidiaai']);

const isNonNegInt = v => Number.isInteger(v) && v >= 0;
const normStr = s => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const normHandle = h => (typeof h === 'string' ? h.trim().replace(/^@/, '').toLowerCase() : '');

function validateNewsConfigCore(data, reject) {
  const DEPRECATED_FIELDS = [
    ['collection.x_credits_per_run', data.collection?.x_credits_per_run],
    ['keywords.ai_keywords', data.keywords?.ai_keywords],
    ['keywords.excluded_keywords', data.keywords?.excluded_keywords],
    ['schedule.x_cron_first', data.schedule?.x_cron_first],
    ['schedule.x_cron_second', data.schedule?.x_cron_second],
  ];
  for (const [f, val] of DEPRECATED_FIELDS) {
    if (val !== undefined) reject('NEWS_CONFIG_DEPRECATED_FIELD', `配置包含弃用字段 ${f}`);
  }
  const sch = data.schedule;
  if (!sch || typeof sch !== 'object' || Array.isArray(sch)) {
    reject('NEWS_CONFIG_SCHEDULE_INVALID', 'news-config-v2.json.schedule 应为对象');
  } else {
    for (const k of ['x_cron_hot', 'x_cron_cold']) {
      if (typeof sch[k] !== 'string' || !sch[k].trim()) reject('NEWS_CONFIG_SCHEDULE_INVALID', `schedule.${k} 应为非空字符串`);
    }
  }
  const col = data.collection;
  if (!col || typeof col !== 'object' || Array.isArray(col)) {
    reject('NEWS_CONFIG_SECTION_INVALID', 'news-config-v2.json.collection 应为对象');
    return;
  }
  if (typeof col.enabled !== 'boolean') reject('NEWS_CONFIG_ENABLED_INVALID', 'collection.enabled 应为布尔值');
  if (!isNonNegInt(col.x_credits_per_hot_run) || col.x_credits_per_hot_run > X_CREDITS_MAX_PER_HOT_RUN) {
    reject('NEWS_CONFIG_HOT_BUDGET_INVALID', `x_credits_per_hot_run 应为 0–${X_CREDITS_MAX_PER_HOT_RUN} 整数`);
  }
  if (!isNonNegInt(col.x_credits_per_cold_run) || col.x_credits_per_cold_run > X_CREDITS_MAX_PER_COLD_RUN) {
    reject('NEWS_CONFIG_COLD_BUDGET_INVALID', `x_credits_per_cold_run 应为 0–${X_CREDITS_MAX_PER_COLD_RUN} 整数`);
  }
  if (!Number.isInteger(col.x_credits_per_tweet) || col.x_credits_per_tweet < X_CREDITS_MIN_PER_TWEET) {
    reject('NEWS_CONFIG_TWEET_COST_INVALID', `x_credits_per_tweet 应为不小于 ${X_CREDITS_MIN_PER_TWEET} 整数`);
  }
  if (!Number.isInteger(col.x_credits_per_article) || col.x_credits_per_article < X_CREDITS_MIN_PER_ARTICLE) {
    reject('NEWS_CONFIG_ARTICLE_COST_INVALID', `x_credits_per_article 应为不小于 ${X_CREDITS_MIN_PER_ARTICLE} 整数`);
  }
  if (!Number.isInteger(col.x_tweets_per_request_max) || col.x_tweets_per_request_max < X_TWEETS_MIN_PER_REQUEST_MAX) {
    reject('NEWS_CONFIG_REQUEST_MAX_INVALID', `x_tweets_per_request_max 应为不小于 ${X_TWEETS_MIN_PER_REQUEST_MAX} 整数`);
  }
}

function validateAccountGroups(data, reject) {
  const groups = data.account_groups;
  if (!Array.isArray(groups) || groups.length !== 7) {
    reject('NEWS_CONFIG_GROUPS_INVALID', 'account_groups 必须为长度为 7 的数组');
    return;
  }
  if (!Array.isArray(data.x_accounts) || data.x_accounts.length === 0) {
    reject('NEWS_CONFIG_ACCOUNTS_INVALID', 'x_accounts 必须为非空数组');
    return;
  }
  const allGroupHandles = new Set();
  const groupIds = new Set();
  const priorities = new Set();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const tag = `account_groups[${i}]`;
    if (!g || typeof g !== 'object') { reject('NEWS_CONFIG_GROUPS_INVALID', `${tag} 应为对象`); continue; }
    if (!g.id || typeof g.id !== 'string' || groupIds.has(g.id)) reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.id 缺失或重复`);
    groupIds.add(g.id);
    if (!g.label || typeof g.label !== 'string') reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.label 必须为非空字符串`);
    if (!Number.isInteger(g.priority) || g.priority < 1 || g.priority > 7 || priorities.has(g.priority)) {
      reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.priority 应为 1..7 唯一整数`);
    }
    priorities.add(g.priority);
    if (!Number.isInteger(g.max_pages) || g.max_pages < 1) reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.max_pages 应为正整数`);
    if (typeof g.high_frequency !== 'boolean') reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.high_frequency 必须为布尔值`);
    const isG7 = g.id === 'g7';
    if (isG7 !== g.high_frequency) reject('NEWS_CONFIG_GROUPS_INVALID', `${tag} G7 与 high_frequency 必须对应`);
    if (!Array.isArray(g.handles) || g.handles.length === 0) {
      reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.handles 必须为非空数组`);
      continue;
    }
    if (g.handles.length > 16) reject('NEWS_CONFIG_GROUPS_INVALID', `${tag}.handles 数量不得超过 16`);
    const thisGroupHandles = new Set();
    for (const h of g.handles) {
      const nh = normHandle(h);
      if (!nh) { reject('NEWS_CONFIG_GROUPS_INVALID', `${tag} 存在空 handle`); continue; }
      if (thisGroupHandles.has(nh)) reject('NEWS_CONFIG_GROUPS_INVALID', `${tag} handle 重复: ${h}`);
      if (allGroupHandles.has(nh)) reject('NEWS_CONFIG_GROUPS_INVALID', `handle 跨组重复: ${h}`);
      thisGroupHandles.add(nh);
      allGroupHandles.add(nh);
    }
    if (isG7) {
      for (const hf of HIGH_FREQ_HANDLES) {
        if (!thisGroupHandles.has(hf)) reject('NEWS_CONFIG_GROUPS_INVALID', `G7 缺少高频账号: ${hf}`);
      }
    }
  }
  if (!groupIds.has('g7')) reject('NEWS_CONFIG_GROUPS_INVALID', 'account_groups 必须包含 g7 组');
  const accSet = new Set();
  for (const h of data.x_accounts) {
    const nh = normHandle(h);
    if (!nh || accSet.has(nh)) reject('NEWS_CONFIG_ACCOUNTS_INVALID', `x_accounts 存在空或重复 handle: ${h}`);
    accSet.add(nh);
  }
  if (allGroupHandles.size !== accSet.size || [...allGroupHandles].some(h => !accSet.has(h))) {
    reject('NEWS_CONFIG_GROUPS_MISMATCH', 'account_groups handles 并集必须与 x_accounts 严格全等');
  }
}

function validateKeywords(kw, reject) {
  if (!kw || typeof kw !== 'object' || Array.isArray(kw)) {
    reject('NEWS_CONFIG_KEYWORDS_INVALID', 'keywords 应为对象');
    return;
  }
  const reqSections = ['content_keywords', 'youtube_queries', 'x_discovery_queries', 'excluded_content_keywords', 'excluded_youtube_queries', 'excluded_x_discovery_queries'];
  for (const s of reqSections) {
    if (!Array.isArray(kw[s])) { reject('NEWS_CONFIG_KEYWORDS_INVALID', `keywords.${s} 必须为数组`); return; }
  }
  const checkList = (arr, name, allowEmpty = false) => {
    if (!allowEmpty && arr.length === 0) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${name} 不能为空`);
    const set = new Set();
    for (const item of arr) {
      if (typeof item !== 'string' || !item.trim()) { reject('NEWS_CONFIG_KEYWORDS_INVALID', `${name} 元素必须为非空字符串`); continue; }
      const n = normStr(item);
      if (set.has(n)) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${name} 存在重复项: ${item}`);
      set.add(n);
    }
    return set;
  };
  const contentSet = checkList(kw.content_keywords, 'content_keywords');
  const ytSet = checkList(kw.youtube_queries, 'youtube_queries');
  const exclContent = checkList(kw.excluded_content_keywords, 'excluded_content_keywords', true);
  const exclYt = checkList(kw.excluded_youtube_queries, 'excluded_youtube_queries', true);
  const exclX = checkList(kw.excluded_x_discovery_queries, 'excluded_x_discovery_queries', true);
  for (const w of exclContent) if (contentSet.has(w)) reject('NEWS_CONFIG_KEYWORDS_OVERLAP', `content_keywords 与排除词重叠: ${w}`);
  for (const w of exclYt) if (ytSet.has(w)) reject('NEWS_CONFIG_KEYWORDS_OVERLAP', `youtube_queries 与排除词重叠: ${w}`);
  if (kw.x_discovery_queries.length === 0) reject('NEWS_CONFIG_KEYWORDS_INVALID', 'x_discovery_queries 不能为空');
  const xIds = new Set();
  const timeOpRegex = /\b(?:since_time|until_time|since|until):/i;
  for (let i = 0; i < kw.x_discovery_queries.length; i++) {
    const q = kw.x_discovery_queries[i];
    const tag = `x_discovery_queries[${i}]`;
    if (!q || typeof q !== 'object') { reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag} 应为对象`); continue; }
    if (!q.id || typeof q.id !== 'string' || xIds.has(q.id)) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag}.id 缺失或重复`);
    xIds.add(q.id);
    if (!q.query || typeof q.query !== 'string') reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag}.query 必须为非空字符串`);
    else {
      if (q.query.length > 768) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag}.query 超过 768 字符`);
      if (timeOpRegex.test(q.query)) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag}.query 禁止包含动态时间操作符`);
    }
    if (q.max_pages !== 1) reject('NEWS_CONFIG_KEYWORDS_INVALID', `${tag}.max_pages 首期必须为 1`);
    if (exclX.has(normStr(q.id)) || exclX.has(normStr(q.query))) {
      reject('NEWS_CONFIG_KEYWORDS_OVERLAP', `${tag} 与 excluded_x_discovery_queries 重叠`);
    }
  }
}

function validateNewsConfig(data, onError = fail) {
  let valid = true;
  const reject = (code, message) => { valid = false; onError(`[${code}] ${message}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    reject('NEWS_CONFIG_TYPE_INVALID', 'news-config-v2.json 顶层应为对象');
    return false;
  }
  validateNewsConfigCore(data, reject);
  validateAccountGroups(data, reject);
  validateKeywords(data.keywords, reject);
  return valid;
}

function validateLastRun(data, onError = fail) {
  let valid = true;
  const reject = (code, message) => { valid = false; onError(`[${code}] ${message}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    reject('LAST_RUN_TYPE_INVALID', 'last-run.json 顶层应为对象');
    return false;
  }
  const x = data.collectors?.x;
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    reject('LAST_RUN_SECTION_INVALID', 'last-run.json.collectors.x 应为对象');
    return false;
  }
  const credits = x.credits;
  if (credits == null) {
    if (x.status === 'success' || x.status === 'partial') {
      reject('LAST_RUN_CREDITS_REQUIRED', 'last-run.json.collectors.x.credits 在 X 已运行时不得为空');
    }
    return valid;
  }
  if (typeof credits !== 'object' || Array.isArray(credits)) {
    reject('LAST_RUN_CREDITS_TYPE_INVALID', 'last-run.json.collectors.x.credits 应为对象或 null');
    return false;
  }
  for (const f of ['used', 'budget', 'tweets', 'articles']) {
    if (!isNonNegInt(credits[f])) reject('LAST_RUN_CREDITS_FIELD_INVALID', `credits.${f} 应为非负整数`);
  }
  if (isNonNegInt(credits.budget) && credits.budget > X_CREDITS_MAX_BUDGET) {
    reject('LAST_RUN_BUDGET_OVERFLOW', `credits.budget 不得超过 ${X_CREDITS_MAX_BUDGET}`);
  }
  if (isNonNegInt(credits.used) && isNonNegInt(credits.budget) && credits.used > credits.budget) {
    reject('LAST_RUN_CREDITS_OVER_BUDGET', 'credits.used 不得超过 budget');
  }
  const requests = credits.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
    reject('LAST_RUN_REQUESTS_TYPE_INVALID', 'credits.requests 应为对象');
    return false;
  }
  for (const f of ['total', 'tweet', 'article', 'retries']) {
    if (!isNonNegInt(requests[f])) reject('LAST_RUN_REQUESTS_FIELD_INVALID', `credits.requests.${f} 应为非负整数`);
  }
  if (isNonNegInt(requests.total) && isNonNegInt(requests.tweet)
    && isNonNegInt(requests.article) && requests.total !== requests.tweet + requests.article) {
    reject('LAST_RUN_REQUESTS_INCONSISTENT', 'credits.requests.total 应等于 tweet + article');
  }
  if (isNonNegInt(requests.retries) && isNonNegInt(requests.total) && requests.retries > requests.total) {
    reject('LAST_RUN_RETRIES_OVERFLOW', 'credits.requests.retries 不得超过 total');
  }
  return valid;
}

function validateHotspots(data) {
  if (!data || !Array.isArray(data.items)) {
    fail('hotspots.json.items 应为数组');
    return;
  }
  const contentIds = new Set();
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const tag = `hotspots.json.items[${i}] (${item.title || '未知'})`;
    checkRequired(item, tag, ['id', 'platform', 'native_id', 'source_type', 'url', 'title', 'published_at', 'source_id', 'metrics']);
    if (contentIds.has(item.id)) fail(`${tag}.id 重复: ${item.id}`);
    contentIds.add(item.id);
    if (!NEWS_PLATFORMS.includes(item.platform)) fail(`${tag}.platform 不支持: ${item.platform}`);
    if (!SOURCE_TYPES.includes(item.source_type)) fail(`${tag}.source_type 不支持: ${item.source_type}`);
    if (item.content_type !== undefined && !CONTENT_TYPES.includes(item.content_type)) fail(`${tag}.content_type 不支持: ${item.content_type}`);
    if (Number.isNaN(new Date(item.published_at).getTime())) fail(`${tag}.published_at 不是有效日期`);
    if (item.metrics && typeof item.metrics !== 'object') fail(`${tag}.metrics 应为对象`);
    if (item.hot_score !== undefined && item.hot_score !== null && !(typeof item.hot_score === 'number' && item.hot_score >= 0 && item.hot_score <= 100)) {
      fail(`${tag}.hot_score 应为 0–100 数值或 null`);
    }
    if (item.evidence_excerpt !== undefined && item.evidence_excerpt !== null && typeof item.evidence_excerpt !== 'string') {
      fail(`${tag}.evidence_excerpt 应为字符串或 null`);
    }
    if (item.summary !== undefined && item.summary !== null && typeof item.summary !== 'string') {
      fail(`${tag}.summary 应为字符串或 null`);
    }
    if (item.summary_key_points !== undefined) {
      if (!Array.isArray(item.summary_key_points)) fail(`${tag}.summary_key_points 应为数组`);
      else item.summary_key_points.forEach(p => { if (typeof p !== 'string') fail(`${tag}.summary_key_points 元素应为字符串`); });
    }
    if (item.related_resources !== undefined) {
      if (!Array.isArray(item.related_resources)) fail(`${tag}.related_resources 应为数组`);
      else item.related_resources.forEach((r, ri) => {
        if (!r || typeof r !== 'object') { fail(`${tag}.related_resources[${ri}] 应为对象`); return; }
        if (!['tool', 'concept', 'scene'].includes(r.type)) fail(`${tag}.related_resources[${ri}].type 应为 tool/concept/scene`);
        if (!r.id || typeof r.id !== 'string') fail(`${tag}.related_resources[${ri}].id 应为非空字符串`);
      });
    }
    if (item.localizations !== undefined) {
      if (!item.localizations || typeof item.localizations !== 'object') fail(`${tag}.localizations 应为对象`);
      else for (const [loc, lz] of Object.entries(item.localizations)) {
        if (!lz || typeof lz !== 'object') { fail(`${tag}.localizations.${loc} 应为对象`); continue; }
        if (lz.title !== undefined && typeof lz.title !== 'string') fail(`${tag}.localizations.${loc}.title 应为字符串`);
        if (lz.description !== undefined && typeof lz.description !== 'string') fail(`${tag}.localizations.${loc}.description 应为字符串`);
      }
    }
    if (item.localizations_meta !== undefined) fail(`${tag}.localizations_meta 是内部字段，不应出现在公开投影`);
  }
  if (data.heat_definition !== undefined && typeof data.heat_definition !== 'string') fail('hotspots.json.heat_definition 应为字符串');
  if (!data.coverage || typeof data.coverage !== 'object') fail('hotspots.json.coverage 缺失');
  console.log(`  hotspots.json: ${data.items.length} 条内容，通过`);
}

function validateMinNews() {
  const file = NEWS_FILES.minCandidates;
  const errors = [];
  const warnings = [];
  const reportErr = msg => { errors.push(msg); fail(msg); };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('  min-candidates.json: 文件不存在（v2 管线未首跑），优雅跳过');
      return { valid: true, errors, warnings };
    }
    reportErr(`min-candidates.json 解析失败：${error.message}`);
    return { valid: false, errors, warnings };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    reportErr('min-candidates.json 顶层应为对象');
    return { valid: false, errors, warnings };
  }
  if (data.schema_version !== undefined && (!Number.isInteger(data.schema_version) || data.schema_version < 1)) {
    reportErr('min-candidates.json.schema_version 应为正整数');
  } else if (data.schema_version === undefined) {
    warnings.push('min-candidates.json 缺少 schema_version（缺省按 1 处理）');
    console.warn('⚠️  min-candidates.json 缺少 schema_version（缺省按 1 处理）');
  }
  if (!Array.isArray(data.candidates)) {
    reportErr('min-candidates.json.candidates 应为数组');
    return { valid: false, errors, warnings };
  }
  const ids = new Set();
  for (let i = 0; i < data.candidates.length; i++) {
    const c = data.candidates[i];
    const tag = `min-candidates.json.candidates[${i}] (${(c && c.title) || '未知'})`;
    if (!c || typeof c !== 'object') { reportErr(`${tag} 应为对象`); continue; }
    if (!c.id || ids.has(c.id)) reportErr(`${tag}.id 缺失或重复: ${c.id}`);
    ids.add(c.id);
    if (!MIN_REVIEW_STATUSES.includes(c.review_status)) reportErr(`${tag}.review_status 无效（合法值：${MIN_REVIEW_STATUSES.join(' / ')}）`);
    if (!NEWS_PLATFORMS.includes(c.platform)) reportErr(`${tag}.platform 不支持: ${c.platform}`);
    if (c.review_status === 'approved') {
      for (const field of ['title', 'url', 'published_at']) {
        if (c[field] === undefined || c[field] === null || c[field] === '') {
          const message = `${tag} 已 approved 但缺少公开字段 ${field}`;
          warnings.push(message);
          console.warn(`⚠️  ${message}`);
        }
      }
    }
  }
  if (errors.length === 0) console.log(`  min-candidates.json: ${data.candidates.length} 条候选（v2 单状态轴），通过`);
  return { valid: errors.length === 0, errors, warnings };
}

function validateNews() {
  try {
    validateNewsConfig(JSON.parse(fs.readFileSync(NEWS_FILES.configV2, 'utf8')));
  } catch (error) {
    fail(`news-config-v2.json 解析失败：${error.message}`);
  }
  try {
    validateLastRun(JSON.parse(fs.readFileSync(NEWS_FILES.lastRun, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('  last-run.json: 文件不存在（尚无采集运行记录），优雅跳过');
    } else {
      fail(`last-run.json 解析失败：${error.message}`);
    }
  }
  try {
    validateHotspots(JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8')));
  } catch (e) {
    fail(`hotspots.json 解析失败：${e.message}`);
  }
}

module.exports = {
  validateNews,
  validateMinNews,
  validateNewsConfig,
  validateLastRun,
  X_CREDITS_MAX_PER_HOT_RUN,
  X_CREDITS_MAX_PER_COLD_RUN,
  X_CREDITS_MAX_BUDGET,
  get failed() { return failed; },
};
