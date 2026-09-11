/**
 * collector-x-normalize.test.js —— X 推文归一化与五态互动类型、Article 正文离线测试
 *
 * 运行：node --test tests/news/collector-x-normalize.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  determineInteractionType,
  normalizeXV2Tweet,
  extractArticleText,
  hasArticleSignal,
  extractHandleFromUrl,
} = require('../../src/news/collectors/collector-x-normalize');

test('determineInteractionType: 原创帖判定为 original', () => {
  const tweet = {
    id: '1001',
    text: 'Announcing our newest flagship AI model today.',
    created_at: '2026-09-10T02:00:00.000Z',
  };
  assert.equal(determineInteractionType(tweet), 'original');
});

test('determineInteractionType: 普通回复判定为 reply', () => {
  // isReply 标志
  assert.equal(determineInteractionType({
    id: '1002',
    text: 'Yes, this is available now.',
    isReply: true,
    created_at: '2026-09-10T02:00:00.000Z',
  }), 'reply');

  // inReplyToId
  assert.equal(determineInteractionType({
    id: '1003',
    text: 'Replying to someone',
    inReplyToId: '9999',
    created_at: '2026-09-10T02:00:00.000Z',
  }), 'reply');

  // in_reply_to_status_id
  assert.equal(determineInteractionType({
    id: '1004',
    text: 'Replying',
    in_reply_to_status_id: '8888',
    created_at: '2026-09-10T02:00:00.000Z',
  }), 'reply');
});

test('determineInteractionType: 原生转推判定为 repost', () => {
  const tweet = {
    id: '1005',
    text: 'RT @OpenAI: Announcing GPT-5',
    retweeted_tweet: { id: '9001', text: 'Announcing GPT-5' },
    created_at: '2026-09-10T02:00:00.000Z',
  };
  assert.equal(determineInteractionType(tweet), 'repost');
});

test('determineInteractionType: 引用帖判定为 quote，且不误判为 repost', () => {
  const tweet = {
    id: '1006',
    text: 'Here is my commentary on this major release:',
    quoted_tweet: { id: '9002', text: 'Base announcement' },
    created_at: '2026-09-10T02:00:00.000Z',
  };
  // 引用帖绝不能被误判为 repost！
  assert.equal(determineInteractionType(tweet), 'quote');
  assert.notEqual(determineInteractionType(tweet), 'repost');

  // 支持 quotedStatus
  assert.equal(determineInteractionType({
    id: '1007',
    text: 'Check this out',
    quotedStatus: { id: '9003' },
    created_at: '2026-09-10T02:00:00.000Z',
  }), 'quote');
});

test('determineInteractionType: 优先级保证 reply > repost > quote', () => {
  // 同时具备 reply 与 quote 信号时，以 reply 优先
  const replyAndQuote = {
    id: '1008',
    text: 'Reply quoting someone',
    isReply: true,
    quoted_tweet: { id: '9004' },
    created_at: '2026-09-10T02:00:00.000Z',
  };
  assert.equal(determineInteractionType(replyAndQuote), 'reply');
});

test('determineInteractionType: 结构异常与缺失判定为 unknown', () => {
  assert.equal(determineInteractionType(null), 'unknown');
  assert.equal(determineInteractionType('not an object'), 'unknown');
  assert.equal(determineInteractionType({}), 'unknown');
  assert.equal(determineInteractionType({ foo: 'bar' }), 'unknown');
});

test('normalizeXV2Tweet: 输出模型中增加 interaction_type 字段', () => {
  const tweet = {
    id: '2001',
    text: 'Exciting AI research release https://x.com/test/status/2001',
    created_at: '2026-09-10T04:00:00.000Z',
    author: { username: 'OpenAI', name: 'OpenAI' },
    quoted_tweet: { id: '1000' },
  };

  const item = normalizeXV2Tweet(tweet, null, '2026-09-10T04:05:00.000Z');
  assert.ok(item);
  assert.equal(item.native_id, '2001');
  assert.equal(item.interaction_type, 'quote');
  assert.equal(item.author_name, 'OpenAI');
  assert.equal(item.platform, 'x');
});

test('extractArticleText: 优先读取 article.contents 并兼容 article.content', () => {
  // 1. 优先读取 article.contents（TwitterAPI.io 官方字段）
  const officialPayload = {
    data: {
      article: {
        title: 'Deep Dive into Reasoning',
        subtitle: 'A technical overview',
        contents: 'This is the full text from official contents field.',
      },
    },
  };
  const text1 = extractArticleText(officialPayload);
  assert.match(text1, /Deep Dive into Reasoning/);
  assert.match(text1, /A technical overview/);
  assert.match(text1, /This is the full text from official contents field/);

  // 2. 兼容旧的 article.content 字段
  const legacyPayload = {
    article: {
      title: 'Legacy Article',
      content: 'This is content from legacy field.',
    },
  };
  const text2 = extractArticleText(legacyPayload);
  assert.match(text2, /Legacy Article/);
  assert.match(text2, /This is content from legacy field/);

  // 3. contents 优先于 content
  const mixedPayload = {
    article: {
      title: 'Mixed Article',
      contents: 'Official contents wins',
      content: 'Legacy content ignored',
    },
  };
  const text3 = extractArticleText(mixedPayload);
  assert.match(text3, /Official contents wins/);
  assert.doesNotMatch(text3, /Legacy content ignored/);
});

test('extractArticleText: 支持 blocks 数组（content 与 text 块属性）', () => {
  const blockPayload = {
    article: {
      title: 'Block Article',
      contents: [
        { content: 'First block paragraph.' },
        { text: 'Second block paragraph with text property.' },
        'Raw string block paragraph.',
      ],
    },
  };
  const text = extractArticleText(blockPayload);
  assert.match(text, /First block paragraph/);
  assert.match(text, /Second block paragraph with text property/);
  assert.match(text, /Raw string block paragraph/);
});

test('extractArticleText: 无正文或空结构返回 null', () => {
  assert.equal(extractArticleText(null), null);
  assert.equal(extractArticleText({}), null);
  assert.equal(extractArticleText({ article: null }), null);
  assert.equal(extractArticleText({ article: { title: '', content: '' } }), null);
});

test('normalizeXV2Tweet: 非法或脏日期返回 null 防御崩溃', () => {
  const tweetInvalidDate = {
    id: '2002',
    text: 'Valid text content',
    created_at: 'invalid-date',
  };
  assert.equal(normalizeXV2Tweet(tweetInvalidDate, null, '2026-09-10T04:05:00.000Z'), null);

  const tweetEmptyDate = {
    id: '2003',
    text: 'Valid text content',
    created_at: '',
  };
  assert.equal(normalizeXV2Tweet(tweetEmptyDate, null, '2026-09-10T04:05:00.000Z'), null);
});
