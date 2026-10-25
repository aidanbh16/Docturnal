'use strict';

// Action entry point. A run decides the work (planWork in changes.js), summarizes and
// comments files (process.js), and applies the results, writes the docs, and pushes
// docturnal/update (apply.js).

const fs = require('fs');
const path = require('path');

const { applyRun } = require('./apply');
const { findChanges, planWork } = require('./changes');
const { readConfig, ConfigError } = require('./config');
const { BaseBranchError, prepareBranch, recentActivity } = require('./git');
const { rankFiles, selectBatch } = require('./importance');
const { forgetKnownUrls } = require('./links');
const { readTotalMemory, selectModels } = require('./models');
const ollama = require('./ollama');
const { processItems } = require('./process');
const { LinkError } = require('./safe-path');
const { readState } = require('./state');

// The job's timeout must leave this much time after the time budget, for setup and the commit.
const TIMEOUT_MARGIN_MINUTES = 20;

function resolveModels(config) {
  if (config.selectedCommentModel && config.selectedDocsModel) {
    return { comment: config.selectedCommentModel, docs: config.selectedDocsModel };
  }
  const selection = selectModels({ totalMemoryBytes: readTotalMemory(), model: config.model, docsModel: config.docsModel });
  return { comment: selection.commentModel, docs: selection.docsModel };
}

// Orders backlog files by importance and picks one batch (see importance.js).
function backlogRanker(cwd, config, previous, changes) {
  return (backlog) => {
    const codeFiles = changes.entries.filter((e) => e.action === 'comment').map((e) => e.path);
    let packageJson = null;
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    } catch {
      // No package.json, or one that is not JSON.
    }
    const ranked = rankFiles({
      files: backlog,
      allFiles: codeFiles,
      readText: (file) => (changes.current.get(file) ? changes.current.get(file).buffer.toString('utf8') : ''),
      packageJson,
      activity: recentActivity(cwd),
    });
    return selectBatch(ranked, previous.layers, config.backlogBatchSize);
  };
}

// Prepares the branch and plans the work.
function makePlan({ cwd, env, config, log }) {
  const branch = prepareBranch(cwd, { base: env.BASE_BRANCH });
  log(`Docturnal: base ${branch.base} (${branch.baseSha.slice(0, 7)}), update branch ${branch.mode}`);
  const previous = readState(cwd);
  const changes = findChanges(cwd, config, previous);
  const plan = planWork({ config, previous, changes, branch, rank: backlogRanker(cwd, config, previous, changes) });
  const counts = (reason) => plan.items.filter((i) => i.reason === reason).length;
  log(plan.phase === 'docs'
    ? `Docturnal: documentation pass, ${plan.items.length} files to read`
    : `Docturnal: ${counts('new') + counts('changed')} new or changed files${plan.batch ? `, batch ${plan.batch.number} of existing code with ${plan.batch.files.length} files` : ''}`);
  return { previous, changes, plan };
}

async function run({ cwd = process.cwd(), env = process.env, chat: baseChat = ollama.chat, now = Date.now, log = console.log } = {}) {
  const config = readConfig(env);
  // The URLs the repository has are read afresh for each run.
  forgetKnownUrls(cwd);
  const push = !/^(false|0|no)$/i.test((env.PUSH || 'true').trim());
  const started = now();
  if (config.jobTimeoutMinutes && config.timeBudgetMinutes > config.jobTimeoutMinutes - TIMEOUT_MARGIN_MINUTES) {
    log(`::warning::time-budget-minutes (${config.timeBudgetMinutes}) leaves less than ${TIMEOUT_MARGIN_MINUTES} minutes before the job's timeout-minutes (${config.jobTimeoutMinutes}). ` +
      'If the job times out, the run loses its work. Lower time-budget-minutes or raise timeout-minutes.');
  }
  // Every model call is logged with its duration, and the run's time budget is its only limit.
  const logged = ollama.loggedChat(baseChat, { log, now, deadline: started + config.timeBudgetMinutes * 60000 });
  // Counted for the benchmark line.
  const calls = { count: 0 };
  const chat = (request) => {
    calls.count++;
    return logged(request);
  };

  const models = resolveModels(config);
  log(`Docturnal: comment level ${config.commentLevel}, comment model ${models.comment}, docs model ${models.docs}`);

  const { previous, changes, plan } = makePlan({ cwd, env, config, log });
  if (!plan.hasWork) {
    log(plan.foreign ? 'Docturnal: docturnal/update has commits from someone other than Docturnal, so Docturnal does not add to it until its pull request is merged or closed.' : plan.noSource ? 'Docturnal: no source files to document or comment.' : 'Docturnal: nothing changed since the last run.');
    return { changed: false, processed: [], leftOver: [], plan };
  }
  const { results, docsCaller, folders, summaryStats } = await processItems({ cwd, items: plan.items, previous, config, models, chat, now, started, log });
  return applyRun({ cwd, config, env, previous, changes, plan, results, folders, summaryStats, calls, models, chat, docsCaller, now, started, log, push });
}

if (require.main === module) {
  run().catch((err) => {
    const plain = err instanceof ConfigError || err instanceof BaseBranchError || err instanceof LinkError;
    console.error(`::error::${plain ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { TIMEOUT_MARGIN_MINUTES, run };
