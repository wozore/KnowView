'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  findOpenDataPr,
  syncDataPrBaseline,
  assertCandidateRetention,
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
    'data/news/runtime/source-history.json': { sources: {} },
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
  assert.throws(
    () => validateDataPrFiles(['data/news/runtime/source-history.json'], () => JSON.stringify({ sources: [] })),
    /NEWS_DELIVERY_SCHEMA_INVALID/
  );
  assert.throws(
    () => validateDataPrFiles(['data/news/runtime/source-history.json'], () => JSON.stringify({ sources: { a: { samples: [], seen_native_ids: null } } })),
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

test('syncDataPrBaseline: 无开放 PR 时不取文件；有开放 PR 时按分支播种六文件', async () => {
  const ghNone = { listOpenPrs: async () => [] };
  const noFetch = async () => {
    throw new Error('无开放 PR 时不应取文件');
  };
  const none = await syncDataPrBaseline({ ghClient: ghNone, fetchFile: noFetch, writeFile: noFetch });
  assert.deepEqual(none, { synced: false, reason: 'no_open_data_pr' });

  const ghSingle = {
    listOpenPrs: async () => [
      { number: 42, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-1', headRefOid: 'sha-123' },
    ],
  };
  const fetched = [];
  const written = [];
  const result = await syncDataPrBaseline({
    ghClient: ghSingle,
    fetchFile: async (branch, file) => {
      fetched.push([branch, file]);
      return file.endsWith('schedule-state.json') ? null : `{"file":"${file}"}`;
    },
    writeFile: async (file, content) => written.push([file, content]),
  });
  assert.equal(result.synced, true);
  assert.equal(result.prNumber, 42);
  assert.equal(result.branch, 'news/review/batch-1');
  assert.deepEqual(fetched.map(pair => pair[0]), Array(6).fill('news/review/batch-1'));
  assert.deepEqual(fetched.map(pair => pair[1]), [...DATA_PR_ALLOWED_FILES]);
  assert.deepEqual(written.map(pair => pair[0]), DATA_PR_ALLOWED_FILES.filter(file => !file.endsWith('schedule-state.json')));
  assert.deepEqual(result.files, DATA_PR_ALLOWED_FILES.filter(file => !file.endsWith('schedule-state.json')));
  assert.deepEqual(result.missingFiles, ['data/news/runtime/schedule-state.json']);
  assert.equal(result.fileSizes['data/news/runtime/min-candidates.json'], Buffer.byteLength('{"file":"data/news/runtime/min-candidates.json"}', 'utf8'));
});

test('assertCandidateRetention：拦截未归档的候选丢失，允许归档后的清理', () => {
  const previousFiles = {
    'data/news/runtime/min-candidates.json': JSON.stringify({ candidates: [{ id: 'youtube:video-1', platform: 'youtube' }] }),
    'data/manual/review.json': JSON.stringify({ candidates: [{ id: 'youtube:video-1' }] }),
  };
  const currentFiles = {
    'data/news/runtime/min-candidates.json': JSON.stringify({ candidates: [] }),
    'data/manual/review.json': JSON.stringify({ candidates: [] }),
  };
  assert.throws(
    () => assertCandidateRetention({ previousFiles, currentFiles }),
    error => error.code === 'NEWS_DELIVERY_CANDIDATES_DROPPED' && /youtube:video-1/.test(error.message)
  );
  const result = assertCandidateRetention({
    previousFiles,
    currentFiles,
    historyContent: JSON.stringify({ batches: [{ items: [{ id: 'youtube:video-1', title: 'Video' }] }] }),
  });
  assert.deepEqual(result.checkedFiles, ['data/news/runtime/min-candidates.json', 'data/manual/review.json']);
  assert.doesNotThrow(() => assertCandidateRetention({
    previousFiles,
    currentFiles: {
      ...currentFiles,
      'data/news/runtime/min-candidates.json': JSON.stringify({ candidates: [{ id: 'youtube:video-1', review_status: 'approved' }] }),
    },
  }), 'min store 已落地 approved/discarded 结论后允许从人工清单移除');
});

test('syncDataPrBaseline: 多个开放 PR 或非法适配器 fail-closed', async () => {
  const ghMulti = {
    listOpenPrs: async () => [
      { number: 42, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-1', headRefOid: 'sha-123' },
      { number: 43, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-2', headRefOid: 'sha-456' },
    ],
  };
  await assert.rejects(
    async () => syncDataPrBaseline({ ghClient: ghMulti, fetchFile: async () => '', writeFile: async () => {} }),
    err => err.code === 'NEWS_DELIVERY_MULTIPLE_PRS'
  );
  await assert.rejects(
    async () => syncDataPrBaseline({ ghClient: { listOpenPrs: async () => [] }, fetchFile: null, writeFile: async () => {} }),
    err => err.code === 'NEWS_DELIVERY_INVALID_BASELINE_ADAPTER'
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
    getBranchHeadSha: async () => 'main-head',
    createPr: async payload => {
      actions.push({ type: 'createPr', ...payload });
      return { prNumber: 101 };
    },
  };
  const gitClient = {
    readBranchFile: async (_branch, file) => file.endsWith('review.json')
      ? JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [] })
      : JSON.stringify({ schema_version: 1, candidates: [] }),
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
    readCurrentFile: async file => file.endsWith('min-candidates-history.json') ? null
      : file.endsWith('review.json')
        ? JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [] })
        : JSON.stringify({ schema_version: 1, candidates: [] }),
  });

  assert.equal(res.action, 'created');
  assert.equal(res.prNumber, 101);
  assert.equal(actions.some(a => a.type === 'createPr'), true);
  assert.equal(actions.find(a => a.type === 'createPr').base, 'main');
  assert.equal(actions.some(a => a.type === 'push' && a.b === 'news/review/batch-test-1'), true);
});

