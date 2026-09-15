/**
 * news-data-pr-delivery.js —— 新闻 Data PR CAS 交付模块（T2/T6 编排）
 */

'use strict';

const DATA_PR_ALLOWED_FILES = Object.freeze([
  'data/news/runtime/min-candidates.json',
  'data/news/runtime/source-history.json',
  'data/manual/review.json',
  'data/news/runtime/last-run.json',
  'data/news/runtime/schedule-state.json',
  'data/news/runtime/x-checkpoints.json',
]);

const ALLOWED_SET = new Set(DATA_PR_ALLOWED_FILES);
const DATA_BRANCH_PREFIXES = ['news/review/', 'news/data/'];
const VALID_REVIEW_STATUSES = new Set(['pending', 'approved', 'discarded']);

function fail(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  throw error;
}

function verifyAllowedFilesOnly(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    fail('NEWS_DELIVERY_NO_FILES', 'Data PR 不能交付空文件列表');
  }
  const seen = new Set();
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !file.trim()) fail('NEWS_DELIVERY_INVALID_FILE', 'Data PR 文件路径必须是非空字符串');
    const normalized = file.trim().replace(/\\/g, '/');
    if (normalized !== file.trim() || !ALLOWED_SET.has(normalized)) {
      fail('NEWS_DELIVERY_FORBIDDEN_FILE', `非法文件进入 Data PR：${file}`);
    }
    if (seen.has(normalized)) fail('NEWS_DELIVERY_DUPLICATE_FILE', `Data PR 文件重复：${normalized}`);
    seen.add(normalized);
  }
  return true;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertSchema(file, data) {
  if (!isObject(data)) {
    fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} 顶层结构非法`);
  }
  if (file.endsWith('source-history.json')) {
    // history-store 落盘形状为 { sources }，顶层无 schema_version
    if (!isObject(data.sources)) fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file}.sources 必须为对象`);
    for (const entry of Object.values(data.sources)) {
      if (!isObject(entry) || !Array.isArray(entry.samples) || !Array.isArray(entry.seen_native_ids)) {
        fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} 含非法来源条目`);
      }
    }
    return;
  }
  if (!Number.isInteger(data.schema_version) || data.schema_version < 1) {
    fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} schema_version 非法`);
  }
  if (file.endsWith('min-candidates.json')) {
    if (!Array.isArray(data.candidates)) fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file}.candidates 必须为数组`);
    for (const candidate of data.candidates) {
      if (!isObject(candidate) || typeof candidate.id !== 'string' || !VALID_REVIEW_STATUSES.has(candidate.review_status)
        || !['youtube', 'x'].includes(candidate.platform)) {
        fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} 含非法候选条目`);
      }
    }
  } else if (file.endsWith('review.json')) {
    if (data.kind !== 'review_candidates' || !Array.isArray(data.candidates)) {
      fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} kind 或 candidates 非法`);
    }
    for (const candidate of data.candidates) {
      if (!isObject(candidate) || typeof candidate.id !== 'string' || !VALID_REVIEW_STATUSES.has(candidate.review_status)) {
        fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} 含非法审核条目`);
      }
    }
  } else if (file.endsWith('last-run.json')) {
    if (!isObject(data.collectors) || !isObject(data.collectors.x) || !Array.isArray(data.platforms)) {
      fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} collectors/platforms 非法`);
    }
  } else if (file.endsWith('schedule-state.json')) {
    if (data.youtube_last_collected_at !== undefined
      && (typeof data.youtube_last_collected_at !== 'string' || !Number.isFinite(Date.parse(data.youtube_last_collected_at)))) {
      fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file}.youtube_last_collected_at 非法`);
    }
  } else if (file.endsWith('x-checkpoints.json')) {
    if (!isObject(data.checkpoints) || !Array.isArray(data.tail_recheck_observations)) {
      fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} checkpoints/observations 非法`);
    }
  }
}

function validateDataPrFiles(changedFiles, readFile) {
  verifyAllowedFilesOnly(changedFiles);
  if (typeof readFile !== 'function') fail('NEWS_DELIVERY_INVALID_READER', 'schema 校验需要文件读取器');
  for (const file of changedFiles) {
    let data;
    try {
      data = JSON.parse(readFile(file));
    } catch (error) {
      fail('NEWS_DELIVERY_SCHEMA_INVALID', `${file} 无法读取或解析：${error.message}`);
    }
    assertSchema(file, data);
  }
  return true;
}

function isDataBranch(branch) {
  return DATA_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix));
}

function normalizePr(pr) {
  if (!pr || typeof pr !== 'object') fail('NEWS_DELIVERY_INVALID_PR', '开放 Data PR 记录非法');
  const number = pr.number || pr.prNumber;
  const branch = pr.headRefName || pr.branch;
  const headSha = pr.headRefOid || pr.headSha;
  const state = String(pr.state || '').toLowerCase();
  const base = pr.baseRefName || pr.base;
  if (!Number.isInteger(number) || number <= 0) fail('NEWS_DELIVERY_INVALID_PR', 'Data PR 缺少有效 number');
  if (!branch || !isDataBranch(branch)) fail('NEWS_DELIVERY_INVALID_PR', `Data PR head 分支非法：${branch || '(missing)'}`);
  if (!headSha) fail('NEWS_DELIVERY_INVALID_PR', `Data PR ${number} 缺少 head SHA`);
  if (state !== 'open') fail('NEWS_DELIVERY_PR_NOT_OPEN', `Data PR ${number} 状态不是 open`);
  if (base !== 'main') fail('NEWS_DELIVERY_PR_BASE_INVALID', `Data PR ${number} base 不是 main`);
  return { prNumber: number, branch, headSha, state, baseRefName: base, title: pr.title || '' };
}

function isCandidatePr(pr) {
  const branch = String(pr?.headRefName || pr?.branch || '');
  return isDataBranch(branch);
}

async function listDataPrs(ghClient) {
  const prs = await ghClient.listOpenPrs();
  if (!Array.isArray(prs)) fail('NEWS_DELIVERY_INVALID_PR_LIST', 'GitHub 开放 PR 返回不是数组');
  return prs.filter(isCandidatePr).map(normalizePr);
}

async function findOpenDataPr(ghClient) {
  if (!ghClient || typeof ghClient.listOpenPrs !== 'function') {
    fail('NEWS_DELIVERY_INVALID_GH_CLIENT', 'findOpenDataPr 需要有效 ghClient');
  }
  const dataPrs = await listDataPrs(ghClient);
  if (dataPrs.length > 1) fail('NEWS_DELIVERY_MULTIPLE_PRS', `检测到多个开放的数据 PR（${dataPrs.length} 个），fail-closed 停止`);
  return dataPrs[0] || null;
}

/**
 * 开放 Data PR 基线播种：把 PR 分支上的六个运行时文件内容写回工作树，
 * 作为本次管线读取的数据基线（§8.7 记录级幂等合并由管线自身完成）。
 * 文件在 PR 分支上不存在时跳过（保留 main 版本）；无开放 PR 时为无操作。
 */
async function syncDataPrBaseline({ ghClient, fetchFile, writeFile }) {
  if (!ghClient || typeof ghClient.listOpenPrs !== 'function') {
    fail('NEWS_DELIVERY_INVALID_GH_CLIENT', 'syncDataPrBaseline 需要有效 ghClient');
  }
  if (typeof fetchFile !== 'function' || typeof writeFile !== 'function') {
    fail('NEWS_DELIVERY_INVALID_BASELINE_ADAPTER', 'syncDataPrBaseline 需要 fetchFile 与 writeFile 适配器');
  }
  const pr = await findOpenDataPr(ghClient);
  if (!pr) return { synced: false, reason: 'no_open_data_pr' };
  const seeded = [];
  for (const file of DATA_PR_ALLOWED_FILES) {
    const content = await fetchFile(pr.branch, file);
    if (typeof content !== 'string') continue;
    writeFile(file, content);
    seeded.push(file);
  }
  return { synced: true, prNumber: pr.prNumber, branch: pr.branch, headSha: pr.headSha, files: seeded };
}

async function verifyHeadNotDrifted(ghClient, branch, expectedHeadSha) {
  if (!ghClient || typeof ghClient.getBranchHeadSha !== 'function') {
    fail('NEWS_DELIVERY_INVALID_GH_CLIENT', 'verifyHeadNotDrifted 需要有效 ghClient');
  }
  const currentSha = await ghClient.getBranchHeadSha(branch);
  if (!currentSha) fail('NEWS_DELIVERY_BRANCH_NOT_FOUND', `远端分支 ${branch} 已被删除或不可达`);
  if (currentSha !== expectedHeadSha) {
    fail('NEWS_DELIVERY_HEAD_DRIFT', `远端分支 ${branch} head SHA 漂移：期望 ${expectedHeadSha}，实际 ${currentSha}`);
  }
  return true;
}

async function verifyPrUnchanged(ghClient, expectedPr) {
  const current = await findOpenDataPr(ghClient);
  if (!current || current.prNumber !== expectedPr.prNumber) {
    fail('NEWS_DELIVERY_PR_CHANGED', `Data PR ${expectedPr.prNumber} 已关闭、替换或不可达`);
  }
  if (current.branch !== expectedPr.branch) fail('NEWS_DELIVERY_PR_CHANGED', 'Data PR head 分支发生变化');
  if (current.baseRefName !== 'main') fail('NEWS_DELIVERY_PR_BASE_INVALID', 'Data PR base 已不再是 main');
  return current;
}

function assertAdapterMethods(gitClient, ghClient, existingPr) {
  const gitMethods = existingPr
    ? ['checkoutBranch', 'stageFiles', 'commit', 'pushNormal']
    : ['createAndCheckoutBranch', 'stageFiles', 'commit', 'pushNormal'];
  for (const method of gitMethods) {
    if (typeof gitClient[method] !== 'function') fail('NEWS_DELIVERY_INVALID_GIT_CLIENT', `gitClient 缺少 ${method}`);
  }
  if (typeof ghClient.listOpenPrs !== 'function') {
    fail('NEWS_DELIVERY_INVALID_GH_CLIENT', 'ghClient 缺少 listOpenPrs');
  }
  if (!existingPr && typeof ghClient.createPr !== 'function') {
    fail('NEWS_DELIVERY_INVALID_GH_CLIENT', '新建 Data PR 需要 ghClient.createPr');
  }
}

async function updateExistingPr({ existingPr, ghClient, gitClient, changedFiles, commitMessage, batch }) {
  await verifyHeadNotDrifted(ghClient, existingPr.branch, existingPr.headSha);
  await gitClient.checkoutBranch(existingPr.branch);
  await gitClient.stageFiles(changedFiles);
  await gitClient.commit(commitMessage || `chore(data): update news data (${batch})`);
  await verifyPrUnchanged(ghClient, existingPr);
  await verifyHeadNotDrifted(ghClient, existingPr.branch, existingPr.headSha);
  await gitClient.pushNormal(existingPr.branch);
  return { action: 'updated', prNumber: existingPr.prNumber, branch: existingPr.branch, files: changedFiles };
}

async function createNewPr({ ghClient, gitClient, changedFiles, commitMessage, batch }) {
  const branch = `news/review/${batch}`;
  await gitClient.createAndCheckoutBranch(branch);
  await gitClient.stageFiles(changedFiles);
  await gitClient.commit(commitMessage || `chore(data): update min candidates + review list (${batch})`);
  await gitClient.pushNormal(branch);
  const prResult = await ghClient.createPr({
    base: 'main',
    branch,
    title: `热点审核：批次 ${batch}`,
    body: `自动化数据采集批次：${batch}`,
  });
  if (!prResult || !Number.isInteger(prResult.prNumber) || prResult.prNumber <= 0) {
    fail('NEWS_DELIVERY_INVALID_CREATED_PR', 'GitHub 未返回有效新建 PR number');
  }
  return { action: 'created', prNumber: prResult.prNumber, branch, files: changedFiles };
}

async function deliverNewsDataPr({ ghClient, gitClient, batch, changedFiles, commitMessage }) {
  if (!gitClient || !ghClient) fail('NEWS_DELIVERY_INVALID_CLIENT', 'deliverNewsDataPr 需要有效 gitClient 与 ghClient');
  verifyAllowedFilesOnly(changedFiles);
  const existingPr = await findOpenDataPr(ghClient);
  assertAdapterMethods(gitClient, ghClient, existingPr);
  return existingPr
    ? updateExistingPr({ existingPr, ghClient, gitClient, changedFiles, commitMessage, batch })
    : createNewPr({ ghClient, gitClient, changedFiles, commitMessage, batch });
}

module.exports = {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  validateDataPrFiles,
  findOpenDataPr,
  syncDataPrBaseline,
  verifyHeadNotDrifted,
  deliverNewsDataPr,
};
