'use strict';

// The work of a run: summaries for the documentation, and comments for new, changed, and
// backlog files, each checked for accuracy. It reads files but never writes them: it returns
// a result per file, which the finish step applies. A worker in a parallel run does one
// shard of this and uploads its results; a single-job run applies them in the same process.

const fs = require('fs');
const path = require('path');

const { checkComments, finishComments, needsCheck, planComments } = require('./comments');
const { createCaller } = require('./docs');
const ollama = require('./ollama');
const { proposalSummary } = require('./report');
const { hashContent } = require('./state');
const { summarizeFile } = require('./summary');

// Time kept free for the accuracy check and the docs after the last file is commented, and
// how much of it the accuracy check may use.
const DOCS_RESERVE_MINUTES = 25;
const CHECK_MINUTES = 10;
// How long Ollama keeps the docs model loaded after it is loaded ahead of the accuracy check.
const DOCS_MODEL_KEEP_ALIVE = '30m';

function deadlines(started, budgetMinutes) {
  const commentDeadline = started + Math.max(budgetMinutes - DOCS_RESERVE_MINUTES, budgetMinutes / 2) * 60000;
  return { commentDeadline, checkDeadline: commentDeadline + CHECK_MINUTES * 60000, end: started + budgetMinutes * 60000 };
}

