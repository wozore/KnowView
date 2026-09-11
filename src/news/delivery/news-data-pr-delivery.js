/**
 * news-data-pr-delivery.js —— 新闻 Data PR CAS 交付模块（T2/T6 编排）
 *
 * 严格按照 docs/x-advanced-search-design-plan.md §12 契约：
 * 1. 允许文件白名单严格限定为 6 个运行时数据文件，配置与源码严禁进入 Data PR
 * 2. 查找开放新闻 Data PR：0 个创建，1 个复用，>1 个 fail-closed 阻断
 * 3. 锁定分支与 head SHA 作为基线
 * 4. push 前核验远端状态与 head SHA，head 漂移或 PR 关闭时立即停止，严禁 force push
 */

'use strict';

const path = require('path');

const DATA_PR_ALLOWED_FILES = Object.freeze([
  'data/news/runtime/min-candidates.json',
  'data/news/runtime/source-history.json',
  'data/manual/review.json',
  'data/news/runtime/last-run.json',
  'data/news/runtime/schedule-state.json',
  'data/news/runtime/x-checkpoints.json',
]);

const ALLOWED_SET = new Set(DATA_PR_ALLOWED_FILES.map(f => f.replace(/\\/g, '/')));

/**
 * 校验待提交文件列表是否完全处于白名单内。
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
function verifyAllowedFilesOnly(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  for (const file of changedFiles) {
    const normalized = String(file || '').trim().replace(/\\/g, '/');
    if (!ALLOWED_SET.has(normalized)) {
      const err = new Error(`[NEWS_DELIVERY_FORBIDDEN_FILE] 非法文件进入 Data PR：${file}`);
      err.code = 'NEWS_DELIVERY_FORBIDDEN_FILE';
      throw err;
    }
  }
  return true;
}

/**
 * 查找当前开放的新闻 Data PR。
 * @param {object} ghClient
 * @returns {Promise<{prNumber: number, branch: string, headSha: string}|null>}
 */
async function findOpenDataPr(ghClient) {
  if (!ghClient || typeof ghClient.listOpenPrs !== 'function') {
    throw new Error('findOpenDataPr 需要提供有效的 ghClient 依赖');
  }
  const prs = await ghClient.listOpenPrs();
  const dataPrs = (prs || []).filter(pr => {
    const branch = String(pr.headRefName || pr.branch || '');
    const title = String(pr.title || '');
    return branch.startsWith('news/review/') || branch.startsWith('news/data/') || title.includes('热点审核');
  });

  if (dataPrs.length > 1) {
    const err = new Error(`检测到多个开放的数据 PR（${dataPrs.length} 个），fail-closed 停止`);
    err.code = 'NEWS_DELIVERY_MULTIPLE_PRS';
    throw err;
  }
  if (dataPrs.length === 1) {
    const p = dataPrs[0];
    return {
      prNumber: p.number || p.prNumber,
      branch: p.headRefName || p.branch,
      headSha: p.headSha || p.headRefOid,
    };
  }
  return null;
}

/**
 * 核对远端分支 Head SHA 是否未发生并发漂移。
 * @param {object} ghClient
 * @param {string} branch
 * @param {string} expectedHeadSha
 * @returns {Promise<boolean>}
 */
async function verifyHeadNotDrifted(ghClient, branch, expectedHeadSha) {
  if (!ghClient || typeof ghClient.getBranchHeadSha !== 'function') {
    throw new Error('verifyHeadNotDrifted 需要提供有效的 ghClient 依赖');
  }
  const currentSha = await ghClient.getBranchHeadSha(branch);
  if (!currentSha) {
    const err = new Error(`远端分支 ${branch} 已被删除或不可达`);
    err.code = 'NEWS_DELIVERY_BRANCH_NOT_FOUND';
    throw err;
  }
  if (currentSha !== expectedHeadSha) {
    const err = new Error(`远端分支 ${branch} head SHA 漂移：期望 ${expectedHeadSha}，实际 ${currentSha}`);
    err.code = 'NEWS_DELIVERY_HEAD_DRIFT';
    throw err;
  }
  return true;
}

/**
 * 执行完整的 Data PR CAS 交付流程。
 * @param {object} params
 */
async function deliverNewsDataPr({
  ghClient,
  gitClient,
  batch,
  changedFiles,
  commitMessage,
}) {
  if (!gitClient || !ghClient) {
    throw new Error('deliverNewsDataPr 需要提供有效的 gitClient 与 ghClient');
  }

  // 1. 严格白名单门禁
  verifyAllowedFilesOnly(changedFiles);

  // 2. 查找已有开放 PR
  const existingPr = await findOpenDataPr(ghClient);

  if (existingPr) {
    // 3. 复用既有 PR：CAS 核对
    await verifyHeadNotDrifted(ghClient, existingPr.branch, existingPr.headSha);

    await gitClient.checkoutBranch(existingPr.branch);
    await gitClient.stageFiles(changedFiles);
    await gitClient.commit(commitMessage || `chore(data): update news data (${batch})`);

    // 4. push 前再次二次核验远端状态
    await verifyHeadNotDrifted(ghClient, existingPr.branch, existingPr.headSha);
    await gitClient.pushNormal(existingPr.branch);

    return {
      action: 'updated',
      prNumber: existingPr.prNumber,
      branch: existingPr.branch,
      files: changedFiles,
    };
  }

  // 5. 不存在开放 PR：从 main 创建新分支并提 PR
  const newBranch = `news/review/${batch}`;
  await gitClient.createAndCheckoutBranch(newBranch);
  await gitClient.stageFiles(changedFiles);
  await gitClient.commit(commitMessage || `chore(data): update min candidates + review list (${batch})`);
  await gitClient.pushNormal(newBranch);

  const prResult = await ghClient.createPr({
    branch: newBranch,
    title: `热点审核：批次 ${batch}`,
    body: `自动化数据采集批次：${batch}`,
  });

  return {
    action: 'created',
    prNumber: prResult.prNumber,
    branch: newBranch,
    files: changedFiles,
  };
}

module.exports = {
  DATA_PR_ALLOWED_FILES,
  verifyAllowedFilesOnly,
  findOpenDataPr,
  verifyHeadNotDrifted,
  deliverNewsDataPr,
};
