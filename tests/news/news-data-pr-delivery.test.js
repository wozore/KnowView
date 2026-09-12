'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  findOpenDataPr,
  verifyHeadNotDrifted,
  deliverNewsDataPr,
} = require('../../src/news/delivery');

test('verifyAllowedFilesOnly: 仅允许 6 个运行时数据文件', () => {
  assert.equal(verifyAllowedFilesOnly(DATA_PR_ALLOWED_FILES), true);
  assert.throws(
    () => verifyAllowedFilesOnly(['data/news/config/news-config-v2.json']),
    /NEWS_DELIVERY_FORBIDDEN_FILE/
  );
  assert.throws(
    () => verifyAllowedFilesOnly(['src/news/min/pipeline-min.js']),
    /NEWS_DELIVERY_FORBIDDEN_FILE/
  );
  assert.throws(() => verifyAllowedFilesOnly([]), /NEWS_DELIVERY_NO_FILES/);
  assert.throws(() => verifyAllowedFilesOnly(['data/news/runtime/min-candidates.json', 'data/news/runtime/min-candidates.json']), /NEWS_DELIVERY_DUPLICATE_FILE/);
  assert.throws(() => verifyAllowedFilesOnly([null]), /NEWS_DELIVERY_INVALID_FILE/);
});

test('validateDataPrFiles：六类交付文件结构非法时 fail-closed', () => {
  const valid = {
    'data/news/runtime/min-candidates.json': { schema_version: 1, candidates: [] },
    'data/news/runtime/source-history.json': { schema_version: 1, sources: {} },
    'data/manual/review.json': { schema_version: 1, kind: 'review_candidates', candidates: [] },
    'data/news/runtime/last-run.json': { schema_version: 1, platforms: [], collectors: { x: {} } },
    'data/news/runtime/schedule-state.json': { schema_version: 1, youtube_last_collected_at: '2026-09-11T00:00:00.000Z' },
    'data/news/runtime/x-checkpoints.json': { schema_version: 1, checkpoints: {}, tail_recheck_observations: [] },
  };
  assert.equal(validateDataPrFiles(Object.keys(valid), file => JSON.stringify(valid[file])), true);
  assert.throws(
    () => validateDataPrFiles(['data/news/runtime/min-candidates.json'], () => JSON.stringify({ schema_version: 1, candidates: [{ id: 'x', platform: 'x' }] })),
    /NEWS_DELIVERY_SCHEMA_INVALID/
  );
  assert.throws(
    () => validateDataPrFiles(['data/news/runtime/x-checkpoints.json'], () => JSON.stringify({ schema_version: 1, checkpoints: [] })),
    /NEWS_DELIVERY_SCHEMA_INVALID/
  );
});

