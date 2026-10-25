'use strict';

// Collects the in-scope files, hashes them, compares them with the state from the last run,
// and decides what the run does, before any model is loaded:
// - Until the documentation is complete (a first run), every file gets a summary and no
//   comments, so the first pull request documents the whole project.
// - After that, new and changed files are commented first. Then, if "Existing code" is
//   "gradual" and no batch is waiting in an open pull request, one batch of existing files,
//   ordered by importance.
// Used by main.js and by the pre-check, so it must not load typescript or call a model.

const fs = require('fs');
const path = require('path');

const { hasMarker } = require('./docs');
const { IGNORE_FILE, listFiles } = require('./git');
const { classifyFile, MAX_FILE_BYTES } = require('./languages');
const { readReadmeState, readmeIsPlain } = require('./readme');
const { isPlainPath } = require('./safe-path');
const { emptyPending, hashContent } = require('./state');

function readCandidates(cwd, config) {
  const scope = config.path === '.' ? '' : `${config.path.replace(/\/$/, '')}/`;
  const entries = [];
  for (const file of listFiles(cwd)) {
    if (scope && !file.startsWith(scope)) continue;
    const full = path.join(cwd, file);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const options = { docsDir: config.docsDir, exclude: config.exclude, extensions: config.extensions, size: stat.size };
    if (stat.size > MAX_FILE_BYTES || classifyFile(file, options).action === 'skip') continue;
    const buffer = fs.readFileSync(full);
    // A Git LFS pointer stands in for a file stored elsewhere; its text is not the code.
    if (buffer.length < 1024 && buffer.toString('utf8').startsWith('version https://git-lfs.github.com/spec/')) continue;
    const classified = classifyFile(file, { ...options, sample: buffer });
    if (classified.action === 'skip') continue;
    entries.push({ path: file, action: classified.action, language: classified.language, buffer, hash: hashContent(buffer) });
  }
  return entries;
}

// A hash of .docturnalignore, or null when the repository has none.
function ignoreHash(cwd) {
  try {
    return hashContent(fs.readFileSync(path.join(cwd, IGNORE_FILE)));
  } catch {
    return null;
  }
}

function docExists(cwd, docPath) {
  if (!isPlainPath(cwd, docPath)) return true;
  try {
    return hasMarker(fs.readFileSync(path.join(cwd, docPath), 'utf8'));
  } catch {
    return false;
  }
}

// Whether a file commented at `level` (null: never commented) needs a pass at `current`.
// At level off, only files with Docturnal's comments need one, to take them out.
function needsComments(level, current) {
  if (current === 'off') return level !== null && level !== undefined && level !== 'off';
  return level !== current;
}

// Compares the working tree with the previous state.
// - toComment: new files, and files whose hash differs from the state. They come first.
// - backlog: files that are otherwise up to date but not yet commented at the current level,
//   such as existing code after the first run, or every file after a change of level. They
//   are commented in small batches. Files that cannot be commented (skipped) are not in it.
function findChanges(cwd, config, previous) {
  const entries = readCandidates(cwd, config);
  const current = new Map(entries.map((e) => [e.path, e]));
  const levelChanged = previous.commentLevel !== null && previous.commentLevel !== config.commentLevel;
  const toComment = entries.filter((e) => e.action === 'comment' &&
    (!previous.files[e.path] || previous.files[e.path].hash !== e.hash));
  const backlog = entries.filter((e) => {
    const entry = previous.files[e.path];
    return e.action === 'comment' && entry && entry.hash === e.hash && !entry.skipped && needsComments(entry.level, config.commentLevel);
  });
  const changedDocsOnly = entries.filter((e) => e.action === 'docs' && (!previous.files[e.path] || previous.files[e.path].hash !== e.hash));
  const deleted = Object.keys(previous.files).filter((file) => !current.has(file));
  // A generated doc is missing when a recorded layer doc is gone, or when files were
  // summarized but no docs were ever written for them.
  const summarized = Object.values(previous.files).some((entry) => typeof entry.summary === 'string');
  const docsMissing = previous.docs.some((slug) => !docExists(cwd, `${config.docsDir}/${slug}.md`)) ||
    (previous.layers.length === 0 && summarized);
  // README.md is set up once for a state from before Docturnal saved it. A person's edits to it
  // are not a change: their text is kept as it is, and Docturnal reads it on its next run.
  const readmeState = readReadmeState(cwd);
  const readmeChanged = readmeIsPlain(cwd) && !readmeState && previous.commentLevel !== null;
  // Earlier versions wrote the main document to docs/README.md; it moves to README.md.
  const legacyReadme = docExists(cwd, `${config.docsDir}/README.md`);
  // Files .docturnalignore now matches show up as deleted, and ones it no longer matches as
  // new. A change to the file itself counts too, even when no file moves in or out.
  const currentIgnoreHash = ignoreHash(cwd);
  const ignoreChanged = previous.commentLevel !== null && currentIgnoreHash !== previous.ignoreHash;
  return { entries, current, levelChanged, toComment, backlog, changedDocsOnly, deleted, docsMissing, readmeChanged, legacyReadme, ignoreHash: currentIgnoreHash, ignoreChanged };
}

