'use strict';

// Anchors as a small model gives them: copied with the prompt's line number, re-spaced, with
// other quotes or no semicolon, cut short, running onto the next line, or with a line number
// that is off. Each tolerant form is placed on the right line; a wrong anchor, and an
// ambiguous one, are dropped; and the log counts each category, never an anchor's text.
// The file is an excerpt of src/layers.js as the real nightly run saw it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ANCHOR_FIXES: FIX, ANCHOR_MISSES: MISS, anchorSummary, applyProposals, locateAnchor } = require('../src/comments');
const { splitLines } = require('../src/analyze');
const { languageById } = require('../src/languages');

const TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'layers-excerpt.js'), 'utf8');
const LINES = splitLines(TEXT);
const js = languageById('javascript');
const lineOf = (code) => {
  const found = LINES.map((l, i) => (l.text.trim() === code ? i + 1 : 0)).filter(Boolean);
  assert.strictEqual(found.length, 1, `${code} is on one line`);
  return found[0];
};

// [given line, anchor, expected line, expected fixes]
const TOLERATED = [
  [4, '4| const found = group.folders.filter((f) => files.some((file) => holds(f, file)));', 'const found = group.folders.filter((f) => files.some((file) => holds(f, file)));', [FIX.prefix]],
  [14, '14: let current = [...groups];', 'let current = [...groups];', [FIX.prefix]],
  [48, 'line 48: const steps = splitSteps(folderGroups(files, importsOf), importsOf);', 'const steps = splitSteps(folderGroups(files, importsOf), importsOf);', [FIX.prefix]],
  [16, 'const room = MAX_LAYERS-current.length+1;', 'const room = MAX_LAYERS - current.length + 1;', [FIX.loose]],
  [66, 'if (!clauses.length) return "";', "if (!clauses.length) return '';", [FIX.loose]],
  [59, 'const clauses = []', 'const clauses = [];', [FIX.loose]],
  [91, '  const own  =  contentWords( description );', 'const own = contentWords(description);', [FIX.loose]],
  [15, 'for (const group of [...groups].sort((a, b) =>...', 'for (const group of [...groups].sort((a, b) => b.files.length - a.files.length || a.folder.localeCompare(b.folder))) {', [FIX.truncated]],
  [62, 'const clause = purpose(file).replace(', "const clause = purpose(file).replace(/^(?:A|An|The|[A-Z][a-z]{2,}s)\\b/, (w) => w.toLowerCase());", [FIX.truncated]],
  [77, '77| const info = fileInfo.get(fi…', 'const info = fileInfo.get(file);', [FIX.prefix, FIX.truncated]],
  [49, 'let step = steps.next();\n  while (!step.done) step = steps.next(clusterParts(step.value.group, step.value.maxParts, importsOf, purposeOf));', 'let step = steps.next();', [FIX.lines]],
  [86, 'const theirs = contentWords(purpose);', 'const theirs = contentWords(purpose);', [FIX.near]],
  [20, 'const words = significantWords(name);', 'const words = significantWords(name);', [FIX.window]],
  [33, 'function finishGroups(groups) {', 'function finishGroups(groups) {', []],
  [44, '47| function groupFiles(files, importsOf = () => [], purposeOf = () => \'\') {', "function groupFiles(files, importsOf = () => [], purposeOf = () => '') {", [FIX.prefix]],
];

// [given line, anchor, why it is dropped]
const DROPPED = [
  [51, 'return step.value;', MISS.none], // made up: the line is `return finishGroups(step.value);`
  [30, 'const folders = group.folders.map(dirOf);', MISS.none], // not in the file
  [18, 'const parts = ...', MISS.none], // cut too short to stand for one line
  [12, 'module.exports = { planLayers };', MISS.none], // from another part of the file
  [80, '', MISS.empty],
  [62, '});', MISS.ambiguous], // on lines 26 and 98, both far away: found twice in the window
];

// Two functions with the same first statement, as small models often see.
const TWINS = splitLines('function a(x) {\n  const value = normalize(x);\n  return value;\n}\nfunction b(y) {\n  const value = normalize(y);\n  return value;\n}\n');