test('findOpenDataPr: 零开放 PR 返回 null，单个复用，多个 fail-closed 阻断', async () => {
  const ghNone = { listOpenPrs: async () => [] };
  assert.equal(await findOpenDataPr(ghNone), null);

  const ghSingle = {
    listOpenPrs: async () => [
      { number: 42, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-1', headRefOid: 'sha-123' },
    ],
  };
  const single = await findOpenDataPr(ghSingle);
  assert.deepEqual(single, {
    prNumber: 42,
    branch: 'news/review/batch-1',
    headSha: 'sha-123',
    state: 'open',
    baseRefName: 'main',
    title: '',
  });

  const ghMulti = {
    listOpenPrs: async () => [
      { number: 42, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-1', headRefOid: 'sha-123' },
      { number: 43, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-2', headRefOid: 'sha-456' },
    ],
  };
  await assert.rejects(
    async () => findOpenDataPr(ghMulti),
    err => err.code === 'NEWS_DELIVERY_MULTIPLE_PRS'
  );
});

test('verifyHeadNotDrifted: 相同 SHA 通过，SHA 变化或分支丢失时阻断', async () => {
  const ghMatch = { getBranchHeadSha: async () => 'sha-123' };
  assert.equal(await verifyHeadNotDrifted(ghMatch, 'news/review/b1', 'sha-123'), true);

  const ghDrift = { getBranchHeadSha: async () => 'sha-drifted' };
  await assert.rejects(
    async () => verifyHeadNotDrifted(ghDrift, 'news/review/b1', 'sha-123'),
    err => err.code === 'NEWS_DELIVERY_HEAD_DRIFT'
  );

  const ghDeleted = { getBranchHeadSha: async () => null };
  await assert.rejects(
    async () => verifyHeadNotDrifted(ghDeleted, 'news/review/b1', 'sha-123'),
    err => err.code === 'NEWS_DELIVERY_BRANCH_NOT_FOUND'
  );
});

test('deliverNewsDataPr: 0 个开放 PR 时新建分支并提 PR', async () => {
  const actions = [];
  const ghClient = {
    listOpenPrs: async () => [],
    createPr: async payload => {
      actions.push({ type: 'createPr', ...payload });
      return { prNumber: 101 };
    },
  };
  const gitClient = {
    createAndCheckoutBranch: async b => actions.push({ type: 'createBranch', b }),
    stageFiles: async f => actions.push({ type: 'stage', f }),
    commit: async m => actions.push({ type: 'commit', m }),
    pushNormal: async b => actions.push({ type: 'push', b }),
  };

  const res = await deliverNewsDataPr({
    ghClient,
    gitClient,
    batch: 'batch-test-1',
    changedFiles: ['data/news/runtime/min-candidates.json', 'data/news/runtime/source-history.json'],
  });

  assert.equal(res.action, 'created');
  assert.equal(res.prNumber, 101);
  assert.equal(actions.some(a => a.type === 'createPr'), true);
  assert.equal(actions.find(a => a.type === 'createPr').base, 'main');
  assert.equal(actions.some(a => a.type === 'push' && a.b === 'news/review/batch-test-1'), true);
});

test('deliverNewsDataPr: 存在 1 个开放 PR 时通过 CAS 更新同一个 PR', async () => {
  const actions = [];
  const ghClient = {
    listOpenPrs: async () => [{ number: 99, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-open', headRefOid: 'head-aaa' }],
    getBranchHeadSha: async () => 'head-aaa',
  };
  const gitClient = {
    checkoutBranch: async b => actions.push({ type: 'checkout', b }),
    stageFiles: async f => actions.push({ type: 'stage', f }),
    commit: async m => actions.push({ type: 'commit', m }),
    pushNormal: async b => actions.push({ type: 'push', b }),
  };

  const res = await deliverNewsDataPr({
    ghClient,
    gitClient,
    batch: 'batch-test-2',
    changedFiles: ['data/news/runtime/min-candidates.json'],
  });

  assert.equal(res.action, 'updated');
  assert.equal(res.prNumber, 99);
  assert.equal(actions.some(a => a.type === 'checkout' && a.b === 'news/review/batch-open'), true);
  assert.equal(actions.some(a => a.type === 'push' && a.b === 'news/review/batch-open'), true);
});

test('findOpenDataPr：closed、非 main 或缺 SHA 的 PR fail-closed', async () => {
  await assert.rejects(
    () => findOpenDataPr({ listOpenPrs: async () => [{ number: 1, state: 'closed', baseRefName: 'main', headRefName: 'news/review/a', headRefOid: 'sha' }] }),
    err => err.code === 'NEWS_DELIVERY_PR_NOT_OPEN'
  );
  await assert.rejects(
    () => findOpenDataPr({ listOpenPrs: async () => [{ number: 1, state: 'open', baseRefName: 'develop', headRefName: 'news/review/a', headRefOid: 'sha' }] }),
    err => err.code === 'NEWS_DELIVERY_PR_BASE_INVALID'
  );
  await assert.rejects(
    () => findOpenDataPr({ listOpenPrs: async () => [{ number: 1, state: 'open', baseRefName: 'main', headRefName: 'news/review/a' }] }),
    err => err.code === 'NEWS_DELIVERY_INVALID_PR'
  );
});

test('deliverNewsDataPr：push 前 PR 或 head 漂移时不 push', async () => {
  let listCalls = 0;
  let pushes = 0;
  const ghClient = {
    listOpenPrs: async () => {
      listCalls += 1;
      return [{ number: 9, state: 'open', baseRefName: 'main', headRefName: 'news/review/cas', headRefOid: 'head-1' }];
    },
    getBranchHeadSha: async () => (listCalls > 1 ? 'head-2' : 'head-1'),
  };
  const gitClient = {
    checkoutBranch: async () => {},
    stageFiles: async () => {},
    commit: async () => {},
    pushNormal: async () => { pushes += 1; },
  };
  await assert.rejects(
    () => deliverNewsDataPr({ ghClient, gitClient, batch: 'cas', changedFiles: [DATA_PR_ALLOWED_FILES[0]] }),
    err => err.code === 'NEWS_DELIVERY_HEAD_DRIFT'
  );
  assert.equal(pushes, 0);
});