// What the open, unmerged pull request holds. A state from a merged or closed pull request
// describes nothing open.
function openPending(branch, previous) {
  return branch.mode === 'existing' && branch.unmerged > 0 ? previous.pending : emptyPending();
}

// Whether the documentation pass is done: recorded as done, or, after an earlier run, every
// code file has an entry. A pass cut short left some without one. Files that left the
// repository, or the scope, since then no longer hold it open.
function docsDone(previous, entries) {
  if (previous.docsComplete === true) return true;
  if (previous.commentLevel === null) return false;
  return !entries.some((e) => e.action === 'comment' && !previous.files[e.path]);
}

// True for a repository with no source files that Docturnal never documented: there is
// nothing to document or comment, so a run does nothing and opens no pull request.
function nothingToCover(previous, entries) {
  const hasCode = entries.some((e) => e.action === 'comment');
  const documentedBefore = previous.layers.length > 0 || Object.values(previous.files).some((e) => typeof e.summary === 'string');
  return !hasCode && !documentedBefore;
}

// branch: from prepareBranch. changes: from findChanges. rank(paths) orders backlog files by
// importance (see importance.js). Returns a plan that later steps, or other jobs, follow.
function planWork({ config, previous, changes, branch, rank }) {
  const pending = openPending(branch, previous);
  const phase = docsDone(previous, changes.entries) ? 'normal' : 'docs';
  // A pull request with someone else's commits is not added to (see prepareBranch).
  if (branch.mode === 'foreign') {
    return {
      base: branch.base, baseSha: branch.baseSha, updateSha: branch.updateSha,
      pendingOpen: true, phase, items: [], batch: null, backlogTotal: 0, hasWork: false, foreign: true,
    };
  }
  if (nothingToCover(previous, changes.entries)) {
    return {
      base: branch.base, baseSha: branch.baseSha, updateSha: branch.updateSha,
      pendingOpen: false, phase, items: [], batch: null, backlogTotal: 0, hasWork: false, noSource: true,
    };
  }
  const items = [];
  let batch = null;
  let backlogTotal = 0;

  if (phase === 'docs') {
    // Every file that has no summary for its current content. A file Docturnal commented
    // before (from an earlier version's state) that changed is commented as usual, so its
    // comment level and Docturnal's records stay right.
    for (const e of changes.entries) {
      if (e.action !== 'comment') continue;
      const entry = previous.files[e.path];
      if (entry && entry.hash !== e.hash && entry.level) {
        items.push({ path: e.path, kind: 'comment', reason: 'changed' });
      } else if (!entry || entry.hash !== e.hash || (typeof entry.summary !== 'string' && !entry.skipped && !entry.summaryFailed)) {
        items.push({ path: e.path, kind: 'summary', reason: 'docs' });
      }
    }
  } else {
    for (const e of changes.toComment) {
      items.push({ path: e.path, kind: 'comment', reason: previous.files[e.path] ? 'changed' : 'new' });
    }
    const backlog = changes.backlog.map((e) => e.path);
    backlogTotal = backlog.length;
    if (config.existingCode === 'gradual' && !pending.batch && backlog.length) {
      const chosen = rank(backlog);
      batch = { number: previous.batchesDone + 1, layers: chosen.layers, files: chosen.files };
      for (const file of chosen.files) items.push({ path: file, kind: 'comment', reason: 'backlog' });
    }
  }

  // Work for the docs alone: files that are not code, deleted files, a missing doc, and so on.
  const docsWork = changes.changedDocsOnly.length > 0 || changes.deleted.length > 0 || changes.docsMissing ||
    changes.readmeChanged || changes.legacyReadme || changes.ignoreChanged || previous.staleDocs.length > 0;
  return {
    base: branch.base,
    baseSha: branch.baseSha,
    updateSha: branch.updateSha,
    pendingOpen: branch.mode === 'existing' && branch.unmerged > 0,
    phase,
    items,
    batch,
    backlogTotal,
    hasWork: items.length > 0 || docsWork,
  };
}

module.exports = { docExists, docsDone, findChanges, ignoreHash, needsComments, nothingToCover, openPending, planWork, readCandidates };
