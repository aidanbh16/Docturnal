'use strict';

// Action entry point. Comments changed files with the comment model, then updates the docs
// with the docs model, records the state, and pushes docturnal/update.

const fs = require('fs');
const path = require('path');

const { docExists, findChanges } = require('./changes');
const { commentFile } = require('./comments');
const { readConfig, ConfigError } = require('./config');
const { generateDocs, writeDocs } = require('./docs');
const { commitAndPush, listFiles, prepareBranch } = require('./git');
const { readTotalMemory, selectModels } = require('./models');
const { buildReport, proposalSummary } = require('./report');
const { LAST_RUN_PATH, STATE_PATH, hashContent, readState, sameState, writeState } = require('./state');

// Time kept free for the docs after the last file is commented.
const DOCS_RESERVE_MINUTES = 25;

function resolveModels(config) {
  if (config.selectedCommentModel && config.selectedDocsModel) {
    return { comment: config.selectedCommentModel, docs: config.selectedDocsModel };
  }
  const selection = selectModels({ totalMemoryBytes: readTotalMemory(), model: config.model, docsModel: config.docsModel });
  return { comment: selection.commentModel, docs: selection.docsModel };
}

async function run({ cwd = process.cwd(), env = process.env, chat, now = Date.now, log = console.log } = {}) {
  const config = readConfig(env);
  const push = !/^(false|0|no)$/i.test((env.PUSH || 'true').trim());
  const started = now();
  const models = resolveModels(config);
  log(`Docturnal: comment level ${config.commentLevel}, comment model ${models.comment}, docs model ${models.docs}`);

  const branch = prepareBranch(cwd, { base: env.BASE_BRANCH });
  log(`Docturnal: base ${branch.base} (${branch.baseSha.slice(0, 7)}), update branch ${branch.mode}`);

  const previous = readState(cwd);
  const { current, toComment, changedDocsOnly, deleted, docsMissing } = findChanges(cwd, config, previous);

  const files = new Map(Object.entries(previous.files).filter(([file]) => current.has(file)));
  for (const e of changedDocsOnly) files.set(e.path, { hash: e.hash });

  // Phase 1: comments, with the comment model only.
  const commentDeadline = started + Math.max(config.timeBudgetMinutes - DOCS_RESERVE_MINUTES, config.timeBudgetMinutes / 2) * 60000;
  const processed = [];
  const leftOver = [];
  const writtenSources = [];
  for (const entry of toComment) {
    if (now() > commentDeadline) {
      leftOver.push({ path: entry.path, reason: 'time budget' });
      continue;
    }
    const text = entry.buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(entry.buffer)) {
      files.set(entry.path, { hash: entry.hash });
      log(`${entry.path}: skipped, not UTF-8`);
      continue;
    }
    const result = await commentFile({
      path: entry.path,
      text,
      level: config.commentLevel,
      model: models.comment,
      contextTokens: config.contextTokens,
      chat,
    });
    if (result.failedWindows && !result.summary && !result.added) {
      leftOver.push({ path: entry.path, reason: 'the model did not respond' });
      log(`${entry.path}: the model did not respond (${result.errors.join('; ')})`);
      continue;
    }
    let finalBuffer = entry.buffer;
    if (result.text !== text) {
      finalBuffer = Buffer.from(result.text, 'utf8');
      fs.writeFileSync(path.join(cwd, entry.path), finalBuffer);
      writtenSources.push(entry.path);
    }
    if (result.skipped) {
      files.set(entry.path, { hash: hashContent(finalBuffer) });
      log(`${entry.path}: skipped, ${result.skipped}`);
      continue;
    }
    files.set(entry.path, { hash: hashContent(finalBuffer), summary: result.summary, symbols: result.symbols });
    processed.push({ path: entry.path, verifier: entry.language.verifier, added: result.added, rejections: result.rejections, stats: result.stats });
    log(`${entry.path}: ${proposalSummary(result.stats, { reasons: true })}`);
  }

  // Phase 2: docs, with the docs model only.
  const docsDir = config.docsDir;
  const summarized = [...files]
    .filter(([file, entry]) => typeof entry.summary === 'string' && current.get(file).action === 'comment')
    .map(([file, entry]) => ({ path: file, summary: entry.summary, symbols: entry.symbols }));
  const changedFiles = new Set([...processed.map((p) => p.path), ...deleted, ...changedDocsOnly.map((e) => e.path)]);
  const docsNeeded = (summarized.length > 0 || previous.layers.length > 0) &&
    (changedFiles.size > 0 || previous.staleDocs.length > 0 || docsMissing || previous.layers.length === 0);

  let layers = previous.layers;
  let docSlugs = previous.docs;
  let staleDocs = previous.staleDocs;
  const docsReport = { updated: [], removed: [], pending: [] };
  let fallbackUsed = false;
  const writtenDocs = { written: [], deleted: [] };
  if (docsNeeded) {
    const result = await generateDocs({
      files: summarized,
      allFiles: listFiles(cwd),
      root: cwd,
      docsDir,
      model: models.docs,
      fallbackModel: models.comment !== models.docs ? models.comment : null,
      contextTokens: config.contextTokens,
      chat,
      previousLayers: previous.layers,
      changedFiles: previous.layers.length ? changedFiles : null,
      staleSlugs: previous.staleDocs,
      deadline: started + config.timeBudgetMinutes * 60000,
      now,
      projectName: env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split('/').pop() : undefined,
    });
    for (const error of result.errors) log(`Docs: ${error}`);
    const write = writeDocs({ root: cwd, docs: result.docs, removed: result.removed });
    writtenDocs.written = write.written;
    writtenDocs.deleted = write.deleted;
    for (const skipped of [...result.skipped, ...write.skipped]) log(`${skipped.path}: not written, ${skipped.reason}`);

    layers = result.layers;
    docSlugs = layers.map((l) => l.slug).filter((slug) => docExists(cwd, `${docsDir}/${slug}.md`));
    staleDocs = result.pending.map((p) => p.slug);
    fallbackUsed = result.fallbackUsed;
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
    log('Docturnal: nothing changed since the last run.');
    return { changed: false, processed, leftOver };
  }

  next.updatedAt = new Date(now()).toISOString();
  writeState(cwd, next);
  const report = buildReport({
    processed,
    docs: docsReport,
    leftOver,
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
