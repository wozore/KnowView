/**
 * collector-x-v2.test.js —— X Advanced Search 统一采集门面集成测试
 *
 * 全部通过 fetchImpl 注入模拟 TwitterAPI.io，不发真实网络请求。
 * 运行：node --test tests/news/collector-x-v2.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { collectXV2 } = require('../../src/news/collectors/collector-x-v2');
const { NEWS_FILES } = require('../../src/shared/paths');

const NOW = '2026-09-10T02:00:00.000Z'; // 北京时间 2026-09-10 10:00

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

test('collectXV2: 请求 /twitter/tweet/advanced_search 端点并核对标准参数与请求头', async () => {
  const requestedUrls = [];
  const requestedHeaders = [];

  const fetchImpl = async (url, init) => {
    requestedUrls.push(new URL(url));
    requestedHeaders.push(init?.headers || {});
    return response({
      tweets: [
        {
          id: '1001',
          text: 'Announcing our new flagship LLM model https://x.com/OpenAI/status/1001',
          createdAt: '2026-09-09T22:00:00.000Z',
          author: { username: 'OpenAI', name: 'OpenAI' },
        },
      ],
      has_next_page: false,
      next_cursor: null,
    });
  };

  const accountGroups = [
    { id: 'g1', label: '头部模型', handles: ['OpenAI', 'AnthropicAI'], priority: 1, max_pages: 1 },
  ];

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: accountGroups,
    xApiKey: 'test-api-key-123',
    fetchImpl,
    now: NOW,
    run_id: 'test-run-1',
  });

  assert.equal(requestedUrls.length, 1);
  const reqUrl = requestedUrls[0];
  assert.equal(reqUrl.pathname, '/twitter/tweet/advanced_search');
  assert.equal(reqUrl.searchParams.get('queryType'), 'Latest');

  const query = reqUrl.searchParams.get('query');
  assert.ok(query.includes('from:OpenAI OR from:AnthropicAI'), '包含账号组 Handle OR 连接');
  assert.ok(query.includes('since_time:'), '包含 since_time 约束');
  assert.ok(query.includes('until_time:'), '包含 until_time 约束');
  assert.equal(requestedHeaders[0]['X-API-Key'], 'test-api-key-123');

  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.native_id, '1001');
  assert.equal(item.platform, 'x');
  assert.equal(item.interaction_type, 'original');
  assert.deepEqual(item.collection_context, {
    window_id: result.window.window_id,
    half: 'hot',
    query_kind: 'account_group',
    query_id: 'g1',
    first_seen_run_id: 'test-run-1',
    last_seen_run_id: 'test-run-1',
  });
});

test('collectXV2: 请求 /twitter/article 严格使用 tweet_id 参数补读正文', async () => {
  const requestedUrls = [];

  const fetchImpl = async url => {
    const parsed = new URL(url);
    requestedUrls.push(parsed);
    if (parsed.pathname === '/twitter/tweet/advanced_search') {
      return response({
        tweets: [
          {
            id: 'article_post_999',
            text: 'Deep dive into architecture https://x.com/i/articles/article_post_999',
            createdAt: '2026-09-09T23:00:00.000Z',
            author: { username: 'OpenAI', name: 'OpenAI' },
            article_id: 'article_999',
          },
        ],
        has_next_page: false,
        next_cursor: null,
      });
    }
    if (parsed.pathname === '/twitter/article') {
      return response({
        data: {
          article: {
            title: 'Model Architecture Deep Dive',
            contents: 'This is the comprehensive deep dive article content that should be appended.',
          },
        },
      });
    }
    throw new Error(`Unexpected endpoint: ${parsed.pathname}`);
  };

  const accountGroups = [
    { id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 },
  ];

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: accountGroups,
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
    run_id: 'test-article-run',
  });

  assert.equal(requestedUrls.length, 2);
  const articleReq = requestedUrls.find(u => u.pathname === '/twitter/article');
  assert.ok(articleReq, '调用了 /twitter/article 端点');
  assert.equal(articleReq.searchParams.get('tweet_id'), 'article_post_999', '严格使用 tweet_id 作为参数名');
  assert.equal(articleReq.searchParams.get('tweetId'), null, '严禁使用已被弃用的 tweetId');

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.ok(item.description.includes('Model Architecture Deep Dive'));
  assert.ok(item.description.includes('comprehensive deep dive article content'));

  // 验证 Article 请求消耗的是 article_retry 独立预算桶（100 credits）
  assert.equal(result.credits.buckets.article_retry.settled, 100);
});

test('collectXV2: 互动类型过滤：保留 original 与 quote，排除 reply、repost 与 unknown 并记入 diagnostics', async () => {
  const fetchImpl = async () => {
    return response({
      tweets: [
        // 1. original（保留）
        { id: 't_orig', text: 'Original AI release', createdAt: '2026-09-09T22:00:00.000Z' },
        // 2. quote（保留）
        { id: 't_quote', text: 'Quoting update', quoted_tweet: { id: 'orig' }, createdAt: '2026-09-09T22:01:00.000Z' },
        // 3. reply（排除）
        { id: 't_reply', text: 'Replying to user', isReply: true, createdAt: '2026-09-09T22:02:00.000Z' },
        // 4. repost（排除）
        { id: 't_repost', text: 'RT someone', retweeted_tweet: { id: 'orig2' }, createdAt: '2026-09-09T22:03:00.000Z' },
        // 5. unknown（排除：缺正文与时间）
        { id: 't_unknown' },
      ],
      has_next_page: false,
      next_cursor: null,
    });
  };

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: [{ id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 }],
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });

  assert.equal(result.items.length, 2, '仅 original 和 quote 进入候选');
  const ids = result.items.map(i => i.native_id);
  assert.ok(ids.includes('t_orig'));
  assert.ok(ids.includes('t_quote'));
  assert.equal(ids.includes('t_reply'), false);
  assert.equal(ids.includes('t_repost'), false);

  assert.equal(result.diagnostics.excluded_interaction_counts.reply, 1);
  assert.equal(result.diagnostics.excluded_interaction_counts.repost, 1);
});

test('collectXV2: hot (7500) 与 cold (2500) 预算约束及 credits DTO 自洽', async () => {
  const fetchImpl = async () => response({ tweets: [], has_next_page: false, next_cursor: null });

  // 1. Hot 预算验证
  const hotResult = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: [{ id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 }],
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });
  assert.equal(hotResult.credits.budget, 7500);
  assert.equal(hotResult.credits.buckets.account.cap, 5500);
  assert.equal(hotResult.credits.buckets.discovery.cap, 800);
  assert.equal(hotResult.credits.buckets.article_retry.cap, 750);
  assert.equal(hotResult.credits.buckets.tail_recheck.cap, 450);
  assert.equal(hotResult.credits.used, hotResult.credits.settled + hotResult.credits.reserved + hotResult.credits.unknown_reserved);

  // 2. Cold 预算验证
  const coldResult = await collectXV2({
    slot: 'cold',
    businessDate: '2026-09-10',
    account_groups: [{ id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 }],
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });
  assert.equal(coldResult.credits.budget, 2500);
  assert.equal(coldResult.credits.buckets.account.cap, 1300);
  assert.equal(coldResult.credits.buckets.discovery.cap, 300);
  assert.equal(coldResult.credits.buckets.article_retry.cap, 300);
  assert.equal(coldResult.credits.buckets.tail_recheck.cap, 600);
  assert.equal(coldResult.credits.used, coldResult.credits.settled + coldResult.credits.reserved + coldResult.credits.unknown_reserved);
});

test('collectXV2: 轮次公平调度与超量 20 条响应止损', async () => {
  const executionLog = [];

  const fetchImpl = async url => {
    const query = new URL(url).searchParams.get('query');
    const groupName = query.includes('OpenAI') ? 'g1' : 'g2';
    const cursor = new URL(url).searchParams.get('cursor');
    const round = cursor ? 2 : 1;
    executionLog.push(`${groupName}:round_${round}`);

    if (groupName === 'g1' && round === 1) {
      // g1 第一页返回超量 25 条推文
      const overflowTweets = Array.from({ length: 25 }, (_, i) => ({
        id: `g1_overflow_${i}`,
        text: `AI overflow tweet ${i}`,
        createdAt: '2026-09-09T21:00:00.000Z',
      }));
      return response({ tweets: overflowTweets, has_next_page: true, next_cursor: 'cursor_g1_p2' });
    }

    return response({
      tweets: [{ id: `${groupName}_t1`, text: 'normal tweet', createdAt: '2026-09-09T21:00:00.000Z' }],
      has_next_page: false,
      next_cursor: null,
    });
  };

  const accountGroups = [
    { id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 2 },
    { id: 'g2', handles: ['AnthropicAI'], priority: 2, max_pages: 2 },
  ];

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: accountGroups,
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });

  // g1 第一页超量后被止损，未进入 round 2；g2 照常执行
  assert.deepEqual(executionLog, ['g1:round_1', 'g2:round_1']);
  assert.equal(result.credits.overage, 5, '超量 5 条记录入 overage');
  const g1Outcome = result.account_groups.find(o => o.group_id === 'g1');
  assert.equal(g1Outcome.status, 'partial');
  assert.equal(g1Outcome.reason, 'NEWS_OVERAGE_STOP');
});

test('collectXV2: 零直接写盘（纯采集 facade，不直接写任何 runtime 或 output 文件）', async () => {
  const getFileState = file => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };

  const watchedFiles = [
    NEWS_FILES.minCandidates,
    NEWS_FILES.sourceHistory,
    NEWS_FILES.xCheckpoints,
    NEWS_FILES.lastRun,
    NEWS_FILES.hotspots,
  ];

  const beforeMtimes = watchedFiles.map(getFileState);

  const fetchImpl = async () => response({
    tweets: [{ id: 'write_check_t1', text: 'test write isolation', createdAt: '2026-09-09T22:00:00.000Z' }],
    has_next_page: false,
    next_cursor: null,
  });

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: [{ id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 }],
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 1);

  const afterMtimes = watchedFiles.map(getFileState);
  assert.deepEqual(beforeMtimes, afterMtimes, 'collectXV2 运行期间绝未触碰任何磁盘文件');
});

test('collectXV2: 尾部重查与 Discovery 关键词查询端到端组装', async () => {
  const requestedQueries = [];

  const fetchImpl = async url => {
    const q = new URL(url).searchParams.get('query');
    requestedQueries.push(q);
    return response({
      tweets: [
        { id: `t_${requestedQueries.length}`, text: `Tweet for ${q}`, createdAt: '2026-09-09T19:30:00.000Z' },
      ],
      has_next_page: false,
      next_cursor: null,
    });
  };

  const accountGroups = [
    { id: 'g1', handles: ['OpenAI'], priority: 1, max_pages: 1 },
  ];
  const discoveryQueries = [
    { id: 'release-events', query: '(AI OR LLM) launch', max_pages: 1 },
  ];

  const result = await collectXV2({
    slot: 'hot',
    businessDate: '2026-09-10',
    account_groups: accountGroups,
    discovery_queries: discoveryQueries,
    tail_recheck: { enabled: true },
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.account_groups.length, 1);
  assert.equal(result.discovery_queries.length, 1);
  assert.ok(result.checkpoint_patches.length >= 2, '包含 account_group 与 discovery 的 checkpoint 记录');

  // 尾部重查观察记录应在 patches 中
  const tailObs = result.checkpoint_patches.find(p => p.recovered_new_count !== undefined);
  assert.ok(tailObs, '产生 tail_recheck_observations 记录');
  assert.equal(tailObs.group_id, 'g1');
  assert.equal(tailObs.half, 'hot');
});