test('deliverNewsDataPr：基于 main 新建 PR 前阻断已存在候选的丢失', async () => {
  const actions = [];
  const candidate = { id: 'youtube:main-video', platform: 'youtube', review_status: 'pending' };
  const ghClient = {
    listOpenPrs: async () => [],
    getBranchHeadSha: async () => 'main-head',
    createPr: async () => { actions.push('createPr'); return { prNumber: 102 }; },
  };
  const gitClient = {
    readBranchFile: async (_branch, file) => file.endsWith('review.json')
      ? JSON.stringify({ candidates: [candidate] })
      : JSON.stringify({ candidates: [candidate] }),
    createAndCheckoutBranch: async () => actions.push('createBranch'),
    stageFiles: async () => {},
    commit: async () => {},
    pushNormal: async () => actions.push('push'),
  };
  await assert.rejects(
    () => deliverNewsDataPr({
      ghClient,
      gitClient,
      batch: 'drop-main',
      changedFiles: [DATA_PR_ALLOWED_FILES[0]],
      readCurrentFile: async file => file.endsWith('min-candidates-history.json')
        ? null
        : JSON.stringify({ candidates: [] }),
    }),
    error => error.code === 'NEWS_DELIVERY_CANDIDATES_DROPPED' && /youtube:main-video/.test(error.message)
  );
  assert.deepEqual(actions, []);
});

test('deliverNewsDataPr: 存在 1 个开放 PR 时通过 CAS 更新同一个 PR', async () => {
  const actions = [];
  const ghClient = {
    listOpenPrs: async () => [{ number: 99, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-open', headRefOid: 'head-aaa' }],
    getBranchHeadSha: async () => 'head-aaa',
  };
  const gitClient = {
    checkoutBranch: async b => actions.push({ type: 'checkout', b }),
    readBranchFile: async (b, file, sha) => {
      actions.push({ type: 'readBranchFile', b, file, sha });
      return file.endsWith('review.json')
        ? JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [] })
        : JSON.stringify({ schema_version: 1, candidates: [] });
    },
    stageFiles: async f => actions.push({ type: 'stage', f }),
    commit: async m => actions.push({ type: 'commit', m }),
    pushNormal: async b => actions.push({ type: 'push', b }),
  };

  const res = await deliverNewsDataPr({
    ghClient,
    gitClient,
    batch: 'batch-test-2',
    changedFiles: ['data/news/runtime/min-candidates.json'],
    readCurrentFile: async file => file.endsWith('min-candidates-history.json') ? null
      : file.endsWith('review.json')
        ? JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [] })
        : JSON.stringify({ schema_version: 1, candidates: [] }),
  });

  assert.equal(res.action, 'updated');
  assert.equal(res.prNumber, 99);
  assert.equal(actions.some(a => a.type === 'checkout' && a.b === 'news/review/batch-open'), true);
  assert.equal(actions.filter(a => a.type === 'readBranchFile').length, 4, '同时核对开放 Data PR 分支与最新 main');
  assert.equal(actions.some(a => a.type === 'push' && a.b === 'news/review/batch-open'), true);
});

test('deliverNewsDataPr：候选记录丢失时在 checkout 和 push 前 fail-closed', async () => {
  const actions = [];
  const candidate = { id: 'youtube:kept-video', platform: 'youtube', review_status: 'pending' };
  const previousMin = JSON.stringify({ schema_version: 1, candidates: [candidate] });
  const previousReview = JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [candidate] });
  const currentMin = previousMin;
  const currentReview = JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [] });
  const ghClient = {
    listOpenPrs: async () => [{ number: 100, state: 'open', baseRefName: 'main', headRefName: 'news/review/retention', headRefOid: 'head-retention' }],
    getBranchHeadSha: async () => 'head-retention',
  };
  const gitClient = {
    readBranchFile: async (_branch, file) => file.endsWith('review.json') ? previousReview : previousMin,
    checkoutBranch: async () => actions.push('checkout'),
    stageFiles: async () => {},
    commit: async () => {},
    pushNormal: async () => actions.push('push'),
  };
  await assert.rejects(
    () => deliverNewsDataPr({
      ghClient,
      gitClient,
      batch: 'retention',
      changedFiles: [DATA_PR_ALLOWED_FILES[0]],
      readCurrentFile: async file => file.endsWith('min-candidates-history.json')
        ? null
        : file.endsWith('review.json') ? currentReview : currentMin,
    }),
    error => error.code === 'NEWS_DELIVERY_CANDIDATES_DROPPED' && /youtube:kept-video/.test(error.message)
  );
  assert.deepEqual(actions, []);
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
    readBranchFile: async () => null,
    stageFiles: async () => {},
    commit: async () => {},
    pushNormal: async () => { pushes += 1; },
  };
  await assert.rejects(
    () => deliverNewsDataPr({
      ghClient,
      gitClient,
      batch: 'cas',
      changedFiles: [DATA_PR_ALLOWED_FILES[0]],
      readCurrentFile: async () => null,
    }),
    err => err.code === 'NEWS_DELIVERY_HEAD_DRIFT'
  );
  assert.equal(pushes, 0);
});
