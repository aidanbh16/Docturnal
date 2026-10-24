'use strict';

// Action entry point. Comments changed files with the comment model, checks the comments for
// accuracy, then updates the docs with the docs model, records the state, and pushes
// docturnal/update.

const fs = require('fs');
const path = require('path');

const { docExists, findChanges } = require('./changes');
const { checkComments, finishComments, needsCheck, planComments } = require('./comments');
const { readConfig, ConfigError } = require('./config');
const { createCaller, generateDocs, writeDocs } = require('./docs');
const { commitAndPush, listFiles, prepareBranch } = require('./git');
const { readTotalMemory, selectModels } = require('./models');
const ollama = require('./ollama');
const { updateReadme, writeReadme } = require('./readme');
const { buildReport, proposalSummary } = require('./report');
const { LAST_RUN_PATH, STATE_PATH, hashContent, readState, sameState, writeState } = require('./state');

// Time kept free for the accuracy check and the docs after the last file is commented, and
// how much of it the accuracy check may use.
const DOCS_RESERVE_MINUTES = 25;
const CHECK_MINUTES = 10;

// How long Ollama keeps the docs model loaded after it is loaded ahead of the accuracy check.
const DOCS_MODEL_KEEP_ALIVE = '30m';

function resolveModels(config) {
  if (config.selectedCommentModel && config.selectedDocsModel) {
    return { comment: config.selectedCommentModel, docs: config.selectedDocsModel };
  }
  const selection = selectModels({ totalMemoryBytes: readTotalMemory(), model: config.model, docsModel: config.docsModel });
  return { comment: selection.commentModel, docs: selection.docsModel };
}

