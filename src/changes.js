'use strict';

// Collects the in-scope files, hashes them, and compares them with the state from the last
// run. Used by main.js and by the pre-check, so it must not load typescript or call a model.

const fs = require('fs');
const path = require('path');

const { hasMarker } = require('./docs');
const { IGNORE_FILE, listFiles } = require('./git');
const { classifyFile, MAX_FILE_BYTES } = require('./languages');
const { readCurrentReadme, readReadmeState, readmeIsPlain } = require('./readme');
const { isPlainPath } = require('./safe-path');
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
  // A person editing README.md is a change, so their section gets polished. An earlier run
  // that has no saved README yet counts too, so the README gets set up once.
  const readmeState = readReadmeState(cwd);
  const readmeChanged = !readmeIsPlain(cwd) ? false : readmeState ? readCurrentReadme(cwd) !== readmeState.text : previous.commentLevel !== null;
  // Earlier versions wrote the main document to docs/README.md; it moves to README.md.
  const legacyReadme = docExists(cwd, `${config.docsDir}/README.md`);
  // Files .docturnalignore now matches show up as deleted, and ones it no longer matches as
  // new. A change to the file itself counts too, even when no file moves in or out.
  const currentIgnoreHash = ignoreHash(cwd);
  const ignoreChanged = previous.commentLevel !== null && currentIgnoreHash !== previous.ignoreHash;
  return { entries, current, levelChanged, toComment, backlog, changedDocsOnly, deleted, docsMissing, readmeChanged, legacyReadme, ignoreHash: currentIgnoreHash, ignoreChanged };
}

module.exports = { docExists, findChanges, ignoreHash, needsComments, readCandidates };
