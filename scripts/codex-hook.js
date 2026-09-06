/**
 * Small, fail-open Codex project hook.
 *
 * SessionStart checks the versioned agent configuration. Stop checks patch
 * whitespace. Neither hook reads credentials, edits files, or blocks work.
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
    const result = run(process.execPath, [path.join(root, 'scripts', 'check-agent-config.js')], root);
    if (result.status === 0) return emit('Project agent configuration check passed.');
    const detail = (result.stderr || result.stdout || 'unknown configuration check failure').trim().slice(0, 1200);
    return emit(`Project agent configuration check needs attention: ${detail}`);
  }
  if (event.hook_event_name === 'Stop') {
    const result = run('git', ['diff', '--check', '--'], root);
    if (result.status === 0) return emit('Patch whitespace check passed.');
    const detail = (result.stdout || result.stderr || 'git diff --check failed').trim().slice(0, 1200);
    return emit(`Patch whitespace check needs attention: ${detail}`);
  }
  return emit('Project hook completed.');
}

if (require.main === module) main();
module.exports = { main };
