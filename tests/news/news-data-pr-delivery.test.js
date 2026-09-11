'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
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
});

test('findOpenDataPr: 零开放 PR 返回 null，单个复用，多个 fail-closed 阻断', async () => {
  const ghNone = { listOpenPrs: async () => [] };
  assert.equal(await findOpenDataPr(ghNone), null);

  const ghSingle = {
    listOpenPrs: async () => [
      { number: 42, branch: 'news/review/batch-1', headSha: 'sha-123' },
    ],
  };
  const single = await findOpenDataPr(ghSingle);
  assert.deepEqual(single, { prNumber: 42, branch: 'news/review/batch-1', headSha: 'sha-123' });

  const ghMulti = {
    listOpenPrs: async () => [
      { number: 42, branch: 'news/review/batch-1', headSha: 'sha-123' },
      { number: 43, branch: 'news/review/batch-2', headSha: 'sha-456' },
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
  assert.equal(actions.some(a => a.type === 'push' && a.b === 'news/review/batch-test-1'), true);
});

test('deliverNewsDataPr: 存在 1 个开放 PR 时通过 CAS 更新同一个 PR', async () => {
  const actions = [];
  const ghClient = {
    listOpenPrs: async () => [{ number: 99, branch: 'news/review/batch-open', headSha: 'head-aaa' }],
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
