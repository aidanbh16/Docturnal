'use strict';

// Reads and writes .docturnal/state.json, which records what the last run produced.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_PATH = '.docturnal/state.json';
const LAST_RUN_PATH = '.docturnal/last-run.md';
const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, updatedAt: null, commentLevel: null, files: {}, layers: [], docs: [], staleDocs: [] };
}

function hashContent(buffer) {
  return `sha256-${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// A missing or broken state file means a first run: everything is processed again.
function readState(root) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, STATE_PATH), 'utf8'));
  } catch {
    return emptyState();
  }
  if (!data || typeof data !== 'object' || data.version !== STATE_VERSION) return emptyState();
  const state = emptyState();
  state.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  state.commentLevel = typeof data.commentLevel === 'string' ? data.commentLevel : null;
  if (data.files && typeof data.files === 'object') {
    for (const [file, entry] of Object.entries(data.files)) {
      if (!entry || typeof entry.hash !== 'string') continue;
      const clean = { hash: entry.hash };
      if (typeof entry.summary === 'string') {
        clean.summary = entry.summary;
        clean.symbols = Array.isArray(entry.symbols) ? entry.symbols.filter((s) => typeof s === 'string') : [];
      }
      state.files[file] = clean;
    }
  }
  if (Array.isArray(data.layers)) {
    state.layers = data.layers.filter((l) => l && typeof l.slug === 'string' && typeof l.name === 'string' && Array.isArray(l.files));
  }
  if (Array.isArray(data.docs)) state.docs = data.docs.filter((s) => typeof s === 'string');
  if (Array.isArray(data.staleDocs)) state.staleDocs = data.staleDocs.filter((s) => typeof s === 'string');
  return state;
}

function serializeState(state) {
  const files = Object.fromEntries(Object.keys(state.files).sort().map((file) => [file, state.files[file]]));
  return `${JSON.stringify({ ...state, files }, null, 2)}\n`;
}

function writeState(root, state) {
  const full = path.join(root, STATE_PATH);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeState(state));
}

// Compares two states, ignoring the timestamp.
function sameState(a, b) {
  return serializeState({ ...a, updatedAt: null }) === serializeState({ ...b, updatedAt: null });
}

module.exports = { LAST_RUN_PATH, STATE_PATH, emptyState, hashContent, readState, sameState, serializeState, writeState };