async function run({ cwd = process.cwd(), env = process.env, chat: baseChat = ollama.chat, now = Date.now, log = console.log } = {}) {
  const config = readConfig(env);
  const push = !/^(false|0|no)$/i.test((env.PUSH || 'true').trim());
  const started = now();
  // Every model call is logged with its duration, and the run's time budget is its only limit.
  const chat = ollama.loggedChat(baseChat, { log, now, deadline: started + config.timeBudgetMinutes * 60000 });
  const models = resolveModels(config);
  log(`Docturnal: comment level ${config.commentLevel}, comment model ${models.comment}, docs model ${models.docs}`);

  const branch = prepareBranch(cwd, { base: env.BASE_BRANCH });
  log(`Docturnal: base ${branch.base} (${branch.baseSha.slice(0, 7)}), update branch ${branch.mode}`);

  const previous = readState(cwd);
  const { current, toComment, changedDocsOnly, deleted, docsMissing, readmeChanged, legacyReadme } = findChanges(cwd, config, previous);

  const files = new Map(Object.entries(previous.files).filter(([file]) => current.has(file)));
  for (const e of changedDocsOnly) files.set(e.path, { hash: e.hash });

  // Phase 1: comments. 1a proposes with the comment model. 1b checks every selected comment
  // for accuracy, with the docs model when the time budget allows (it is loaded next for the
  // docs anyway), otherwise with the comment model. 1c inserts and verifies, without a model.
  const commentDeadline = started + Math.max(config.timeBudgetMinutes - DOCS_RESERVE_MINUTES, config.timeBudgetMinutes / 2) * 60000;
  const checkDeadline = commentDeadline + CHECK_MINUTES * 60000;
  const processed = [];
  const leftOver = [];
  const writtenSources = [];
  // Files that were not commented, with the reason, for the log and last-run.md.
  const skipped = [];
  const plans = [];
  // A file left for the next run keeps its old state, so the next run processes it again.
  const defer = (file, reason, detail = reason) => {
    leftOver.push({ path: file, reason });
    log(`${file}: deferred to the next run, ${detail}`);
  };
  for (const entry of toComment) {
    if (now() > commentDeadline) {
      defer(entry.path, 'time budget');
      continue;
    }
    const text = entry.buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(entry.buffer)) {
      files.set(entry.path, { hash: entry.hash });
      skipped.push({ path: entry.path, reason: 'not UTF-8' });
      log(`${entry.path}: skipped, not UTF-8`);
      continue;
    }
    const plan = await planComments({
      path: entry.path,
      text,
      level: config.commentLevel,
      model: models.comment,
      contextTokens: config.contextTokens,
      chat,
      records: (previous.files[entry.path] || {}).comments || [],
    });
    if (plan.failedWindows && !plan.summary && !(plan.built && plan.built.candidates.length)) {
      defer(entry.path, 'the model did not respond', `the model did not respond (${plan.errors.join('; ')})`);
      continue;
    }
    plans.push({ entry, plan });
  }

  // The docs model checks when the time left before the check deadline is at least the time
  // the proposals took, since it is slower but gets short requests. It is loaded first, with
  // the same context size as every later call, so the check does not start against a cold
  // model and the docs do not reload it. If it cannot load, the caller switches to the
  // comment model for the rest of the run.
  const toCheck = plans.filter(({ plan }) => needsCheck(plan));
  const docsCaller = createCaller({ chat, model: models.docs, fallbackModel: models.comment !== models.docs ? models.comment : null });
  let checkWithDocs = toCheck.length > 0 && models.docs !== models.comment && now() + (now() - started) <= checkDeadline;
  if (checkWithDocs) {
    try {
      await docsCaller.call(`loading ${models.docs}`, { messages: [], options: { num_ctx: config.contextTokens }, keepAlive: DOCS_MODEL_KEEP_ALIVE });
    } catch {
      checkWithDocs = false;
    }
  }
  const checkWith = (model) => (model === models.comment
    ? { chat, model: models.comment, contextTokens: config.contextTokens }
    : { chat: (request) => docsCaller.call(`accuracy check`, request), contextTokens: config.contextTokens });
  const firstChecker = checkWithDocs ? docsCaller.activeModel : models.comment;
  if (toCheck.length) log(`Docturnal: checking comments in ${toCheck.length} files with ${firstChecker}`);
  const checked = [];
  for (const item of plans) {
    const { entry, plan } = item;
    if (needsCheck(plan)) {
      if (now() > checkDeadline) {
        defer(entry.path, 'time budget');
        continue;
      }
      // A check that fails with the docs model is tried once more with the comment model.
      const checkers = checkWithDocs && docsCaller.activeModel !== models.comment ? [models.docs, models.comment] : [models.comment];
      let passed = false;
      for (const model of checkers) {
        try {
          await checkComments(plan, checkWith(model));
          passed = true;
          break;
        } catch (err) {
          log(`${entry.path}: the accuracy check with ${model} failed (${ollama.describeError(err)})`);
        }
      }
      if (!passed) {
        defer(entry.path, 'the accuracy check failed', 'accuracy check failed');
        continue;
      }
    }
    checked.push(item);
  }

  for (const { entry, plan } of checked) {
    const result = finishComments(plan);
    let finalBuffer = entry.buffer;
    if (result.text !== plan.text) {
      finalBuffer = Buffer.from(result.text, 'utf8');
      fs.writeFileSync(path.join(cwd, entry.path), finalBuffer);
      writtenSources.push(entry.path);
    }
    if (result.skipped) {
      files.set(entry.path, { hash: hashContent(finalBuffer) });
      skipped.push({ path: entry.path, reason: result.skipped });
      log(`${entry.path}: skipped, ${result.skipped}`);
      continue;
    }
    const fileState = { hash: hashContent(finalBuffer), summary: result.summary, symbols: result.symbols };
    if (result.records.length) fileState.comments = result.records;
    files.set(entry.path, fileState);
    processed.push({ path: entry.path, verifier: entry.language.verifier, added: result.added, rejections: result.rejections, stats: result.stats });
    for (const r of result.rejections) {
      if (r.coverage !== undefined) log(`${entry.path}: line ${r.line} dropped as restating the code (coverage ${r.coverage.toFixed(2)})`);
    }
    log(`${entry.path}: ${proposalSummary(result.stats, { reasons: true })}`);
  }

  // Phase 2: docs, with the docs model only.
  const docsDir = config.docsDir;
  const summarized = [...files]
    .filter(([file, entry]) => typeof entry.summary === 'string' && current.get(file).action === 'comment')
    .map(([file, entry]) => ({ path: file, summary: entry.summary, symbols: entry.symbols }));
  const changedFiles = new Set([...processed.map((p) => p.path), ...deleted, ...changedDocsOnly.map((e) => e.path)]);
  const docsNeeded = (summarized.length > 0 || previous.layers.length > 0) &&
    (changedFiles.size > 0 || previous.staleDocs.length > 0 || docsMissing || previous.layers.length === 0 || readmeChanged || legacyReadme);

  let layers = previous.layers;
  let docSlugs = previous.docs;
  let staleDocs = previous.staleDocs;
  const docsReport = { updated: [], removed: [], pending: [], readme: null };
  let fallbackUsed = false;
  const writtenDocs = { written: [], deleted: [] };
  if (docsNeeded) {
    // The same caller as the accuracy check, so a docs model that could not load is not tried again.
    const caller = docsCaller;
    const deadline = started + config.timeBudgetMinutes * 60000;
    const allFiles = listFiles(cwd);
    const result = await generateDocs({
      files: summarized,
      allFiles,
      root: cwd,
      docsDir,
      contextTokens: config.contextTokens,
      caller,
      previousLayers: previous.layers,
      changedFiles: previous.layers.length ? changedFiles : null,
      staleSlugs: previous.staleDocs,
      deadline,
      now,
      projectName: env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split('/').pop() : undefined,
    });
    const write = writeDocs({ root: cwd, docs: result.docs, removed: result.removed });

    // The main document: README.md at the repository root, shared with people.
    const readme = await updateReadme({
      root: cwd,
      caller,
      layers: result.layers,
      facts: result.facts,
      projectName: result.projectName,
      docsDir,
      allFiles,
      regenerate: result.readmeNeeded,
      contextTokens: config.contextTokens,
      deadline,
      now,
    });
    readme.errors.forEach((error) => result.errors.push(error));
    writtenDocs.written.push(...writeReadme(cwd, readme));
    if (readme.pending) result.pending.push({ path: 'README.md', slug: 'README', reason: readme.pending });
    docsReport.readme = readme.report;
    for (const error of result.errors) log(`Docs: ${error}`);
    writtenDocs.written.push(...write.written);
    writtenDocs.deleted = write.deleted;
    for (const skipped of [...result.skipped, ...write.skipped]) log(`${skipped.path}: not written, ${skipped.reason}`);

    layers = result.layers;
    docSlugs = layers.map((l) => l.slug).filter((slug) => docExists(cwd, `${docsDir}/${slug}.md`));
    staleDocs = result.pending.map((p) => p.slug);
    fallbackUsed = caller.fallbackUsed;
    docsReport.updated = result.docs.filter((d) => write.written.includes(d.path)).map((d) => ({ path: d.path, fallback: d.fallback }));
    docsReport.removed = write.deleted;
    docsReport.pending = result.pending.map((p) => ({ path: p.path, reason: p.reason }));
  }

  const next = {
    ...previous,
    commentLevel: config.commentLevel,
    files: Object.fromEntries(files),
    layers,
    docs: docSlugs,
    staleDocs,
  };
  if (!writtenSources.length && !writtenDocs.written.length && !writtenDocs.deleted.length && sameState(previous, next)) {
    log(leftOver.length
      ? `Docturnal: nothing to commit this run; ${leftOver.length} ${leftOver.length === 1 ? 'file was' : 'files were'} deferred to the next run.`
      : 'Docturnal: nothing changed since the last run.');
    return { changed: false, processed, leftOver };
  }

  next.updatedAt = new Date(now()).toISOString();
  writeState(cwd, next);
  const report = buildReport({
    processed,
    docs: docsReport,
    leftOver,
    skipped,
    models: { comment: models.comment, docs: models.docs, fallback: models.comment, fallbackUsed, level: config.commentLevel },
  });
  fs.writeFileSync(path.join(cwd, LAST_RUN_PATH), report);

  const commit = commitAndPush(cwd, {
    paths: [...writtenSources, ...writtenDocs.written, ...writtenDocs.deleted, STATE_PATH, LAST_RUN_PATH],
    message: `Docturnal: update comments and docs\n\n${processed.length} files processed, ${docsReport.updated.length} docs updated, ${docsReport.removed.length} docs removed.`,
    push,
  });
  log(commit.committed
    ? `Docturnal: committed ${commit.sha.slice(0, 7)}${commit.pushed ? ' and pushed docturnal/update' : ' (PUSH=false, not pushed)'}`
    : 'Docturnal: nothing to commit.');
  return { changed: commit.committed, processed, leftOver, docs: docsReport, commit };
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`::error::${err instanceof ConfigError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
