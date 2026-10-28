'use strict';

// The end of a run: applies the results of the work, merges the state, writes the layer docs
// and the README, writes last-run.md, then commits and pushes docturnal/update. The app opens
// the pull request.

const fs = require('fs');
const path = require('path');

const { docExists, needsComments } = require('./changes');
const { createCaller, docName, generateDocs, writeDocs } = require('./docs');
const { commitAndPush, isPrivateRepository, listFiles, mergedSince } = require('./git');
const { requirePlainPath } = require('./safe-path');
const { updateReadme, writeReadme } = require('./readme');
const { README_RESERVE_MINUTES } = require('./process');
const { buildReport, pullRequestTitle } = require('./report');
const { LAST_RUN_PATH, STATE_PATH, emptyPending, hashContent, sameState, writeState } = require('./state');


async function applyRun({ cwd, config, env, previous, changes, plan, results, folders: newFolders = [], summaryStats, calls, models, chat, docsCaller, now = Date.now, started = now(), log = console.log, push = true }) {
  const { current, changedDocsOnly, deleted, docsMissing, readmeChanged, legacyReadme, ignoreHash } = changes;

  // Apply each changed file, but only onto the content the work started from.
  const writtenSources = [];
  const leftOver = [];
  const applied = [];
  for (const r of results) {
    if (r.outcome === 'left') {
      leftOver.push({ path: r.path, reason: r.why });
      continue;
    }
    const full = path.join(cwd, r.path);
    const hash = hashContent(fs.readFileSync(full));
    if (hash !== r.originalHash) {
      leftOver.push({ path: r.path, reason: 'the file changed during the run' });
      log(`${r.path}: deferred to the next run, the file changed during the run`);
      continue;
    }
    if (typeof r.text === 'string') {
      fs.writeFileSync(full, r.text);
      writtenSources.push(r.path);
    }
    applied.push(r);
  }

  const files = new Map(Object.entries(previous.files).filter(([file]) => current.has(file)));
  for (const e of changedDocsOnly) files.set(e.path, { hash: e.hash });
  for (const r of applied) files.set(r.path, r.entry);
  const processed = applied.filter((r) => r.outcome === 'commented').map((r) => r.report);
  const skipped = applied.filter((r) => r.outcome === 'skipped').map((r) => ({ path: r.path, reason: r.why }));
  const summarizedNow = applied.filter((r) => r.outcome === 'summarized').length;
  // Folder summaries: kept for folders that still have code, replaced by this run's.
  const codeDirs = new Set([...current.values()].filter((e) => e.action === 'comment').map((e) => path.posix.dirname(e.path)));
  const folderSummaries = Object.fromEntries(Object.entries(previous.folders || {}).filter(([dir]) => codeDirs.has(dir)));
  for (const { dir, summary } of newFolders) if (typeof dir === 'string' && typeof summary === 'string' && codeDirs.has(dir)) folderSummaries[dir] = summary;
  // Folders whose files the documentation pass has not read yet: the README says so.
  const waiting = [...new Set(leftOver.filter((l) => plan.items.some((i) => i.path === l.path && i.kind === 'summary')).map((l) => path.posix.dirname(l.path)))].sort();

  // What the open pull request holds after this run. If it was merged while the run was
  // going, what it held is in the base now, and this run starts a new pull request.
  let pendingOpen = plan.pendingOpen;
  if (pendingOpen && plan.updateSha && mergedSince(cwd, plan.updateSha, plan.base)) {
    pendingOpen = false;
    log('Docturnal: the open pull request was merged during the run; this run starts a new one');
  }
  const pending = pendingOpen ? JSON.parse(JSON.stringify(previous.pending)) : emptyPending();
  if (plan.phase === 'docs' && summarizedNow) pending.docs = true;
  for (const r of applied) {
    if (r.outcome === 'commented' && r.reason !== 'backlog' && !pending.changed.includes(r.path)) pending.changed.push(r.path);
  }
  let batchesDone = previous.batchesDone;
  const batchFiles = applied.filter((r) => r.reason === 'backlog').map((r) => r.path);
  if (plan.batch && batchFiles.some((file) => writtenSources.includes(file))) {
    pending.batch = { number: plan.batch.number, layers: plan.batch.layers, files: batchFiles };
    batchesDone = plan.batch.number;
  }
  const docsComplete = plan.phase === 'docs'
    ? !leftOver.some((l) => plan.items.find((i) => i.path === l.path && i.kind === 'summary'))
    : true;

  // Docs, with the docs model.
  const docsDir = config.docsDir;
  const summarized = [...files]
    .filter(([file, entry]) => typeof entry.summary === 'string' && current.get(file).action === 'comment')
    .map(([file, entry]) => ({ path: file, summary: entry.summary, symbols: entry.symbols }));
  // A file in a batch of existing code changed only by its comments, and keeps its summary, so
  // its layer doc needs no rewrite: the run's time goes to comments.
  const onlyCommented = (r) => r.reason === 'backlog' && previous.files[r.path] && previous.files[r.path].summary === r.entry.summary;
  const changedFiles = new Set([...applied.filter((r) => r.outcome !== 'skipped' && !onlyCommented(r)).map((r) => r.path), ...deleted, ...changedDocsOnly.map((e) => e.path)]);
  const docsNeeded = (summarized.length > 0 || previous.layers.length > 0) &&
    (changedFiles.size > 0 || previous.staleDocs.length > 0 || docsMissing || previous.layers.length === 0 || readmeChanged || legacyReadme);

  let layers = previous.layers;
  let docSlugs = previous.docs;
  let staleDocs = previous.staleDocs;
  const docsReport = { updated: [], removed: [], pending: [], readme: null };
  let fallbackUsed = false;
  const writtenDocs = { written: [], deleted: [] };
  let docTimings = { layers: 0, docs: 0 };
  let readmeMs = 0;
  if (docsNeeded) {
    // In a single job, the same caller as the accuracy check, so a docs model that could not
    // load is not tried again.
    const caller = docsCaller || createCaller({ chat, model: models.docs, fallbackModel: models.comment !== models.docs ? models.comment : null });
    // Layer docs stop starting a few minutes before the end, so the README is always written.
    const deadline = started + config.timeBudgetMinutes * 60000;
    const layerDeadline = deadline - README_RESERVE_MINUTES * 60000;
    const allFiles = listFiles(cwd);
    // Web links the repository does not already have, and raw HTML, are dropped; only the
    // count is logged.
    const linkStats = {};
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
      deadline: layerDeadline,
      now,
      projectName: env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split('/').pop() : undefined,
      linkStats,
      folders: new Map(Object.entries(folderSummaries)),
    });
    const write = writeDocs({ root: cwd, docs: result.docs, removed: result.removed });

    // The main document: README.md at the repository root, shared with people.
    const readmeStarted = now();
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
      linkStats,
      waiting,
      available: result.available,
    });
    readmeMs = now() - readmeStarted;
    docTimings = result.timings || docTimings;
    for (const split of result.splits || []) log(`Docturnal: ${split}`);
    if (linkStats.fileListItems) log(`Docturnal: dropped ${linkStats.fileListItems} Responsibilities ${linkStats.fileListItems === 1 ? 'item' : 'items'} that listed file names instead of what the files do`);
    if (linkStats.cutReplies) log(`Docturnal: ${linkStats.cutReplies} ${linkStats.cutReplies === 1 ? 'reply' : 'replies'} for the docs reached the length limit, so each was cut back to its last complete sentence`);
    if (linkStats.repeated) log(`Docturnal: dropped ${linkStats.repeated} ${linkStats.repeated === 1 ? 'sentence' : 'sentences'} that repeated another in the same doc`);
    if (linkStats.purposeItems) log(`Docturnal: dropped ${linkStats.purposeItems} Responsibilities ${linkStats.purposeItems === 1 ? 'item' : 'items'} that only repeated one file's purpose`);
    if (linkStats.droppedTables) log(`Docturnal: dropped ${linkStats.droppedTables} ${linkStats.droppedTables === 1 ? 'table' : 'tables'} the model wrote into the docs`);
    if (linkStats.ungrounded) log(`Docturnal: dropped ${linkStats.ungrounded} ${linkStats.ungrounded === 1 ? 'sentence' : 'sentences'} from the layer docs that their files do not support`);
    if (linkStats.droppedLinks) log(`Docturnal: dropped ${linkStats.droppedLinks} ${linkStats.droppedLinks === 1 ? 'link or HTML tag' : 'links or HTML tags'} from the docs that the repository does not have`);
    if (readme.linked) log('README.md is a symbolic link, so Docturnal leaves it alone.');
    readme.errors.forEach((error) => result.errors.push(error));
    writtenDocs.written.push(...writeReadme(cwd, readme));
    if (readme.pending) result.pending.push({ path: 'README.md', slug: 'README', reason: readme.pending });
    docsReport.readme = readme.report;
    for (const error of result.errors) log(`Docs: ${error}`);
    writtenDocs.written.push(...write.written);
    writtenDocs.deleted = write.deleted;
    for (const s of [...result.skipped, ...write.skipped]) log(`${s.path}: not written, ${s.reason}`);

    layers = result.layers;
    docSlugs = layers.map(docName).filter((name) => docExists(cwd, `${docsDir}/${name}.md`));
    staleDocs = result.pending.map((p) => p.slug);
    fallbackUsed = caller.fallbackUsed;
    docsReport.updated = result.docs.filter((d) => write.written.includes(d.path)).map((d) => ({ path: d.path, fallback: d.fallback }));
    docsReport.removed = write.deleted;
    docsReport.pending = result.pending.map((p) => ({ path: p.path, reason: p.reason }));
  }

  const next = {
    ...previous,
    commentLevel: config.commentLevel,
    ignoreHash,
    docsComplete,
    batchesDone,
    pending,
    files: Object.fromEntries(files),
    layers,
    docs: docSlugs,
    staleDocs,
    folders: folderSummaries,
  };
  // How long each phase took, for tuning on real runners. Counts and times only.
  if (summaryStats && summaryStats.files) {
    const minutes = (ms) => (ms / 60000).toFixed(1);
    log(`Docturnal: benchmark: ${summaryStats.files} source files, ${summaryStats.folders} folders, ${calls ? calls.count : summaryStats.calls} model calls (${summaryStats.calls} for summaries); minutes: summaries ${minutes(summaryStats.ms)}, layers ${minutes(docTimings.layers)}, layer docs ${minutes(docTimings.docs)}, README ${minutes(readmeMs)}, total ${minutes(now() - started)}`);
  }
  // Clearing the record of a pull request that was merged or closed is not a change by
  // itself, nor is recording that an older state's documentation was complete.
  const settled = {
    ...previous,
    pending: pendingOpen ? previous.pending : emptyPending(),
    docsComplete: previous.docsComplete === null && plan.phase === 'normal' ? true : previous.docsComplete,
  };
  if (!writtenSources.length && !writtenDocs.written.length && !writtenDocs.deleted.length && sameState(settled, next)) {
    log(leftOver.length
      ? `Docturnal: nothing to commit this run; ${leftOver.length} ${leftOver.length === 1 ? 'file was' : 'files were'} deferred to the next run.`
      : 'Docturnal: nothing changed since the last run.');
    return { changed: false, processed, leftOver, state: next };
  }

  next.updatedAt = new Date(now()).toISOString();
  writeState(cwd, next);

  // Progress, counted over the code files in scope.
  const codeFiles = [...current.values()].filter((e) => e.action === 'comment').map((e) => e.path);
  const entryOf = (file) => next.files[file];
  const usable = codeFiles.filter((file) => !(entryOf(file) && entryOf(file).skipped));
  const progress = {
    docsComplete,
    summarized: usable.filter((file) => entryOf(file) && typeof entryOf(file).summary === 'string').length,
    documentable: usable.length,
    layers: docSlugs.length,
    docsWaiting: staleDocs.filter((name) => name !== 'README').length,
    level: config.commentLevel,
    commented: usable.filter((file) => entryOf(file) && entryOf(file).level === config.commentLevel).length,
    commentable: usable.length,
    existingCode: config.existingCode,
    pending,
    backlogLeft: usable.filter((file) => !entryOf(file) || needsComments(entryOf(file).level, config.commentLevel))
      .filter((file) => !(pending.batch && pending.batch.files.includes(file))).length,
    nextBatch: batchesDone + 1,
    batchSize: config.backlogBatchSize,
    timeLimit: { minutes: config.timeBudgetMinutes, private: isPrivateRepository(env) },
  };
  const title = pullRequestTitle(pending);
  const report = buildReport({
    processed,
    docs: docsReport,
    leftOver,
    skipped,
    summarized: summarizedNow,
    title,
    progress,
    models: { comment: models.comment, docs: models.docs, fallback: models.comment, fallbackUsed, level: config.commentLevel },
  });
  requirePlainPath(cwd, LAST_RUN_PATH);
  fs.writeFileSync(path.join(cwd, LAST_RUN_PATH), report);

  const commit = commitAndPush(cwd, {
    paths: [...writtenSources, ...writtenDocs.written, ...writtenDocs.deleted, STATE_PATH, LAST_RUN_PATH],
    message: `${title}\n\n${processed.length} files commented, ${summarizedNow} files read, ${docsReport.updated.length} docs updated, ${docsReport.removed.length} docs removed.`,
    push,
    // The branch as the plan saw it: a person's commit on it, or its deletion when its pull
    // request was closed, during the run means this run's work waits for the next one.
    lease: plan.updateSha || null,
  });
  if (commit.rejected) {
    log(`::warning::docturnal/update changed while this run was going, for example a commit was added to it or its pull request was closed, so this run did not push. Its work is done again on the next run.`);
  } else {
    log(commit.committed
      ? `Docturnal: committed ${commit.sha.slice(0, 7)}${commit.pushed ? ' and pushed docturnal/update' : ' (PUSH=false, not pushed)'}`
      : 'Docturnal: nothing to commit.');
  }
  return { changed: commit.committed, processed, leftOver, docs: docsReport, commit, state: next, progress, title };
}

module.exports = { applyRun };
