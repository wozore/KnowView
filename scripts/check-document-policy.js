/** Check document paths and Git tracking without reading document contents. */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT_DOCUMENTS = new Set([
  'ABOUT.md', 'AGENTS.md', 'CODEBASE-MAP.md', 'CODE_OF_CONDUCT.md',
  'CONTEXT.md', 'CONTRIBUTING.md', 'README.md', 'SECURITY.md', 'SUPPORT.md',
  '开发计划.md',
]);
const SYSTEM_DOCUMENTS = new Set([
  'architecture.md', 'content-quality.md', 'decisions.md',
  'hotspot-workflow.md', 'operations.md', 'requirements.md',
]);

function git(root, args, input) {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, input,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Git check failed: ${args[0]} (${result.error?.code || result.status})`);
  }
  if (result.status === 1 && args[0] !== 'check-ignore') throw new Error(`Git check failed: ${args[0]}`);
  return result.stdout.split('\0').filter(Boolean);
}

function validateDocumentPaths({ files, tracked, ignored }) {
  const failures = [];
  for (const file of files) {
    if (!/\.md$/i.test(file)) continue;
    if (!file.includes('/') && !ROOT_DOCUMENTS.has(file)) {
      failures.push(`${file}: unapproved root document; use docs/<topic>-plan.md or define its contract`);
    }
    const localRootPlan = file === '开发计划.md';
    if (!file.startsWith('docs/') && !localRootPlan) continue;
    const name = file.slice('docs/'.length);
    const temporary = localRootPlan || /(?:-plan|-report)\.md$/i.test(file);
    if (temporary) {
      if (tracked.has(file)) failures.push(`${file}: local work document is tracked/staged`);
      if (!ignored.has(file)) failures.push(`${file}: local work document has no Git ignore rule`);
      if (!localRootPlan && !/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*-(?:plan|report)\.md$/.test(file)) {
        failures.push(`${file}: local work document must use docs/<topic>-plan.md or -report.md`);
      }
    } else if (!SYSTEM_DOCUMENTS.has(name) && !/^docs\/manual\/.+\.md$/.test(file)) {
      failures.push(`${file}: document is outside the system/manual contract`);
    }
  }
  return failures;
}

function checkDocuments(root = path.resolve(__dirname, '..')) {
  const tracked = new Set(git(root, ['ls-files', '-z', '--', '*.[mM][dD]']));
  const visible = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '*.[mM][dD]']);
  const local = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'docs/*.[mM][dD]', '开发计划.md']);
  const rootFiles = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => !entry.isDirectory() && /\.md$/i.test(entry.name)).map(entry => entry.name);
  const files = [...new Set([...tracked, ...visible, ...local, ...rootFiles])];
  const ignored = new Set(files.length ? git(root, ['check-ignore', '--no-index', '-z', '--stdin'], files.join('\0') + '\0') : []);
  return validateDocumentPaths({ files, tracked, ignored });
}

function main() {
  try {
    const failures = checkDocuments();
    for (const failure of failures) console.error(`document-policy: ${failure}`);
    if (failures.length) return 1;
    console.log('document-policy: document paths and Git tracking passed');
    return 0;
  } catch (error) {
    console.error(`document-policy: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { validateDocumentPaths, checkDocuments, main };
