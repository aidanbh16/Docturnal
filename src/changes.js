'use strict';

// Collects the in-scope files, hashes them, and compares them with the state from the last
// run. Used by main.js and by the pre-check, so it must not load typescript or call a model.

const fs = require('fs');
const path = require('path');

const { hasMarker } = require('./docs');
const { listFiles } = require('./git');
const { classifyFile, MAX_FILE_BYTES } = require('./languages');
const { readCurrentReadme, readReadmeState } = require('./readme');
const { hashContent } = require('./state');

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
    const classified = classifyFile(file, { ...options, sample: buffer });
    if (classified.action === 'skip') continue;
    entries.push({ path: file, action: classified.action, language: classified.language, buffer, hash: hashContent(buffer) });
  }
  return entries;
}

function docExists(cwd, docPath) {
  try {
    return hasMarker(fs.readFileSync(path.join(cwd, docPath), 'utf8'));
  } catch {
    return false;
  }
}

// Compares the working tree with the previous state. A file is new or changed when its hash
// differs from the state; changing the comment level makes every file count as changed.
function findChanges(cwd, config, previous) {
  const entries = readCandidates(cwd, config);
  const current = new Map(entries.map((e) => [e.path, e]));
  const levelChanged = previous.commentLevel !== null && previous.commentLevel !== config.commentLevel;
  const toComment = entries.filter((e) => e.action === 'comment' &&
    (levelChanged || !previous.files[e.path] || previous.files[e.path].hash !== e.hash));
  const changedDocsOnly = entries.filter((e) => e.action === 'docs' && (!previous.files[e.path] || previous.files[e.path].hash !== e.hash));
  const deleted = Object.keys(previous.files).filter((file) => !current.has(file));
  // A generated doc is missing when a recorded layer doc is gone, or when files were
  // summarized but no docs were ever written for them.
  const summarized = Object.values(previous.files).some((entry) => typeof entry.summary === 'string');
  const docsMissing = previous.docs.some((slug) => !docExists(cwd, `${config.docsDir}/${slug}.md`)) ||
    (previous.layers.length === 0 && summarized);
  // A person editing README.md is a change, so their section gets polished. An earlier run
  // that has no saved README yet counts too, so the README gets set up once.
  const readmeState = readReadmeState(cwd);
  const readmeChanged = readmeState ? readCurrentReadme(cwd) !== readmeState.text : previous.commentLevel !== null;
  // Earlier versions wrote the main document to docs/README.md; it moves to README.md.
  const legacyReadme = docExists(cwd, `${config.docsDir}/README.md`);
  return { entries, current, levelChanged, toComment, changedDocsOnly, deleted, docsMissing, readmeChanged, legacyReadme };
}

module.exports = { docExists, findChanges, readCandidates };
