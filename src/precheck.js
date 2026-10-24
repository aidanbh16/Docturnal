'use strict';

// The pre-check, run before models are selected or Ollama is installed. It sets up the
// branch the way main.js does, then compares the in-scope files with .docturnal/state.json.
// It writes changed=true or changed=false, plus the base branch, to $GITHUB_OUTPUT; the later
// steps run only when changed is true. It uses Node built-ins only, so it runs before
// npm install.

const fs = require('fs');

const { findChanges } = require('./changes');
const { readConfig, ConfigError } = require('./config');
const { prepareBranch } = require('./git');
const { readState } = require('./state');

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Returns { changed, base, reasons }.
function precheck({ cwd = process.cwd(), env = process.env, log = console.log } = {}) {
  const config = readConfig(env);
  const branch = prepareBranch(cwd, { base: env.BASE_BRANCH });
  const previous = readState(cwd);
  const changes = findChanges(cwd, config, previous);

  const reasons = [];
  if (previous.commentLevel === null) reasons.push('first run');
  else if (changes.levelChanged) reasons.push(`comment level changed to ${config.commentLevel}`);
  const changedFiles = changes.toComment.length + changes.changedDocsOnly.length;
  if (changedFiles && !changes.levelChanged) reasons.push(`${plural(changedFiles, 'file')} new or changed`);
  if (changes.deleted.length) reasons.push(`${plural(changes.deleted.length, 'file')} deleted`);
  if (changes.docsMissing) reasons.push('a generated doc is missing');
  if (changes.readmeChanged && previous.commentLevel !== null) reasons.push('README.md changed');
  if (changes.legacyReadme) reasons.push('docs/README.md moves to README.md');
  if (changes.ignoreChanged) reasons.push('.docturnalignore changed');
  if (previous.staleDocs.length) reasons.push(`${plural(previous.staleDocs.length, 'doc')} left from the last run`);

  const changed = reasons.length > 0;
  log(changed
    ? `Docturnal: ${reasons.join(', ')} (base ${branch.base}, update branch ${branch.mode}).`
    : 'No changes since the last run');
  return { changed, base: branch.base, reasons };
}

function writeOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (require.main === module) {
  try {
    const result = precheck();
    writeOutputs(process.env, { changed: String(result.changed), base: result.base });
  } catch (err) {
    console.error(`::error::${err instanceof ConfigError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { precheck };
