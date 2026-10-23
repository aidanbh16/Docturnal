'use strict';

// What happens to each proposed comment: per-file counts, the minimum of one comment for
// short files, zero-based line numbers from small models, and the counts in last-run.md.

const test = require('node:test');
const assert = require('node:assert');

const { applyProposals, commentFile } = require('../src/comments');
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
    lineShift: 0,
    dropped: {
      placement: { 'closing bracket': 1 },
      length: { 'longer than 25 words': 1 },
      density: { 'level limit reached': 2 },
      safety: { 'tool directive': 1 },
      off: {},
    },
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
    assert.match(result.text, /\/\/ Callers pass numbers; nothing here checks the types\.\nfunction multiply/);
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

// --- 3. Zero-based line numbers ---

test('reads line numbers as zero-based when the model uses line 0', () => {
  // Zero-based: 0 is "function add" and 4 is "function multiply".
  const result = applyProposals({ text: MATH_JS, language: js, level: 'heavy', proposals: [line(0), line(4)] });
  assert.strictEqual(result.stats.lineShift, 2);
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /^\/\/ Callers pass numbers[^\n]*\nfunction add/);
  // The other one lands on "function multiply" and is dropped only by the density limit.
  assert.deepStrictEqual(result.stats.dropped.placement, {});
  assert.deepStrictEqual(result.stats.dropped.density, { 'level limit reached': 1 });
  assert.match(proposalSummary(result.stats), /; line numbers were read as counting from 0$/);
});

test('reads line numbers as zero-based when none fit as given and all fit one line down', () => {
  // Zero-based 4 and 8 are "function multiply" and "module.exports"; as given, both are blank lines.
  const result = applyProposals({ text: MATH_JS, language: js, level: 'heavy', proposals: [line(4), line(8)] });
  assert.strictEqual(result.stats.lineShift, 2);
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\/\/ Callers pass numbers[^\n]*\nfunction multiply/);
});

test('keeps line numbers as given when some fit, or when there is only one', () => {
  const mixed = applyProposals({ text: MATH_JS, language: js, level: 'heavy', proposals: [line(1), line(4)] });
  assert.strictEqual(mixed.stats.lineShift, 0);
  assert.deepStrictEqual(mixed.stats.dropped.placement, { 'blank line': 1 });
  assert.match(mixed.text, /^\/\/ Callers pass numbers[^\n]*\nfunction add/);

  const single = applyProposals({ text: MATH_JS, language: js, level: 'heavy', proposals: [line(4)] });
  assert.strictEqual(single.stats.lineShift, 0);
  assert.strictEqual(single.added, 0);
});

test('commentFile checks each model response for zero-based numbers on its own', async () => {
  const mock = await startMockOllama(() => ({ summary: 'Adds and multiplies numbers.', symbols: ['add', 'multiply'], comments: [line(0), line(4)] }));
  try {
    const result = await commentFile({ path: 'math.js', text: MATH_JS, level: 'medium', model: 'qwen2.5-coder:3b', host: mock.host });
    assert.match(mock.requests[0].messages[0].content, /Line numbers start at 1\./);
    assert.strictEqual(result.stats.lineShift, 2);
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
