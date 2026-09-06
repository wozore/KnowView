/**
 * Validate the versioned Codex/Claude project configuration.
 * This check intentionally avoids reading .env or user-level configuration.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_ROLES = ['researcher', 'architect', 'implementer', 'verifier', 'reviewer'];
const REQUIRED_SKILLS = ['team-run', 'research', 'implement', 'code-review', 'software-lifecycle-guard'];

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function assertCondition(condition, message, failures) {
  if (!condition) failures.push(message);
}

function main() {
  const failures = [];
  assertCondition(exists('AGENTS.md'), 'missing AGENTS.md', failures);
  assertCondition(exists('.claude/CLAUDE.md'), 'missing .claude/CLAUDE.md adapter', failures);
  assertCondition(exists('.codex/config.toml'), 'missing .codex/config.toml', failures);
  assertCondition(exists('scripts/codex-hook.js'), 'missing Codex hook runner', failures);

  if (exists('AGENTS.md')) {
    const agents = read('AGENTS.md');
    assertCondition(agents.includes('.agents/roles/'), 'AGENTS.md does not reference shared roles', failures);
    assertCondition(agents.includes('.agents/skills/'), 'AGENTS.md does not reference project skills', failures);
  }
  if (exists('.claude/CLAUDE.md')) {
    assertCondition(read('.claude/CLAUDE.md').includes('AGENTS.md'), 'Claude adapter does not reference AGENTS.md', failures);
  }
  if (exists('.codex/config.toml')) {
    const config = read('.codex/config.toml');
    assertCondition(config.includes('[[hooks.SessionStart]]'), 'Codex config lacks SessionStart hook', failures);
    assertCondition(config.includes('[[hooks.Stop]]'), 'Codex config lacks Stop hook', failures);
    assertCondition(config.includes('scripts/codex-hook.js'), 'Codex config does not reference hook runner', failures);
  }

  for (const role of REQUIRED_ROLES) {
    assertCondition(exists(`.agents/roles/${role}.md`), `missing shared role: ${role}`, failures);
  }
  for (const skill of REQUIRED_SKILLS) {
    const relativePath = `.agents/skills/${skill}/SKILL.md`;
    assertCondition(exists(relativePath), `missing Codex skill: ${skill}`, failures);
    if (exists(relativePath)) {
      const content = read(relativePath);
      assertCondition(/^---\s*\nname:\s*\S+/m.test(content), `skill has no name frontmatter: ${skill}`, failures);
      assertCondition(/^description:\s*.+/m.test(content), `skill has no description frontmatter: ${skill}`, failures);
      assertCondition(!/subagent_type\s*=|model:\s*(opus|sonnet|fable)/.test(content), `skill retains Claude model bindings: ${skill}`, failures);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`agent-config: ${failure}`);
    return 1;
  }
  console.log(`agent-config: ${REQUIRED_ROLES.length} roles and ${REQUIRED_SKILLS.length} skills are wired`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
