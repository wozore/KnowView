'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  createGitHubClient,
  createGitClient,
  assertCleanOutsideData,
  parseArgs,
  runBaselineSync,
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
  assert.equal(parseArgs(['--sync-baseline', '--output', '/tmp/out']).syncBaseline, true);
});

function gitIn(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

test('checkoutBranch：脏六文件在强制切换 PR 分支时被保存并恢复（真实 git 语义）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dpr-checkout-'));
  const originDir = path.join(base, 'origin');
  const workDir = path.join(base, 'work');
  try {
    execFileSync('git', ['init', '-b', 'main', originDir]);
    gitIn(originDir, 'config', 'user.email', 'test@example.com');
    gitIn(originDir, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(originDir, 'data/news/runtime'), { recursive: true });
    fs.writeFileSync(path.join(originDir, ALLOWED), '{"v":1}');
    gitIn(originDir, 'add', '-A');
    gitIn(originDir, 'commit', '-m', 'init');
    gitIn(originDir, 'checkout', '-b', 'news/review/batch-1');
    fs.writeFileSync(path.join(originDir, ALLOWED), '{"v":2}');
    gitIn(originDir, 'commit', '-am', 'pr change');
    const branchSha = gitIn(originDir, 'rev-parse', 'HEAD');
    gitIn(originDir, 'checkout', 'main');

    execFileSync('git', ['clone', originDir, workDir]);
    gitIn(workDir, 'config', 'user.email', 'test@example.com');
    gitIn(workDir, 'config', 'user.name', 'test');
    const workFile = path.join(workDir, ALLOWED);
    fs.writeFileSync(workFile, '{"v":3}');

    const run = (command, args) => execFileSync(command, args, { cwd: workDir, encoding: 'utf8' }).trim();
    const gitClient = createGitClient(run, { rootDir: workDir });
    await gitClient.checkoutBranch('news/review/batch-1');
    assert.equal(fs.readFileSync(workFile, 'utf8'), '{"v":3}', '脏六文件内容在切换后必须保留');
    assert.equal(gitIn(workDir, 'rev-parse', 'HEAD'), branchSha, '工作树必须落在 PR 分支 head');

    await gitClient.stageFiles([ALLOWED]);
    await gitClient.commit('chore(data): merge local run');
    await gitClient.pushNormal('news/review/batch-1');
    assert.equal(gitIn(originDir, 'rev-parse', 'news/review/batch-1'), gitIn(workDir, 'rev-parse', 'HEAD'), '推送必须快进远端分支');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runBaselineSync：干净工作树时从开放 PR 分支播种六文件；脏工作树 fail-closed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpr-sync-'));
  try {
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{ number: 7, state: 'OPEN', baseRefName: 'main', headRefName: 'news/review/batch-1', headRefOid: 'sha-7' }]);
      }
      if (command === 'git' && args[0] === 'status') return '';
      if (command === 'git' && args[0] === 'show') {
        const filePath = args[1].slice(args[1].indexOf(':') + 1);
        return filePath.endsWith('x-checkpoints.json') ? null : `{"seeded":"${filePath}"}`;
      }
      return '';
    };
    const outputs = [];
    const result = await runBaselineSync({
      args: { output: null },
      run,
      outputWriter: (file, values) => outputs.push(values),
      rootDir: tempDir,
    });
    assert.equal(result.synced, true);
    assert.equal(result.prNumber, 7);
    assert.equal(result.branch, 'news/review/batch-1');
    const seededFiles = fs.readdirSync(path.join(tempDir, 'data/news/runtime'));
    assert.ok(seededFiles.includes('min-candidates.json'));
    assert.ok(!seededFiles.includes('x-checkpoints.json'), 'PR 分支缺失的文件不应播种');
    assert.equal(fs.readFileSync(path.join(tempDir, ALLOWED), 'utf8'), `{"seeded":"${ALLOWED}"}`);
    assert.ok(calls.filter(call => call.command === 'git' && call.args[0] === 'fetch').length === 1, '同一分支只 fetch 一次');
    assert.deepEqual(outputs, [{ action: 'baseline_synced', pr_number: 7, branch: 'news/review/batch-1' }]);

    const dirtyRun = () => ' M src/private.js\0';
    await assert.rejects(
      async () => runBaselineSync({ args: {}, run: dirtyRun, outputWriter: () => {}, rootDir: tempDir }),
      /NEWS_DELIVERY_BASELINE_DIRTY/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runBaselineSync：无开放 PR 时输出 action none 且不写文件', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpr-sync-none-'));
  try {
    const run = (command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
      if (command === 'git' && args[0] === 'status') return '';
      return '';
    };
    const outputs = [];
    const result = await runBaselineSync({
      args: {},
      run,
      outputWriter: (file, values) => outputs.push(values),
      rootDir: tempDir,
    });
    assert.deepEqual(result, { synced: false, reason: 'no_open_data_pr' });
    assert.deepEqual(outputs, [{ action: 'none', pr_number: '', branch: '' }]);
    assert.equal(fs.existsSync(path.join(tempDir, 'data')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
