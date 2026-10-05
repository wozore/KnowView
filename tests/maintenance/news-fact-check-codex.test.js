'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCodingPlanKey, codingPlanKeyOf, codexEnvironment, codexArgsOf } = require('../../scripts/news-fact-check-codex');

test('Coding Plan MCP 凭据状态只检查是否存在', () => {
  assert.equal(hasCodingPlanKey('plan-test-key'), true);
  assert.equal(hasCodingPlanKey(''), false);
  assert.equal(hasCodingPlanKey(undefined), false);
});

test('新闻查证启动器默认使用 gpt-6-luna，且允许参数覆盖', () => {
  assert.deepEqual(codexArgsOf([]), ['--model', 'gpt-6-luna']);
  assert.deepEqual(codexArgsOf(['--exec', '-C', 'project', 'prompt']), ['exec', '--model', 'gpt-6-luna', '-C', 'project', 'prompt']);
  assert.deepEqual(codexArgsOf(['--exec', '-m', 'custom-model', 'prompt']), ['exec', '-m', 'custom-model', 'prompt']);
});

test('Codex 启动环境只保留 Coding Plan MCP 密钥，不转交其他服务凭据', () => {
  const result = codexEnvironment({
    PATH: 'system-path',
    ZHIPU_API_KEY: 'api-test-key',
    GITHUB_TOKEN: 'github-test-token',
    DB_PASSWORD: 'db-test-password',
    SAFE_SETTING: 'value',
  });
  assert.deepEqual(result, {
    PATH: 'system-path',
    ZHIPU_CODING_PLAN_KEY: 'api-test-key',
    SAFE_SETTING: 'value',
  });
  assert.equal(codingPlanKeyOf({ ZHIPU_API_KEY: 'subscription-test-key' }), 'subscription-test-key');
  assert.deepEqual(codexEnvironment({ ZHIPU_API_KEY: 'subscription-test-key', PATH: 'system-path' }), {
    PATH: 'system-path',
    ZHIPU_CODING_PLAN_KEY: 'subscription-test-key',
  });
});
