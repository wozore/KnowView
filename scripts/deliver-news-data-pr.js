/**
 * deliver-news-data-pr.js —— GitHub Actions 新闻 Data PR 交付薄包装
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { DATA_PR_ALLOWED_FILES, verifyAllowedFilesOnly, validateDataPrFiles, deliverNewsDataPr } = require('../src/news/delivery');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = inline ?? argv[++index];
  }
  return args;
}

function defaultRunner(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createGitHubClient(run = defaultRunner) {
  let repository = null;
  const repositoryName = () => {
    if (!repository) repository = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (!repository) throw new Error('无法解析 GitHub repository');
    return repository;
  };
  return {
    listOpenPrs: async () => JSON.parse(run('gh', [
      'pr', 'list', '--state', 'open', '--json',
      'number,state,baseRefName,headRefName,headRefOid,title', '--limit', '100',
    ]) || '[]'),
    getBranchHeadSha: async branch => run('gh', [
      'api', `repos/${repositoryName()}/branches/${encodeURIComponent(branch)}`, '--jq', '.commit.sha',
    ]),
    createPr: async payload => {
      if (payload.base !== 'main') throw new Error('Data PR base 必须是 main');
      const url = run('gh', [
        'pr', 'create', '--base', payload.base, '--head', payload.branch,
        '--title', payload.title, '--body', payload.body,
      ]);
      const match = String(url).match(/\/pull\/(\d+)/);
      if (!match) throw new Error('gh pr create 未返回有效 PR URL');
      return { prNumber: Number(match[1]) };
    },
  };
}

function assertCleanOutsideData(run = defaultRunner) {
  const raw = run('git', ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = raw ? raw.split('\0').filter(Boolean) : [];
  const allowed = new Set(DATA_PR_ALLOWED_FILES);
  const changedFiles = [];
  for (const entry of entries) {
    const file = entry.slice(3);
    if (!allowed.has(file)) throw new Error(`工作树存在白名单外改动，停止 Data PR：${file}`);
    changedFiles.push(file);
  }
  verifyAllowedFilesOnly(changedFiles);
  return changedFiles;
}

function createGitClient(run = defaultRunner) {
  const configureIdentity = () => {
    run('git', ['config', 'user.name', 'github-actions[bot]']);
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  };
  return {
    checkoutBranch: async branch => {
      configureIdentity();
      run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      run('git', ['checkout', '-b', branch, `origin/${branch}`]);
    },
    createAndCheckoutBranch: async branch => {
      configureIdentity();
      run('git', ['fetch', 'origin', 'main']);
      run('git', ['checkout', '-b', branch, 'origin/main']);
    },
    stageFiles: async files => {
      verifyAllowedFilesOnly(files);
      run('git', ['add', '--', ...files]);
    },
    commit: async message => run('git', ['commit', '-m', message]),
    pushNormal: async branch => run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]),
  };
}

function writeOutput(filePath, values) {
  if (!filePath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '')}`);
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function runDelivery({ args = parseArgs(), run = defaultRunner, outputWriter = writeOutput } = {}) {
  const changedFiles = assertCleanOutsideData(run);
  const batch = args.batch || `batch-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15)}`;
  if (changedFiles.length === 0) {
    outputWriter(args.output, { action: 'none', batch, pushed: false });
    return { action: 'none', batch, pushed: false, files: [] };
  }
  validateDataPrFiles(changedFiles, file => fs.readFileSync(file, 'utf8'));
  const result = await deliverNewsDataPr({
    ghClient: createGitHubClient(run),
    gitClient: createGitClient(run),
    batch,
    changedFiles,
    commitMessage: args.commitMessage,
  });
  const output = { ...result, batch, pushed: true, pr_number: result.prNumber };
  outputWriter(args.output, output);
  return output;
}

async function main() {
  await runDelivery();
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, createGitHubClient, createGitClient, assertCleanOutsideData, runDelivery, main };
