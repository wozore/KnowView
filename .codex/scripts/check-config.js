/** Validate only this repository's Codex configuration; never read credentials. */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const ROLES = ['researcher', 'architect', 'implementer', 'verifier', 'reviewer'];
const WORKFLOWS = ['team-run', 'research', 'implement', 'code-review', 'software-lifecycle-guard'];

function checkConfig(root = ROOT) {
  const failures = [];
  const read = file => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); }
    catch { failures.push(`missing or unreadable: ${file}`); return ''; }
  };
  const instructions = read('.codex/AGENTS.md');
  const config = read('.codex/config.toml');
  read('.codex/scripts/hook.js');
  if (!/developer_instructions\s*=.*\.codex\/AGENTS\.md/.test(config)) failures.push('missing explicit instruction entry');
  for (const event of ['SessionStart', 'Stop']) {
    if (!config.includes(`[[hooks.${event}]]`)) failures.push(`missing ${event} hook`);
  }
  if (!config.includes('.codex/scripts/hook.js')) failures.push('hook path is not inside .codex');
  if (!instructions.includes('docs/manual/codebase-standards.md')) failures.push('missing project standards reference');
  for (const role of ROLES) {
    const content = read(`.codex/roles/${role}.md`);
    if (/subagent_type\s*=|model:\s*(opus|sonnet|fable)/.test(content)) failures.push(`Claude binding in role: ${role}`);
  }
  for (const workflow of WORKFLOWS) {
    const file = `.codex/skills/${workflow}/SKILL.md`;
    const content = read(file);
    if (!instructions.includes(file)) failures.push(`workflow absent from instruction index: ${workflow}`);
    if (!/^---\s*\nname:\s*\S+/m.test(content) || !/^description:\s*.+/m.test(content)) failures.push(`invalid workflow metadata: ${workflow}`);
    if (/subagent_type\s*=|model:\s*(opus|sonnet|fable)/.test(content)) failures.push(`Claude binding in workflow: ${workflow}`);
    for (const match of content.matchAll(/`(\.codex\/roles\/[^`]+\.md)`/g)) read(match[1]);
  }
  return failures;
}

function main() {
  const failures = checkConfig();
  for (const failure of failures) console.error(`codex-config: ${failure}`);
  if (failures.length) return 1;
  console.log('codex-config: instruction entry, 5 roles and 5 indexed workflows passed');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { checkConfig, main };
