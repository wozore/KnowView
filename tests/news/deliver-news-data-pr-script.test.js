'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGitHubClient,
  createGitClient,
  assertCleanOutsideData,
  parseArgs,
} = require('../../scripts/deliver-news-data-pr');

const ALLOWED = 'data/news/runtime/min-candidates.json';

test('deliver script adapters：使用参数数组调用 gh/git 且显式 main', async () => {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'gh' && args[0] === 'repo') return 'owner/repo';
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[{"number":1}]';
    if (command === 'gh' && args[0] === 'api') return 'sha-1';
    if (command === 'git' && args[0] === 'status') return ` M ${ALLOWED}\0`;
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/repo/pull/12';
    return '';
  };
  const gh = createGitHubClient(run);
  assert.deepEqual(await gh.listOpenPrs(), [{ number: 1 }]);
  assert.equal(await gh.getBranchHeadSha('news/review/a'), 'sha-1');
  assert.deepEqual(await gh.createPr({ base: 'main', branch: 'news/review/a', title: 't', body: 'b' }), { prNumber: 12 });
  const git = createGitClient(run);
  await git.createAndCheckoutBranch('news/review/new');
  await git.stageFiles([ALLOWED]);
  await git.pushNormal('news/review/new');
  assert.deepEqual(calls.find(call => call.command === 'git' && call.args[0] === 'fetch').args, ['fetch', 'origin', 'main']);
  assert.ok(calls.some(call => call.command === 'git' && call.args.includes('origin/main')));
  assert.ok(calls.some(call => call.command === 'git' && call.args[0] === 'push' && !call.args.includes('--force')));
});

test('deliver script：白名单外工作树改动 fail-closed', () => {
  assert.throws(
    () => assertCleanOutsideData(() => ` M ${ALLOWED}\0?? src/private.js\0`),
    /白名单外改动/
  );
  assert.deepEqual(assertCleanOutsideData(() => ` M ${ALLOWED}\0`), [ALLOWED]);
});

test('deliver script：argv 解析支持 output、batch 和提交消息', () => {
  assert.deepEqual(parseArgs(['--output', '/tmp/out', '--batch=batch-1', '--commit-message', 'msg']), {
    output: '/tmp/out', batch: 'batch-1', commitMessage: 'msg',
  });
});
