'use strict';

// Decides what a run does, before any model is loaded:
// - Until the documentation is complete (a first run), every file gets a summary and no
//   comments, so the first pull request documents the whole project.
// - After that, new and changed files are commented first. Then, if "Existing code" is
//   "gradual" and no batch is waiting in an open pull request, one batch of existing files,
//   ordered by importance.
// For a parallel run it also splits the work into shards, one per worker job.

const fs = require('fs');

const { needsComments } = require('./changes');
const { emptyPending } = require('./state');

// Fewer files than this run in one job; a parallel run costs each job's setup time.
const PARALLEL_FROM = 40;
const FILES_PER_JOB = 20;
const PUBLIC_JOBS = 8;
const PRIVATE_JOBS = 2;

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
  if (nothingToCover(previous, changes.entries)) {
    return {
      version: 1, base: branch.base, baseSha: branch.baseSha, updateSha: branch.updateSha,
      pendingOpen: false, phase, items: [], batch: null, backlogTotal: 0, hasWork: false, noSource: true,
    };
  }
  const sizeOf = (file) => (changes.current.get(file) ? changes.current.get(file).buffer.length : 0);
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
        items.push({ path: e.path, kind: 'comment', reason: 'changed', size: e.buffer.length });
      } else if (!entry || entry.hash !== e.hash || (typeof entry.summary !== 'string' && !entry.skipped && !entry.summaryFailed)) {
        items.push({ path: e.path, kind: 'summary', reason: 'docs', size: e.buffer.length });
      }
    }
  } else {
    for (const e of changes.toComment) {
      items.push({ path: e.path, kind: 'comment', reason: previous.files[e.path] ? 'changed' : 'new', size: e.buffer.length });
    }
    const backlog = changes.backlog.map((e) => e.path);
    backlogTotal = backlog.length;
    if (config.existingCode === 'gradual' && !pending.batch && backlog.length) {
      const chosen = rank(backlog);
      batch = { number: previous.batchesDone + 1, layers: chosen.layers, files: chosen.files };
      for (const file of chosen.files) items.push({ path: file, kind: 'comment', reason: 'backlog', size: sizeOf(file) });
    }
  }

  // Work for the docs alone: files that are not code, deleted files, a missing doc, and so on.
  const docsWork = changes.changedDocsOnly.length > 0 || changes.deleted.length > 0 || changes.docsMissing ||
    changes.readmeChanged || changes.legacyReadme || changes.ignoreChanged || previous.staleDocs.length > 0;
  return {
    version: 1,
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

// Whether the repository is private, from the event GitHub sends the workflow. Unknown counts
// as private, so a run never uses more Actions minutes than it should.
function repositoryIsPrivate(env = process.env) {
  try {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (event && event.repository && typeof event.repository.private === 'boolean') return event.repository.private;
  } catch {
    // No event file, as in a local run.
  }
  return true;
}

// How many worker jobs to use: one below PARALLEL_FROM files; otherwise up to 8 for a public
// repository and 2 for a private one, or max-jobs when it is set.
function jobCount(fileCount, { maxJobs = 0, isPrivate = true } = {}) {
  if (fileCount < PARALLEL_FROM) return fileCount > 0 ? 1 : 0;
  const limit = maxJobs > 0 ? maxJobs : isPrivate ? PRIVATE_JOBS : PUBLIC_JOBS;
  return Math.max(1, Math.min(limit, Math.ceil(fileCount / FILES_PER_JOB)));
}

// Splits items into `jobs` shards of about equal size: the largest file goes to the least
// loaded shard. Each item lands in exactly one shard, and each shard keeps the plan's order.
function splitShards(items, jobs) {
  if (jobs <= 0) return [];
  const loads = Array.from({ length: jobs }, () => 0);
  const owner = new Map();
  const bySize = items.map((item, index) => ({ item, index })).sort((a, b) => (b.item.size || 0) - (a.item.size || 0) || a.index - b.index);
  for (const { index, item } of bySize) {
    let target = 0;
    for (let s = 1; s < jobs; s++) if (loads[s] < loads[target]) target = s;
    loads[target] += (item.size || 0) + 1000;
    owner.set(index, target);
  }
  const shards = Array.from({ length: jobs }, () => []);
  items.forEach((item, index) => shards[owner.get(index)].push(item));
  return shards;
}

module.exports = { docsDone, nothingToCover, FILES_PER_JOB, PARALLEL_FROM, PRIVATE_JOBS, PUBLIC_JOBS, jobCount, needsComments, openPending, planWork, repositoryIsPrivate, splitShards };
