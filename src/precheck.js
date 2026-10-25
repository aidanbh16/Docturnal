'use strict';

// The pre-check, run before models are selected or Ollama is installed. It sets up the
// branch the way main.js does, then compares the in-scope files with .docturnal/state.json.
// It writes changed=true or changed=false, plus the base branch, to $GITHUB_OUTPUT; the later
// steps run only when changed is true. It uses Node built-ins only, so it runs before
// npm install.

const fs = require('fs');

const { docsDone, findChanges, nothingToCover, openPending } = require('./changes');
const { readConfig, ConfigError } = require('./config');
const { BaseBranchError, prepareBranch } = require('./git');
const { LinkError } = require('./safe-path');
const { readState } = require('./state');

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Returns { changed, base, reasons }.
function precheck({ cwd = process.cwd(), env = process.env, log = console.log } = {}) {
  const config = readConfig(env);
  const branch = prepareBranch(cwd, { base: env.BASE_BRANCH });
  if (branch.mode === 'foreign') {
    log(`docturnal/update has commits from someone other than Docturnal, so Docturnal does not add to it until its pull request is merged or closed.`);
    return { changed: false, base: branch.base, reasons: [] };
  }
  const previous = readState(cwd);
  const changes = findChanges(cwd, config, previous);

  const reasons = [];
  if (nothingToCover(previous, changes.entries)) {
    log('No source files to document or comment');
    return { changed: false, base: branch.base, reasons: [] };
  }
  const documented = docsDone(previous, changes.entries);
  if (previous.commentLevel === null) reasons.push('first run');
  else if (!documented) reasons.push('the documentation is not complete yet');
  const changedFiles = changes.toComment.length + changes.changedDocsOnly.length;
  if (changedFiles) reasons.push(`${plural(changedFiles, 'file')} new or changed`);
  // Existing code waits for a batch while no batch is open in an unmerged pull request.
  const batchOpen = Boolean(openPending(branch, previous).batch);
  if (documented && config.existingCode === 'gradual' && changes.backlog.length && !batchOpen) {
    reasons.push(`${plural(changes.backlog.length, 'file')} of existing code to comment`);
  }
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
    const plain = err instanceof ConfigError || err instanceof BaseBranchError || err instanceof LinkError;
    console.error(`::error::${plain ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { precheck };
