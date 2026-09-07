/** Offline tests for isolated Codex configuration and fail-open hooks. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkConfig } = require('../scripts/check-config');
const PROJECT = path.resolve(__dirname, '../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  return { root, write, git };
}

test('isolated configuration has a complete instruction and workflow index', () => {
  assert.deepEqual(checkConfig(PROJECT), []);
});

test('missing configuration is reported without loading user configuration', t => {
  const f = fixture(t);
  const failures = checkConfig(f.root);
  assert.ok(failures.some(item => item.includes('.codex/AGENTS.md')));
  assert.ok(failures.some(item => item.includes('explicit instruction entry')));
});

test('Stop reports document errors and staged whitespace while staying fail-open', t => {
  const f = fixture(t);
  f.write('scripts/check-document-policy.js', fs.readFileSync(path.join(PROJECT, 'scripts/check-document-policy.js'), 'utf8'));
  f.write('README.md', '# fixture   \n');
  f.git('add', 'README.md');
  f.write('README.md', '# fixture\n');
  f.write('bad-plan.md', '# fixture\n');
  const result = spawnSync(process.execPath, [path.join(PROJECT, '.codex/scripts/hook.js')], {
    cwd: f.root, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: f.root }),
  });
  assert.equal(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.equal(event.continue, true);
  assert.match(event.systemMessage, /document policy/);
  assert.match(event.systemMessage, /staged whitespace/);
});

test('SessionStart invokes the checker inside .codex', t => {
  const f = fixture(t);
  f.write('.codex/scripts/check-config.js', 'process.exitCode = 0;\n');
  const result = spawnSync(process.execPath, [path.join(PROJECT, '.codex/scripts/hook.js')], {
    cwd: f.root, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.root }),
  });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).systemMessage, /configuration check passed/);
});
