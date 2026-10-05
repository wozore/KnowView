'use strict';

const EXTERNAL_NETWORK_ENABLED = false;
const GITHUB_REPOSITORY_OPERATIONS_ENABLED = false;

function externalNetworkDisabledError(code = 'EXTERNAL_NETWORK_DISABLED') {
  const error = new Error('项目外网访问已关闭');
  error.code = code;
  return error;
}

function externalNetworkDisabledResult(code = 'EXTERNAL_NETWORK_DISABLED') {
  return { ok: false, code, error: '项目外网访问已关闭' };
}

function githubRepositoryOperationDisabledError() {
  const error = new Error('GitHub 仓库操作已关闭');
  error.code = 'GITHUB_REPOSITORY_OPERATIONS_DISABLED';
  return error;
}

module.exports = {
  EXTERNAL_NETWORK_ENABLED,
  GITHUB_REPOSITORY_OPERATIONS_ENABLED,
  externalNetworkDisabledError,
  externalNetworkDisabledResult,
  githubRepositoryOperationDisabledError,
};
