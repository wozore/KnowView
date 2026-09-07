/**
 * Small, fail-open Codex project hook.
 *
 * SessionStart checks the versioned agent configuration. Stop checks patch
 * document policy and staged/unstaged whitespace. Neither hook edits files or blocks work.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function readEvent() {
  try {
    const input = fs.readFileSync(0, 'utf8').trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

function gitRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return cwd;
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
}

function emit(message) {
  process.stdout.write(JSON.stringify({ continue: true, systemMessage: message }) + '\n');
}

function main() {
  const event = readEvent();
  const root = gitRoot(event.cwd || process.cwd());
  if (event.hook_event_name === 'SessionStart') {
    const result = run(process.execPath, [path.join(root, '.codex', 'scripts', 'check-config.js')], root);
    if (result.status === 0) return emit('Project agent configuration check passed.');
    const detail = (result.stderr || result.stdout || 'unknown configuration check failure').trim().slice(0, 1200);
    return emit(`Project agent configuration check needs attention: ${detail}`);
  }
  if (event.hook_event_name === 'Stop') {
    const checks = [
      ['document policy', process.execPath, [path.join(root, 'scripts', 'check-document-policy.js')]],
      ['unstaged whitespace', 'git', ['diff', '--check', '--']],
      ['staged whitespace', 'git', ['diff', '--cached', '--check', '--']],
    ];
    const failures = checks.flatMap(([label, command, args]) => {
      const result = run(command, args, root);
      return result.status === 0 ? [] : [`${label}: ${(result.stdout || result.stderr || result.error?.message || 'check failed').trim().slice(0, 1200)}`];
    });
    return emit(failures.length ? `Project checks need attention: ${failures.join('\n')}` : 'Document policy and staged/unstaged whitespace checks passed.');
  }
  return emit('Project hook completed.');
}

if (require.main === module) main();
module.exports = { main };
