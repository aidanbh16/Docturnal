'use strict';

// Action entry point. A run has three parts: the plan decides the work (see plan.js), the
// work summarizes and comments files (work.js), and the finish applies the results, writes
// the docs, and pushes docturnal/update (finish.js). The mode input runs all three in one job
// ("all", the default) or one part per job of a parallel run ("plan", "work", "finish"),
// passing the plan and the results between jobs as files.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { findChanges } = require('./changes');
const { readConfig, ConfigError } = require('./config');
const { FinishError, finishRun } = require('./finish');
const { prepareBranch, recentActivity } = require('./git');
const { rankFiles, selectBatch } = require('./importance');
const { readTotalMemory, selectModels } = require('./models');
const ollama = require('./ollama');
const { jobCount, planWork, repositoryIsPrivate, splitShards } = require('./plan');
const { PullRequestError } = require('./pulls');
const { readState } = require('./state');
const { processItems } = require('./work');

// The job's timeout must leave this much time after the time budget, for setup and the commit.
const TIMEOUT_MARGIN_MINUTES = 20;

function resolveModels(config) {
  if (config.selectedCommentModel && config.selectedDocsModel) {
    return { comment: config.selectedCommentModel, docs: config.selectedDocsModel };
  }
  const selection = selectModels({ totalMemoryBytes: readTotalMemory(), model: config.model, docsModel: config.docsModel });
  return { comment: selection.commentModel, docs: selection.docsModel };
}

function planPath(env) {
  return env.DOCTURNAL_PLAN || path.join(env.RUNNER_TEMP || os.tmpdir(), 'docturnal-plan', 'plan.json');
}

function resultsDir(env) {
  return env.DOCTURNAL_RESULTS || path.join(env.RUNNER_TEMP || os.tmpdir(), 'docturnal-results');
}

function writeOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
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

// Prepares the branch and plans the work, for "all" and "plan".
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
  return { branch, previous, changes, plan };
}

async function run({ cwd = process.cwd(), env = process.env, chat: baseChat = ollama.chat, now = Date.now, log = console.log } = {}) {
  const config = readConfig(env);
  const push = !/^(false|0|no)$/i.test((env.PUSH || 'true').trim());
  const started = now();
  if (config.jobTimeoutMinutes && config.timeBudgetMinutes > config.jobTimeoutMinutes - TIMEOUT_MARGIN_MINUTES) {
    log(`::warning::time-budget-minutes (${config.timeBudgetMinutes}) leaves less than ${TIMEOUT_MARGIN_MINUTES} minutes before the job's timeout-minutes (${config.jobTimeoutMinutes}). ` +
      'If the job times out, the run loses its work. Lower time-budget-minutes or raise timeout-minutes.');
  }
  // Every model call is logged with its duration, and the run's time budget is its only limit.
  const chat = ollama.loggedChat(baseChat, { log, now, deadline: started + config.timeBudgetMinutes * 60000 });

  if (config.mode === 'cleanup') return { cleanup: true };

  if (config.mode === 'plan') {
    const { plan } = makePlan({ cwd, env, config, log });
    const jobs = jobCount(plan.items.length, { maxJobs: config.maxJobs, isPrivate: repositoryIsPrivate(env) });
    const shards = splitShards(plan.items, jobs);
    const file = planPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...plan, shards: shards.map((s) => s.map((i) => i.path)) }));
    writeOutputs(env, {
      'has-work': String(plan.hasWork),
      shards: JSON.stringify(shards.map((_, i) => i)),
      'max-parallel': String(Math.max(1, jobs)),
      base: plan.base,
    });
    log(`Docturnal: ${plan.hasWork ? `${plan.items.length} files in ${plural(jobs, 'job')}` : 'nothing to do'}`);
    return { plan, shards };
  }

  const models = resolveModels(config);
  log(`Docturnal: comment level ${config.commentLevel}, comment model ${models.comment}, docs model ${models.docs}`);

  if (config.mode === 'all') {
    const { branch, previous, changes, plan } = makePlan({ cwd, env, config, log });
    if (!plan.hasWork) {
      log(plan.noSource ? 'Docturnal: no source files to document or comment.' : 'Docturnal: nothing changed since the last run.');
      return { changed: false, processed: [], leftOver: [], plan };
    }
    const { results, docsCaller } = await processItems({ cwd, items: plan.items, previous, config, models, chat, now, started, log });
    return finishRun({ cwd, config, env, previous, changes, plan, results, models, chat, docsCaller, now, started, log, push, branch });
  }

  // "work" and "finish" rebuild exactly the tree the plan saw.
  const plan = JSON.parse(fs.readFileSync(planPath(env), 'utf8'));
  const branch = prepareBranch(cwd, { base: plan.base, baseSha: plan.baseSha, updateSha: plan.updateSha });
  const previous = readState(cwd);

  if (config.mode === 'work') {
    const paths = plan.shards[config.shard];
    if (!paths) throw new ConfigError(`The plan has no shard ${config.shard}.`);
    const items = paths.map((p) => plan.items.find((i) => i.path === p));
    log(`Docturnal: shard ${config.shard} of ${plan.shards.length}, ${items.length} files`);
    const { results } = await processItems({ cwd, items, previous, config, models, chat, now, started, log });
    const dir = resultsDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `shard-${config.shard}.json`), JSON.stringify({ shard: config.shard, results }));
    return { results };
  }

  // finish: the results of every work job that finished are applied. A job that failed, or
  // ran out of time, uploaded nothing; its files wait for the next run.
  const results = [];
  for (let s = 0; s < plan.shards.length; s++) {
    const file = path.join(resultsDir(env), `shard-${s}.json`);
    if (fs.existsSync(file)) {
      results.push(...JSON.parse(fs.readFileSync(file, 'utf8')).results);
      continue;
    }
    log(`::warning::The work job for shard ${s} did not finish, so its ${plural(plan.shards[s].length, 'file')} wait for the next run.`);
    for (const p of plan.shards[s]) {
      const item = plan.items.find((i) => i.path === p);
      results.push({ path: p, kind: item.kind, reason: item.reason, outcome: 'left', why: 'its work job did not finish' });
    }
  }
  const changes = findChanges(cwd, config, previous);
  return finishRun({ cwd, config, env, previous, changes, plan, results, models, chat, now, started, log, push, branch });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

if (require.main === module) {
  run().catch((err) => {
    const plain = err instanceof ConfigError || err instanceof PullRequestError || err instanceof FinishError;
    console.error(`::error::${plain ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { TIMEOUT_MARGIN_MINUTES, run };
