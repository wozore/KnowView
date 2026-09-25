/**
 * check-news-data-retention.js —— 检查 Data PR 更新是否丢失候选记录
 */

'use strict';

const { parseArgs, defaultRunner, readGitFile } = require('./deliver-news-data-pr');
const { assertCandidateRetention } = require('../src/news/delivery');

const CANDIDATE_FILES = [
  'data/news/runtime/min-candidates.json',
  'data/manual/review.json',
];
const HISTORY_FILE = 'data/news/runtime/min-candidates-history.json';

function runRetentionCheck({ args = parseArgs(), run = defaultRunner, logWriter = message => process.stdout.write(`${message}\n`) } = {}) {
  const headSha = args.headSha;
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(headSha)) {
    throw new Error('[NEWS_DELIVERY_INVALID_RETENTION_SHA] --head-sha 必须是有效 Git SHA');
  }
  const commits = run('git', ['rev-list', '--parents', '-n', '1', headSha]).trim().split(/\s+/);
  if (commits[0] !== headSha) throw new Error('[NEWS_DELIVERY_INVALID_RETENTION_SHA] Git 未返回指定 head commit');
  const parents = commits.slice(1);
  if (parents.length === 0) {
    logWriter(`Candidate retention check skipped: ${headSha} has no parent commit.`);
    return { checked: false, parents: [] };
  }
  const currentFiles = Object.fromEntries(CANDIDATE_FILES.map(file => [
    file,
    readGitFile(run, headSha, file, 'NEWS_DELIVERY_RETENTION_READ_FAILED'),
  ]));
  const historyContent = readGitFile(run, headSha, HISTORY_FILE, 'NEWS_DELIVERY_RETENTION_READ_FAILED');
  for (const parentSha of parents) {
    const previousFiles = Object.fromEntries(CANDIDATE_FILES.map(file => [
      file,
      readGitFile(run, parentSha, file, 'NEWS_DELIVERY_RETENTION_READ_FAILED'),
    ]));
    assertCandidateRetention({ previousFiles, currentFiles, historyContent });
  }
  logWriter(`Candidate retention check passed for ${headSha} against ${parents.length} parent commit(s).`);
  return { checked: true, parents };
}

function main() {
  runRetentionCheck();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runRetentionCheck, main };
