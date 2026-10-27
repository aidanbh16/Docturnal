'use strict';

// Reads and writes .docturnal/state.json, which records what the last run produced,
// including the comments Docturnal inserted, so later runs know which ones are its own, and
// how far the project's coverage has come: whether the documentation is complete, which
// files are commented at which level, and what the open pull request holds.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { LinkError, requirePlainPath } = require('./safe-path');

const { cleanRecords } = require('./owned');

const STATE_PATH = '.docturnal/state.json';
const LAST_RUN_PATH = '.docturnal/last-run.md';
const STATE_VERSION = 1;

// pending: what the open, unmerged pull request holds, gathered over the runs that added to
// it. docs: the documentation for the whole project; changed: files commented because they
// were new or changed; batch: the one batch of existing code it may hold.
function emptyPending() {
  return { docs: false, changed: [], batch: null };
}

// The slugs Docturnal gives layers (see slugify in docs.js).
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A doc's name: a slug, or a part's slug and a sub-document's, such as "excalidraw/components".
const DOC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    commentLevel: null,
    ignoreHash: null,
    docsComplete: false,
    batchesDone: 0,
    pending: emptyPending(),
    files: {},
    layers: [],
    docs: [],
    staleDocs: [],
    // A short summary of each folder, from the documentation pass: { dir: summary }.
    folders: {},
  };
}

function hashContent(buffer) {
  return `sha256-${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

const strings = (value) => (Array.isArray(value) ? value.filter((s) => typeof s === 'string') : []);

function readPending(value) {
  const pending = emptyPending();
  if (!value || typeof value !== 'object') return pending;
  pending.docs = value.docs === true;
  pending.changed = strings(value.changed);
  const batch = value.batch;
  if (batch && Number.isInteger(batch.number) && batch.number > 0 && Array.isArray(batch.files)) {
    pending.batch = { number: batch.number, layers: strings(batch.layers), files: strings(batch.files) };
  }
  return pending;
}

// A missing or broken state file means a first run: everything is processed again.
// In a state from before gradual coverage, a file with a summary was commented at the level
// then. Whether its documentation is complete is unknown (null) when it has layers: a first
// run cut short also has layers. docsDone in changes.js decides from the files.
function readState(root) {
  let data;
  try {
    requirePlainPath(root, STATE_PATH);
    data = JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), 'utf8'));
  } catch (err) {
    if (err instanceof LinkError) throw err;
    return emptyState();
  }
  if (!data || typeof data !== 'object' || data.version !== STATE_VERSION) return emptyState();
  const state = emptyState();
  state.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  state.commentLevel = typeof data.commentLevel === 'string' ? data.commentLevel : null;
  // A hash of .docturnalignore, or null when there was none, so a change to it is a change.
  state.ignoreHash = typeof data.ignoreHash === 'string' ? data.ignoreHash : null;
  if (Array.isArray(data.layers)) {
    // A slug names a file in docs/, so it must be a plain slug: never a path. So must a
    // sub-document's part, the folder its doc is in.
    state.layers = data.layers.filter((l) => l && typeof l.slug === 'string' && SLUG.test(l.slug) && typeof l.name === 'string' && Array.isArray(l.files) &&
      (l.part === undefined || (typeof l.part === 'string' && SLUG.test(l.part))));
  }
  state.docsComplete = typeof data.docsComplete === 'boolean' ? data.docsComplete : state.layers.length > 0 ? null : false;
  state.batchesDone = Number.isInteger(data.batchesDone) && data.batchesDone >= 0 ? data.batchesDone : 0;
  state.pending = readPending(data.pending);
  if (data.files && typeof data.files === 'object') {
    for (const [file, entry] of Object.entries(data.files)) {
      if (!entry || typeof entry.hash !== 'string') continue;
      const clean = { hash: entry.hash };
      if (typeof entry.summary === 'string') {
        clean.summary = entry.summary;
        clean.symbols = Array.isArray(entry.symbols) ? entry.symbols.filter((s) => typeof s === 'string') : [];
      }
      // The comment level the file was commented at, or null when it has only a summary.
      if ('level' in entry) clean.level = typeof entry.level === 'string' ? entry.level : null;
      else clean.level = typeof clean.summary === 'string' ? state.commentLevel : null;
      // Why the file is not commented, such as syntax errors. It stays out of the backlog.
      if (typeof entry.skipped === 'string') clean.skipped = entry.skipped;
      // The model gave no usable summary for this content. It can still be commented.
      if (entry.summaryFailed === true) clean.summaryFailed = true;
      // The comments Docturnal inserted in this file: their exact text and a hash of the line under each.
      const comments = cleanRecords(entry.comments);
      if (comments.length) clean.comments = comments;
      state.files[file] = clean;
    }
  }
  if (Array.isArray(data.docs)) state.docs = data.docs.filter((s) => typeof s === 'string' && DOC_NAME.test(s));
  if (Array.isArray(data.staleDocs)) state.staleDocs = data.staleDocs.filter((s) => typeof s === 'string' && (s === 'README' || DOC_NAME.test(s)));
  if (data.folders && typeof data.folders === 'object' && !Array.isArray(data.folders)) {
    for (const [dir, summary] of Object.entries(data.folders)) if (typeof summary === 'string') state.folders[dir] = summary;
  }
  return state;
}

function serializeState(state) {
  const files = Object.fromEntries(Object.keys(state.files).sort().map((file) => [file, state.files[file]]));
  return `${JSON.stringify({ ...state, files }, null, 2)}\n`;
}

function writeState(root, state) {
  const full = path.join(root, STATE_PATH);
  requirePlainPath(root, STATE_PATH);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeState(state));
}

// Compares two states, ignoring the timestamp.
function sameState(a, b) {
  return serializeState({ ...a, updatedAt: null }) === serializeState({ ...b, updatedAt: null });
}

module.exports = { LAST_RUN_PATH, STATE_PATH, emptyPending, emptyState, hashContent, readState, sameState, serializeState, writeState };