// items: [{ path, kind: 'summary' | 'comment', reason }], in the order to work on them.
// Returns { results, docsCaller }, where each result is
//   { path, kind, reason, outcome: 'commented' | 'summarized' | 'skipped' | 'left',
//     originalHash, text (only when the file changes), entry (its new state), report, why }.
async function processItems({ cwd, items, previous, config, models, chat, now = Date.now, started = now(), log = console.log, docsCaller }) {
  const { commentDeadline, checkDeadline } = deadlines(started, config.timeBudgetMinutes);
  const results = [];
  // A file left for the next run keeps its old state, so the next run processes it again.
  const leave = (item, originalHash, why, detail = why) => {
    results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'left', originalHash, why });
    log(`${item.path}: deferred to the next run, ${detail}`);
  };
  const read = (file) => fs.readFileSync(path.join(cwd, file));

  // Summaries first: they are short, and the documentation needs every one.
  for (const item of items.filter((i) => i.kind === 'summary')) {
    const buffer = read(item.path);
    const originalHash = hashContent(buffer);
    if (now() > commentDeadline) {
      leave(item, originalHash, 'time budget');
      continue;
    }
    const before = previous.files[item.path] || {};
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer)) {
      results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'skipped', originalHash, entry: { hash: originalHash, skipped: 'not UTF-8' }, why: 'not UTF-8' });
      continue;
    }
    try {
      const summary = await summarizeFile({ path: item.path, text, model: models.comment, contextTokens: config.contextTokens, chat });
      if (summary.skipped) {
        results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'skipped', originalHash, entry: { hash: originalHash, skipped: summary.skipped }, why: summary.skipped });
        continue;
      }
      // A file whose content is unchanged keeps its comment level and Docturnal's records.
      const same = before.hash === originalHash;
      if (summary.failed) {
        // Recorded so the documentation pass can end; a later change, or a batch, reads it again.
        const entry = { hash: originalHash, level: same ? before.level ?? null : null, summaryFailed: true };
        if (same && before.comments) entry.comments = before.comments;
        results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'skipped', originalHash, entry, why: summary.failed });
        log(`${item.path}: skipped, ${summary.failed}`);
        continue;
      }
      const entry = { hash: originalHash, summary: summary.summary, symbols: summary.symbols, level: same ? before.level ?? null : null };
      if (same && before.comments) entry.comments = before.comments;
      results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'summarized', originalHash, entry });
    } catch (err) {
      leave(item, originalHash, 'the model did not respond', `the model did not respond (${ollama.describeError(err)})`);
    }
  }

  // Comments: 1a proposes with the comment model, new and changed files before the backlog.
  // 1b checks every selected comment for accuracy, with the docs model when the time budget
  // allows (it is loaded next for the docs anyway), otherwise with the comment model.
  // 1c inserts and verifies, without a model.
  const commentItems = items.filter((i) => i.kind === 'comment');
  const ordered = [...commentItems.filter((i) => i.reason !== 'backlog'), ...commentItems.filter((i) => i.reason === 'backlog')];
  const plans = [];
  for (const item of ordered) {
    const buffer = read(item.path);
    const originalHash = hashContent(buffer);
    if (now() > commentDeadline) {
      leave(item, originalHash, 'time budget');
      continue;
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer)) {
      results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'skipped', originalHash, entry: { hash: originalHash, skipped: 'not UTF-8' }, why: 'not UTF-8' });
      log(`${item.path}: skipped, not UTF-8`);
      continue;
    }
    const plan = await planComments({
      path: item.path,
      text,
      level: config.commentLevel,
      model: models.comment,
      contextTokens: config.contextTokens,
      chat,
      records: (previous.files[item.path] || {}).comments || [],
    });
    if (plan.failedWindows && !plan.summary && !(plan.built && plan.built.candidates.length)) {
      leave(item, originalHash, 'the model did not respond', `the model did not respond (${plan.errors.join('; ')})`);
      continue;
    }
    plans.push({ item, originalHash, plan });
  }

  // The docs model checks when the time left before the check deadline is at least the time
  // the proposals took, since it is slower but gets short requests. It is loaded first, with
  // the same context size as every later call, so the check does not start against a cold
  // model and the docs do not reload it. If it cannot load, the caller switches to the
  // comment model for the rest of the run.
  const caller = docsCaller || createCaller({ chat, model: models.docs, fallbackModel: models.comment !== models.docs ? models.comment : null });
  const toCheck = plans.filter(({ plan }) => needsCheck(plan));
  let checkWithDocs = toCheck.length > 0 && models.docs !== models.comment && now() + (now() - started) <= checkDeadline;
  if (checkWithDocs) {
    try {
      await caller.call(`loading ${models.docs}`, { messages: [], options: { num_ctx: config.contextTokens }, keepAlive: DOCS_MODEL_KEEP_ALIVE });
    } catch {
      checkWithDocs = false;
    }
  }
  const checkWith = (model) => (model === models.comment
    ? { chat, model: models.comment, contextTokens: config.contextTokens }
    : { chat: (request) => caller.call('accuracy check', request), contextTokens: config.contextTokens });
  if (toCheck.length) log(`Docturnal: checking comments in ${toCheck.length} files with ${checkWithDocs ? caller.activeModel : models.comment}`);
  for (const { item, originalHash, plan } of plans) {
    if (needsCheck(plan)) {
      if (now() > checkDeadline) {
        leave(item, originalHash, 'time budget');
        continue;
      }
      // A check that fails with the docs model is tried once more with the comment model.
      const checkers = checkWithDocs && caller.activeModel !== models.comment ? [models.docs, models.comment] : [models.comment];
      let passed = false;
      for (const model of checkers) {
        try {
          await checkComments(plan, checkWith(model));
          passed = true;
          break;
        } catch (err) {
          log(`${item.path}: the accuracy check with ${model} failed (${ollama.describeError(err)})`);
        }
      }
      if (!passed) {
        leave(item, originalHash, 'the accuracy check failed', 'accuracy check failed');
        continue;
      }
    }

    const result = finishComments(plan);
    const changed = result.text !== plan.text;
    const finalHash = changed ? hashContent(Buffer.from(result.text, 'utf8')) : originalHash;
    const base = { path: item.path, kind: item.kind, reason: item.reason, originalHash, ...(changed ? { text: result.text } : {}) };
    if (result.skipped) {
      results.push({ ...base, outcome: 'skipped', entry: { hash: finalHash, skipped: result.skipped }, why: result.skipped });
      log(`${item.path}: skipped, ${result.skipped}`);
      continue;
    }
    const entry = { hash: finalHash, summary: result.summary, symbols: result.symbols, level: config.commentLevel };
    if (result.records.length) entry.comments = result.records;
    results.push({
      ...base,
      outcome: 'commented',
      entry,
      report: { path: item.path, verifier: plan.ctx ? plan.ctx.language.verifier : undefined, added: result.added, rejections: result.rejections, stats: result.stats },
    });
    for (const r of result.rejections) {
      if (r.coverage !== undefined) log(`${item.path}: line ${r.line} dropped as restating the code (coverage ${r.coverage.toFixed(2)})`);
    }
    log(`${item.path}: ${proposalSummary(result.stats, { reasons: true })}`);
  }
  return { results, docsCaller: caller };
}

module.exports = { DOCS_RESERVE_MINUTES, deadlines, processItems };
