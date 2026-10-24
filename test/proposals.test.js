'use strict';

// What happens to each proposed comment: per-file counts, the minimum of one comment for
// short files, zero-based line numbers from small models, and the counts in last-run.md.

const test = require('node:test');
const assert = require('node:assert');

const { commentFile } = require('../src/comments');
const { applyAnchored: applyProposals, withAccuracy, withAnchor } = require('./helpers');
const { languageById } = require('../src/languages');
const { buildReport, proposalSummary } = require('../src/report');
const { startMockOllama } = require('./mock-ollama');

const js = languageById('javascript');

// The 9-line file from the real test install.
const MATH_JS = [
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function multiply(a, b) {',
  '  return a * b;',
  '}',
  '',
  'module.exports = { add, multiply };',
].join('\n') + '\n';

const line = (n, text = 'Callers pass numbers; nothing here checks the types.') => ({ line: n, text, kind: 'line' });

// --- 1. Per-file counts ---

test('counts proposals, each drop category with its reasons, and added comments', () => {
  const result = applyProposals({
    text: MATH_JS,
    language: js,
    level: 'medium',
    proposals: [
      line(1),
      line(3),
      line(2),
      line(5),
      line(6, 'eslint-disable-next-line no-unused-vars'),
      line(9, Array.from({ length: 30 }, () => 'word').join(' ')),
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(result.stats, {
    proposed: 6,
    added: 1,
    dropped: {
      placement: { 'closing bracket': 1 },
      anchor: {},
      length: { 'longer than 25 words': 1 },
      density: { 'level limit reached': 2 },
      inaccurate: {},
      safety: { 'tool directive': 1 },
      off: {},
    },
    earlier: { kept: 0, restyled: 0, removed: {} },
  });
  assert.strictEqual(
    proposalSummary(result.stats),
    'proposed 6, 1 dropped by placement rules, 1 dropped by the length limit, 2 dropped by the density limit, 1 rejected by the safety check, 1 added'
  );
  assert.strictEqual(
    proposalSummary(result.stats, { reasons: true }),
    'proposed 6, 1 dropped by placement rules (closing bracket: 1), 1 dropped by the length limit (longer than 25 words: 1), ' +
      '2 dropped by the density limit (level limit reached: 2), 1 rejected by the safety check (tool directive: 1), 1 added'
  );
});

test('shows when the model proposed nothing', () => {
  const result = applyProposals({ text: MATH_JS, language: js, level: 'medium', proposals: [] });
  assert.strictEqual(proposalSummary(result.stats), 'proposed 0, 0 added');
});

test('counts every proposal as skipped when the comment level is off', () => {
  const result = applyProposals({ text: MATH_JS, language: js, level: 'off', proposals: [line(1), line(5)] });
  assert.strictEqual(proposalSummary(result.stats), 'proposed 2, 2 skipped because the comment level is off, 0 added');
});

// --- 2. Short files get at least one comment ---

for (const level of ['low', 'medium', 'heavy']) {
  test(`a 9-line file with two functions gets a comment at ${level}`, () => {
    const result = applyProposals({ text: MATH_JS, language: js, level, proposals: [line(5)] });
    assert.strictEqual(result.added, 1, JSON.stringify(result.rejections));
    // Heavy level writes a comment on a function as a block comment.
    const expected = level === 'heavy'
      ? /\/\*\*\n \* Callers pass numbers; nothing here checks the types\.\n \*\/\nfunction multiply/
      : /\/\/ Callers pass numbers; nothing here checks the types\.\nfunction multiply/;
    assert.match(result.text, expected);
  });
}

test('a one-function file gets a comment at every level except off', () => {
  const text = 'function add(a, b) {\n  return a + b;\n}\n';
  for (const level of ['low', 'medium', 'heavy']) {
    assert.strictEqual(applyProposals({ text, language: js, level, proposals: [line(1)] }).added, 1, level);
  }
  assert.strictEqual(applyProposals({ text, language: js, level: 'off', proposals: [line(1)] }).added, 0);
});

test('a limited budget goes to a function before a line inside it', () => {
  const result = applyProposals({ text: MATH_JS, language: js, level: 'medium', proposals: [line(2), line(5)] });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\nfunction multiply/);
  assert.match(result.text, /\/\/ Callers pass numbers[^\n]*\nfunction multiply/);
  assert.deepStrictEqual(result.stats.dropped.density, { 'level limit reached': 1 });
});

test('a file header followed by a blank line does not use up the one comment', () => {
  const text = `// Copyright 2026 Example Inc.\n// Licensed under the MIT License.\n\n${MATH_JS}`;
  for (const level of ['low', 'medium', 'heavy']) {
    const result = applyProposals({ text, language: js, level, proposals: [line(8)] });
    assert.strictEqual(result.added, 1, `${level}: ${JSON.stringify(result.rejections)}`);
  }
});

test('a comment directly above code still counts, so re-runs do not pile up comments', () => {
  const text = `// Adds two numbers for the calculator.\n${MATH_JS}`;
  const result = applyProposals({ text, language: js, level: 'medium', proposals: [line(6)] });
  assert.strictEqual(result.added, 0);
  assert.deepStrictEqual(result.stats.dropped.density, { 'level limit reached': 1 });
});

// --- 3. Placement by anchor ---

const at = (n, anchor, text) => ({ ...line(n, text), anchor });

test('places a comment above the line its anchor names, even when the line number is off', () => {
  // Zero-based numbers: 0 and 4 are one line above "function add" and "function multiply".
  const result = applyProposals({
    text: MATH_JS,
    language: js,
    level: 'heavy',
    proposals: [at(0, 'function add(a, b) {', 'Adds without coercion.'), at(4, 'function multiply(a, b) {', 'Multiplies without coercion.')],
  });
  assert.strictEqual(result.added, 2);
  assert.match(result.text, /^\/\*\*\n \* Adds without coercion\.\n \*\/\nfunction add/);
  assert.match(result.text, /\/\*\*\n \* Multiplies without coercion\.\n \*\/\nfunction multiply/);
});

test('ignores a line-number prefix and extra spaces copied into the anchor', () => {
  const result = applyProposals({ text: MATH_JS, language: js, level: 'medium', proposals: [at(5, '5|   function  multiply(a, b) {')] });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\/\/ Callers pass numbers[^\n]*\nfunction multiply/);
});

test('drops a comment whose anchor is not near the given line, and counts it', () => {
  const result = applyProposals({
    text: MATH_JS,
    language: js,
    level: 'medium',
    proposals: [at(2, 'return a - b;'), at(2, ''), { line: 2, anchor: undefined, text: 'No anchor at all.', kind: 'line' }],
  });
  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.text, MATH_JS);
  assert.deepStrictEqual(result.stats.dropped.anchor, { 'anchor not found': 3 });
  assert.match(proposalSummary(result.stats), /^proposed 3, 3 anchor not found, 0 added$/);
});

test('picks the nearest matching line when the anchor text repeats', () => {
  // "return 1;" is on lines 2 and 6; line 6 is nearer the given line 5.
  const text = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n';
  const result = applyProposals({ text, language: js, level: 'medium', proposals: [at(5, 'return 1;', 'Always one, by design.')] });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /function b\(\) \{\n  \/\/ Always one, by design\.\n  return 1;/);
});

test('commentFile asks for the anchor and places by it', async () => {
  const mock = await startMockOllama(withAccuracy(() => ({
    summary: 'Adds and multiplies numbers.',
    symbols: ['add', 'multiply'],
    comments: [at(0, 'function add(a, b) {'), at(4, 'function multiply(a, b) {')],
  })));
  try {
    const result = await commentFile({ path: 'math.js', text: MATH_JS, level: 'medium', model: 'qwen2.5-coder:3b', host: mock.host });
    assert.match(mock.requests[0].messages[0].content, /Line numbers start at 1\./);
    assert.match(mock.requests[0].messages[0].content, /- anchor: the exact text of that code line/);
    assert.deepStrictEqual(mock.requests[0].format.properties.comments.items.required, ['line', 'anchor', 'text', 'kind']);
    assert.strictEqual(result.added, 1);
    assert.match(result.text, /^\/\/ Callers pass numbers[^\n]*\nfunction add/);
  } finally {
    await mock.close();
  }
});

// --- The PR body ---

test('last-run.md shows per-file counts and safety rejections, never comment text or code', () => {
  const secretText = 'eslint-disable-next-line SECRET_COMMENT_TEXT';
  const result = applyProposals({
    text: MATH_JS,
    language: js,
    level: 'medium',
    proposals: [line(1), line(3), line(5), line(6, secretText)],
  });
  const report = buildReport({
    processed: [{ path: 'math.js', verifier: 'typescript', added: result.added, rejections: result.rejections, stats: result.stats }],
    models: { comment: 'qwen2.5-coder:3b', docs: 'qwen2.5-coder:7b', level: 'medium' },
  });
  assert.match(report, /\| File \| Comments added \| Checked by a parser \| Proposed comments \|/);
  assert.match(report, /\| `math\.js` \| 1 \| Yes \(TypeScript\) \| proposed 4, 1 dropped by placement rules, 1 dropped by the density limit, 1 rejected by the safety check, 1 added \|/);
  assert.match(report, /## Comments rejected by the safety check\n\n\| File \| Line \| Reason \|\n\| --- \| --- \| --- \|\n\| `math\.js` \| 6 \| tool directive \|/);
  assert.doesNotMatch(report, /SECRET_COMMENT_TEXT|Callers pass numbers|return a/);
});

test('last-run.md leaves out the safety section when nothing was rejected by it', () => {
  const result = applyProposals({ text: MATH_JS, language: js, level: 'medium', proposals: [line(1), line(3)] });
  const report = buildReport({
    processed: [{ path: 'math.js', verifier: 'typescript', added: result.added, rejections: result.rejections, stats: result.stats }],
    models: { comment: 'a', docs: 'b', level: 'medium' },
  });
  assert.doesNotMatch(report, /rejected by the safety check\n/);
  assert.match(report, /proposed 2, 1 dropped by placement rules, 1 added/);
});

test('a parser error message is never shown, only that the file could not be analyzed', () => {
  const report = buildReport({
    processed: [{ path: 'broken.py', verifier: 'python', added: 0, rejections: [{ line: 1, reason: 'cannot analyze file: invalid syntax near "x = secret"', category: 'safety' }], stats: { proposed: 1, added: 0, lineShift: 0, dropped: { placement: {}, length: {}, density: {}, safety: { 'cannot analyze file: invalid syntax near "x = secret"': 1 }, off: {} } } }],
    models: { comment: 'a', docs: 'b', level: 'medium' },
  });
  assert.match(report, /\| `broken\.py` \| 1 \| cannot analyze file \|/);
  assert.doesNotMatch(report, /secret/);
  assert.strictEqual(proposalSummary({ proposed: 1, added: 0, lineShift: 0, dropped: { safety: { 'cannot analyze file: x = secret': 1 } } }, { reasons: true }), 'proposed 1, 1 rejected by the safety check (cannot analyze file: 1), 0 added');
});
