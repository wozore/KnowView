/** Offline Git fixtures for the project document policy. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDocuments } = require('../../scripts/check-document-policy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (name, text = '# fixture\n') => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  git('init', '--quiet');
  write('.gitignore', '/docs/*\n!/docs/architecture.md\n!/docs/manual/\n/开发计划.md\n');
  return { root, git, write };
}

test('catches the original untracked Chinese root plan', t => {
  const f = fixture(t);
  f.write('厂商卡片逐家更新计划.local.md');
  assert.match(checkDocuments(f.root).join('\n'), /unapproved root document/);
});

test('allows ignored local plans and public documents', t => {
  const f = fixture(t);
  for (const file of ['README.md', '开发计划.md', 'docs/vendor-card-update-plan.md', 'docs/vendor-openai-report.md', 'docs/architecture.md', 'docs/manual/codebase-standards.md']) f.write(file);
  assert.deepEqual(checkDocuments(f.root), []);
});

test('force-staged plan is rejected even with an ignore rule', t => {
  const f = fixture(t);
  f.write('docs/vendor-card-update-plan.md');
  f.git('add', '-f', '--', 'docs/vendor-card-update-plan.md');
  assert.match(checkDocuments(f.root).join('\n'), /tracked\/staged/);
});

test('plans cannot hide in public manuals and ignored paths still need valid names', t => {
  const f = fixture(t);
  f.write('docs/manual/vendor-plan.md');
  f.write('docs/中文-plan.md');
  f.write('docs/misc.md');
  const errors = checkDocuments(f.root).join('\n');
  assert.match(errors, /no Git ignore rule/);
  assert.match(errors, /must use docs/);
  assert.match(errors, /outside the system\/manual contract/);
});

test('missing ignore rule is detected', t => {
  const f = fixture(t);
  f.write('.gitignore', '');
  f.write('docs/vendor-plan.md');
  assert.match(checkDocuments(f.root).join('\n'), /no Git ignore rule/);
});

test('ignoring a root plan does not make its placement valid', t => {
  const f = fixture(t);
  f.write('.gitignore', '/bad-plan.md\n');
  f.write('bad-plan.md');
  assert.match(checkDocuments(f.root).join('\n'), /unapproved root document/);
});

test('mixed-case extensions cannot bypass ignored, untracked or staged checks', t => {
  const f = fixture(t);
  f.write('docs/ignored-plan.MD');
  f.write('docs/staged-plan.Md');
  f.git('add', '-f', '--', 'docs/staged-plan.Md');
  f.write('docs/manual/visible-plan.mD');
  const errors = checkDocuments(f.root).join('\n');
  assert.match(errors, /ignored-plan\.MD: local work document must use/);
  assert.match(errors, /staged-plan\.Md: local work document is tracked/);
  assert.match(errors, /visible-plan\.mD: local work document has no Git ignore rule/);
});

test('Git failure cannot be reported as success', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-no-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => checkDocuments(root), /Git check failed/);
});
