/**
 * 手动启动 Codex CLI，并只向其传递 Coding Plan MCP 凭据。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadDotEnv, PROJECT_DIR } = require('../src/shared/env');
const { EXTERNAL_NETWORK_ENABLED, externalNetworkDisabledError } = require('../src/shared/external-operation-policy');

const SENSITIVE_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|_PASS)$/i;

function hasCodingPlanKey(value) {
  return typeof value === 'string' && value.length > 0;
}

function codingPlanKeyOf(source) {
  return source?.ZHIPU_API_KEY || '';
}

function codexEnvironment(source) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!SENSITIVE_ENV_NAME.test(key)) env[key] = value;
  }
  const planKey = codingPlanKeyOf(source);
  if (hasCodingPlanKey(planKey)) env.ZHIPU_CODING_PLAN_KEY = planKey;
  return env;
}

function codexInvocation(args, env) {
  if (process.platform !== 'win32') return { command: 'codex', args };
  if (!env?.APPDATA) throw new Error('无法定位 Codex CLI 的用户级安装目录');
  return {
    command: 'pwsh',
    args: ['-NoProfile', '-File', path.join(env.APPDATA, 'npm', 'codex.ps1'), ...args],
  };
}

function codexArgsOf(args) {
  const isExec = args[0] === '--exec';
  const codexArgs = isExec ? ['exec', ...args.slice(1)] : args.slice();
  const optionStart = isExec ? 1 : 0;
  const argsAfterCommand = codexArgs.slice(optionStart);
  const hasModel = argsAfterCommand.some((arg, index) => (
    arg === '-m' || arg === '--model'
    || (index > 0 && ['-m', '--model'].includes(argsAfterCommand[index - 1]))
  ));
  if (!hasModel) codexArgs.splice(optionStart, 0, '--model', 'gpt-6-luna');
  return codexArgs;
}

function main(args = process.argv.slice(2)) {
  if (!EXTERNAL_NETWORK_ENABLED) {
    process.stderr.write(`${externalNetworkDisabledError('EXTERNAL_NETWORK_DISABLED').message}\n`);
    process.exitCode = 1;
    return;
  }
  loadDotEnv();
  const key = codingPlanKeyOf(process.env);
  if (args.includes('--check')) {
    process.stdout.write(hasCodingPlanKey(key) ? 'Coding Plan MCP key configured.\n' : 'Coding Plan MCP key missing.\n');
    return;
  }
  if (!hasCodingPlanKey(key)) {
    process.stderr.write('缺少 ZHIPU_API_KEY；请在仓库根目录 .env 设置智谱套餐密钥后重试。\n');
    process.exitCode = 1;
    return;
  }
  if (args[0] === '--exec' && args.length === 1) throw new Error('--exec 缺少 Codex 执行参数');
  const codexArgs = codexArgsOf(args);
  const invocation = codexInvocation(codexArgs, process.env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: PROJECT_DIR,
    env: codexEnvironment(process.env),
    stdio: args[0] === '--exec' ? ['inherit', 'ignore', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.stderr?.length) {
    process.stderr.write(result.stderr.subarray(-4000));
  }
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) main();

module.exports = { hasCodingPlanKey, codingPlanKeyOf, codexEnvironment, codexInvocation, codexArgsOf, main };
