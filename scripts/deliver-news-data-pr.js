/**
 * deliver-news-data-pr.js —— GitHub Actions 新闻 Data PR 交付薄包装
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  deliverNewsDataPr,
  syncDataPrBaseline,
  assertCandidateRetention,
} = require('../src/news/delivery');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = inline;
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
    } else {
      args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
    }
  }
  return args;
}

// 不做整体 trim：git status -z 的首条目以前导空格开头（状态位 " M " 的一部分），
// trim 会破坏 slice(3) 的路径解析；需要去空白的位置各自显式 trim。
function defaultRunner(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function isMissingGitPathError(error, filePath) {
  const stderr = String(error?.stderr || '');
  return error?.status === 128 && stderr.includes(`fatal: path '${filePath}' does not exist in '`);
}

function readGitFile(run, revision, filePath, errorCode, context = revision) {
  try {
    return run('git', ['show', `${revision}:${filePath}`]);
  } catch (error) {
    if (isMissingGitPathError(error, filePath)) return null;
    const detail = error?.code || error?.status || String(error?.stderr || error?.message || 'unknown error').split('\n')[0];
    const wrapped = new Error(`[${errorCode}] 无法读取 ${context}:${filePath}：${detail}`);
    wrapped.code = errorCode;
    throw wrapped;
  }
}

function createGitHubClient(run = defaultRunner) {
  let repository = null;
  const repositoryName = () => {
    if (!repository) repository = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
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
    ]).trim(),
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

function createGitClient(run = defaultRunner, { rootDir = process.cwd() } = {}) {
  const allowedPathOf = file => path.join(rootDir, file);
  // 切分支前保存六文件内容、切完恢复：让 checkout -f 不会丢掉本次管线产出
  //（六文件相对 PR 分支是脏的，普通 checkout 会被 git 拒绝或覆盖）。
  const snapshotAllowedFiles = () => {
    const saved = new Map();
    for (const file of DATA_PR_ALLOWED_FILES) {
      const target = allowedPathOf(file);
      if (fs.existsSync(target)) saved.set(target, fs.readFileSync(target, 'utf8'));
    }
    return saved;
  };
  const restoreAllowedFiles = saved => {
    for (const [target, content] of saved) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  };
  const configureIdentity = () => {
    run('git', ['config', 'user.name', 'github-actions[bot]']);
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  };
  return {
    checkoutBranch: async branch => {
      configureIdentity();
      run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      const saved = snapshotAllowedFiles();
      run('git', ['checkout', '-f', '-B', branch, `origin/${branch}`]);
      restoreAllowedFiles(saved);
    },
    readBranchFile: async (branch, file, expectedHeadSha) => {
      verifyAllowedFilesOnly([file]);
      run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      return readGitFile(run, expectedHeadSha, file, 'NEWS_DELIVERY_BRANCH_READ_FAILED', branch);
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
    commit: async message => {
      if (!run('git', ['diff', '--cached', '--name-only']).trim()) return '(no staged changes)';
      return run('git', ['commit', '-m', message]);
    },
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
    readCurrentFile: file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  });
  const output = { ...result, batch, pushed: true, pr_number: result.prNumber };
  outputWriter(args.output, output);
  return output;
}

/**
 * 基线播种模式（--sync-baseline）：管线运行前调用，把开放 Data PR 分支上的
 * 六个运行时文件写回工作树，作为本次采集的读入基线。要求当前工作树完全干净，
 * 防止覆盖维护者本地未提交数据。
 */
async function runBaselineSync({ args = parseArgs(), run = defaultRunner, outputWriter = writeOutput, logWriter = message => process.stdout.write(`${message}\n`), rootDir = process.cwd() } = {}) {
  const raw = run('git', ['status', '--porcelain', '-z', '--untracked-files=all']);
  const dirty = raw ? raw.split('\0').filter(Boolean) : [];
  if (dirty.length > 0) {
    throw new Error(`[NEWS_DELIVERY_BASELINE_DIRTY] 基线同步要求干净工作树：${dirty.map(entry => entry.slice(3)).join(', ')}`);
  }
  const fetchedBranches = new Set();
  const fetchFile = async (branch, filePath) => {
    if (!fetchedBranches.has(branch)) {
      run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      fetchedBranches.add(branch);
    }
    return readGitFile(run, `refs/remotes/origin/${branch}`, filePath, 'NEWS_DELIVERY_BASELINE_READ_FAILED', branch);
  };
  const result = await syncDataPrBaseline({
    ghClient: createGitHubClient(run),
    fetchFile,
    writeFile: (file, content) => {
      const target = path.join(rootDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
  });
  outputWriter(args.output, {
    action: result.synced ? 'baseline_synced' : 'none',
    pr_number: result.prNumber ?? '',
    branch: result.branch ?? '',
    files: JSON.stringify(result.files || []),
    missing_files: JSON.stringify(result.missingFiles || []),
    file_sizes: JSON.stringify(result.fileSizes || {}),
  });
  if (result.synced) {
    const sizes = Object.entries(result.fileSizes).map(([file, bytes]) => `${file}: ${bytes} B`).join('; ');
    const missing = result.missingFiles.length ? ` Missing: ${result.missingFiles.join(', ')}.` : '';
    logWriter(`Data PR #${result.prNumber} baseline: seeded ${result.files.length}/${DATA_PR_ALLOWED_FILES.length} files. ${sizes}.${missing}`);
  } else {
    logWriter('No open Data PR baseline to sync.');
  }
  return result;
}

async function main() {
  if (parseArgs().syncBaseline === true) await runBaselineSync();
  else await runDelivery();
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, defaultRunner, readGitFile, createGitHubClient, createGitClient, assertCleanOutsideData, runDelivery, runBaselineSync, main };