test('tolerant anchors from a small model are placed on the line they name', () => {
  for (const [given, anchor, code, fixes] of TOLERATED) {
    const found = locateAnchor(LINES, given, anchor);
    assert.strictEqual(found.line, lineOf(code), `${JSON.stringify(anchor)} at ${given}`);
    assert.deepStrictEqual(found.fixes.sort(), [...fixes].sort(), `${JSON.stringify(anchor)} fixes`);
  }
});

test('wrong, too short, empty, and ambiguous anchors are dropped', () => {
  for (const [given, anchor, miss] of DROPPED) {
    assert.deepStrictEqual(locateAnchor(LINES, given, anchor), { line: null, miss }, `${JSON.stringify(anchor)} at ${given}`);
  }
});

test('a cut-short anchor that two nearby lines start with is ambiguous, and dropped', () => {
  assert.deepStrictEqual(locateAnchor(TWINS, 4, 'const value = normalize('), { line: null, miss: MISS.ambiguous });
  // Given one of the lines, it is that line.
  assert.strictEqual(locateAnchor(TWINS, 6, 'const value = normalize(').line, 6);
});

test('an exact match nearest the given line still wins, below first, as before', () => {
  // "});" is on two lines; given one of them, or a line within 5, the nearest is used.
  const first = LINES.findIndex((l) => l.text.trim() === '});') + 1;
  assert.strictEqual(locateAnchor(LINES, first, '});').line, first);
  assert.strictEqual(locateAnchor(LINES, first + 3, '});').line, first);
  assert.strictEqual(locateAnchor(TWINS, 4, 'return value;').line, 3);
  assert.strictEqual(locateAnchor(TWINS, 5, 'return value;').line, 7);
  // A line-number prefix that is part of the code is read as code first.
  const yaml = splitLines('1: one\n2: two\n');
  assert.deepStrictEqual(locateAnchor(yaml, 2, '2: two'), { line: 2, fixes: [] });
});

test('an anchor found only outside the lines its request showed is dropped', () => {
  const words = lineOf('const words = significantWords(name);');
  const found = locateAnchor(LINES, 20, 'const words = significantWords(name);', { start: 0, end: 50 });
  assert.ok(words > 50);
  assert.deepStrictEqual(found, { line: null, miss: MISS.outside });
});

test('the whole set: tolerant anchors placed, wrong and ambiguous ones dropped, with counts only', () => {
  const proposals = [...TOLERATED, ...DROPPED].map(([line, anchor], i) => ({ line, anchor, text: `Explains choice ${i} for the reader.`, kind: 'line' }));
  const result = applyProposals({ text: TEXT, language: js, level: 'heavy', proposals });
  const { anchors, dropped } = result.stats;
  assert.strictEqual(anchors.exact, 1);
  assert.deepStrictEqual(anchors.fixed, {
    [FIX.prefix]: 5, [FIX.loose]: 4, [FIX.truncated]: 3, [FIX.lines]: 1, [FIX.near]: 1, [FIX.window]: 1,
  });
  assert.deepStrictEqual(anchors.missed, { [MISS.none]: 4, [MISS.empty]: 1, [MISS.ambiguous]: 1 });
  const anchorDrops = Object.values(dropped.anchor).reduce((sum, n) => sum + n, 0);
  assert.strictEqual(anchorDrops, DROPPED.length);
  // Every tolerated proposal reached the later rules: placement, the level's limits, and so on.
  const later = Object.entries(dropped).filter(([category]) => category !== 'anchor').reduce((sum, [, counts]) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0);
  assert.strictEqual(later + result.added, TOLERATED.length);
  assert.ok(result.added > 0);
  const summary = anchorSummary(anchors);
  assert.match(summary, /^anchors: 1 matched exactly; matched after a fix: .*contains a line-number prefix: 5.*; 6 not found: .*matches several lines: 1/);
  // Counts and categories only: no anchor text reaches the log.
  for (const [, anchor] of [...TOLERATED, ...DROPPED]) if (anchor.length > 12) assert.ok(!summary.includes(anchor.trim().slice(0, 12)));
});

test('a placed tolerant anchor puts the comment above that exact line', () => {
  const result = applyProposals({
    text: TEXT,
    language: js,
    level: 'heavy',
    proposals: [{ line: 11, anchor: '14| let current = [...groups]', text: 'Holds the groups as they are split, in place of the input list.', kind: 'line' }],
  });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\n {2}\/\/ Holds the groups as they are split, in place of the input list\.\n {2}let current = \[\.\.\.groups\];\n/);
});
