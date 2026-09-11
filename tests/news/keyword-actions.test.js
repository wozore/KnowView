'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  revisionOfConfig,
  applyKeywordExclusions,
  commitKeywordExclusions,
  applyRefineKeywords,
} = require('../../src/news/min/keyword-actions');

function tmpConfig(overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-actions-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    keywords: {
      content_keywords: [],
      youtube_queries: [],
      x_discovery_queries: [],
      excluded_content_keywords: [],
      excluded_youtube_queries: [],
      excluded_x_discovery_queries: [],
      ...(overrides.keywords || {}),
    },
    ...(overrides.rest || {}),
  }));
  return file;
}

test('applyKeywordExclusions 幂等追加丢弃词并大小写不敏感去重', () => {
  const config = { keywords: { content_keywords: ['ai'], excluded_content_keywords: ['gpt'] } };
  const revision = revisionOfConfig(config);
  const result = applyKeywordExclusions(config, ['google', 'GOOGLE', 'yolo'], { purpose: 'content', expectedRevision: revision });
  assert.equal(result.added.length, 2);
  assert.deepEqual(result.config.keywords.excluded_content_keywords, ['gpt', 'google', 'yolo']);
  assert.equal(result.changed, true);
  // 已存在的丢弃词不再重复
  const second = applyKeywordExclusions(result.config, ['google'], { purpose: 'content', expectedRevision: result.revision });
  assert.equal(second.added.length, 0);
  assert.equal(second.changed, false);
});

test('applyKeywordExclusions 校验 expected revision 与非空字符串', () => {
  const config = { keywords: {} };
  assert.throws(() => applyKeywordExclusions(config, ['x'], {}), /expected revision/);
  assert.throws(() => applyKeywordExclusions(config, [123], { expectedRevision: revisionOfConfig(config) }), /非空字符串/);
  assert.throws(() => applyKeywordExclusions(config, [''], { expectedRevision: revisionOfConfig(config) }), /非空字符串/);
});

test('commitKeywordExclusions 带 revision 门禁原子写回且无变化不写', () => {
  const file = tmpConfig();
  const revision = revisionOfConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const written = commitKeywordExclusions(['google'], { configPath: file, expectedRevision: revision, runId: 'test-kw-exclude' });
  assert.equal(written.written, true);
  assert.equal(written.added.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keywords.excluded_content_keywords, ['google']);
  // 重复丢弃：无新增，不写盘
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const noop = commitKeywordExclusions(['google'], { configPath: file, expectedRevision: revisionOfConfig(current) });
  assert.equal(noop.written, false);
  // 陈旧 revision 拒绝写
  assert.throws(() => commitKeywordExclusions(['yolo'], { configPath: file, expectedRevision: 'stale' }), /revision 冲突/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('refine 采纳按 purpose 写入对应配置段', () => {
  // 1. content
  const config = {
    keywords: {
      content_keywords: ['ai'],
      youtube_queries: ['Sora'],
      x_discovery_queries: [],
      excluded_content_keywords: ['google'],
    },
  };
  const contentList = {
    kind: 'keyword_refine_candidates',
    purpose: 'content',
    candidates: [
      { candidate_id: 'content:google', value: 'google' },
      { candidate_id: 'content:yolo', value: 'yolo' },
    ],
    adopted_candidate_ids: ['content:yolo'],
  };
  const resContent = applyRefineKeywords(config, contentList);
  assert.deepEqual(resContent.config.keywords.content_keywords, ['ai', 'yolo']);
  assert.deepEqual(resContent.config.keywords.excluded_content_keywords, ['google']);

  // 2. youtube
  const ytList = {
    kind: 'keyword_refine_candidates',
    purpose: 'youtube',
    candidates: [
      { candidate_id: 'youtube:Claude 3.7', value: 'Claude 3.7' },
    ],
    adopted_candidate_ids: ['youtube:Claude 3.7'],
  };
  const resYt = applyRefineKeywords(resContent.config, ytList);
  assert.deepEqual(resYt.config.keywords.youtube_queries, ['Sora', 'Claude 3.7']);

  // 3. x_discovery
  const xList = {
    kind: 'keyword_refine_candidates',
    purpose: 'x_discovery',
    candidates: [
      { candidate_id: 'x_discovery:agent-event', value: { id: 'agent-event', query: '(agent) launch', max_pages: 1 } },
    ],
    adopted_candidate_ids: ['x_discovery:agent-event'],
  };
  const resX = applyRefineKeywords(resYt.config, xList);
  assert.deepEqual(resX.config.keywords.x_discovery_queries, [
    { id: 'agent-event', query: '(agent) launch', max_pages: 1 },
  ]);
});
