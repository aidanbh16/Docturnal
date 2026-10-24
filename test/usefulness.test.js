'use strict';

// The usefulness check: new line comments that only restate the code, or repeat the comment
// of the function around them, are dropped. Comments already in the file never are. Also
// balanced wrapping and files with syntax errors.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { commentFile } = require('../src/comments');
const { recordFor } = require('../src/owned');
const { buildReport, proposalSummary } = require('../src/report');
const { findPython } = require('../src/python');
const { languageById } = require('../src/languages');
const { applyAnchored: applyProposals, withAccuracy } = require('./helpers');
const { kindOf, startMockOllama } = require('./mock-ollama');

const js = languageById('javascript');

const WITHHOLDING = [
  'function withholding(gross) {',
  '  let remaining = gross;',
  '  let tax = 0;',
  '  for (const bracket of TAX_BRACKETS) {',
  '    const taxed = Math.min(remaining, bracket.upTo);',
  '    tax += taxed * bracket.rate;',
  '    remaining -= taxed;',
  '  }',
  '  return tax;',
  '}',
  '',
  '/**',
  ' * Rounds to cents. Adding Number.EPSILON first makes values like 1.005 round up to 1.01.',
  ' */',
  'function roundCents(amount) {',
  '  return Math.round((amount + Number.EPSILON) * 100) / 100;',
  '}',
  '',
].join('\n');

const RESTATES = 'Initializes the remaining amount to be taxed to the gross pay.';
const WHY = "Each bracket's upTo is that bracket's width, not a running total.";
const REPEATS = 'Rounds the amount by adding a small epsilon, multiplying by 100, rounding, and then dividing by 100.';

const proposal = (code, text, kind = 'line') => {
  const line = WITHHOLDING.split('\n').indexOf(code) + 1;
  assert.ok(line > 0, code);
  return { line, anchor: code.trim(), text, kind };
};

// A model that judges like a careful reader: narration adds nothing, and the roundCents line
// comment says only what the function's comment already says.
function judge(comment, code, functionComment) {
  if (comment === RESTATES) return { useful: false };
  if (comment === REPEATS) return { repeats: Boolean(functionComment) };
  return true;
}

async function run(text, proposals, { level = 'heavy', records = [], verdict = judge } = {}) {
  // The heavy-level follow-up gets no comments, so each proposal is made once.
  const mock = await startMockOllama(withAccuracy((body) => (kindOf(body) === 'blocks'
    ? { comments: [] }
    : { summary: 'Payroll math.', symbols: [], comments: proposals }), verdict));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text, level, model: 'm', host: mock.host, records });
    return { result, requests: mock.requests };
  } finally {
    await mock.close();
  }
}

test('a new comment that only restates the code is dropped, and one that explains why is kept', async () => {
  const { result } = await run(WITHHOLDING, [
    proposal('  let remaining = gross;', RESTATES),
    proposal('    const taxed = Math.min(remaining, bracket.upTo);', WHY),
  ]);
  assert.doesNotMatch(result.text, /Initializes the remaining amount/);
  assert.match(result.text, /\n {4}\/\/ Each bracket's upTo is that bracket's width, not a running total\.\n {4}const taxed/);
  assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code': 1 });
  assert.match(proposalSummary(result.stats), /^proposed 2, 1 restates the code, 1 added$/);
});

test('a line comment that repeats the function\'s comment is dropped; the check sees that comment', async () => {
  const { result, requests } = await run(WITHHOLDING, [proposal('  return Math.round((amount + Number.EPSILON) * 100) / 100;', REPEATS)]);
  assert.doesNotMatch(result.text, /Rounds the amount by adding/);
  assert.deepStrictEqual(result.stats.dropped.restates, { 'repeats the function comment': 1 });
  const check = requests.find((r) => kindOf(r) === 'accuracy').messages[1].content;
  assert.match(check, /Comment: Rounds the amount by adding[^\n]*\nFunction comment: Rounds to cents\. Adding Number\.EPSILON first makes values like 1\.005 round up to 1\.01\.\nCode:\n16\| {3}return Math\.round/);
  assert.deepStrictEqual(check.match(/^Function comment:/gm).length, 1);
  assert.match(proposalSummary(result.stats), /1 restates the code/);
});

test('the function comment comes from a new block comment when the function has none yet', async () => {
  const { requests } = await run(WITHHOLDING, [
    proposal('function withholding(gross) {', 'Tax owed on gross pay under progressive brackets.', 'block'),
    proposal('  let remaining = gross;', 'Starts at gross pay and shrinks as each bracket takes its share.'),
  ]);
  const check = requests.find((r) => kindOf(r) === 'accuracy').messages[1].content;
  assert.match(check, /Comment: Starts at gross pay[^\n]*\nFunction comment: Tax owed on gross pay under progressive brackets\.\nCode:/);
  // The block comment itself is not given a function comment.
  assert.match(check, /Comment: Tax owed on gross pay under progressive brackets\.\nCode:/);
});

test('the check never removes a comment already in the file, Docturnal\'s or a person\'s, and never a block comment', async () => {
  const text = WITHHOLDING
    .replace('  let remaining = gross;', '  // Starts with all of the gross pay.\n  let remaining = gross;')
    .replace('  for (const bracket', '  // Loops over the brackets.\n  for (const bracket');
  const records = [recordFor(['  // Loops over the brackets.'], '  for (const bracket of TAX_BRACKETS) {')];
  // A model that calls everything useless and repetitive.
  const { result } = await run(text, [
    proposal('function withholding(gross) {', 'Tax owed on gross pay under progressive brackets.', 'block'),
    proposal('    tax += taxed * bracket.rate;', 'Adds the tax for this bracket to the total.'),
  ], { records, verdict: () => ({ useful: false, repeats: true }) });
  // Docturnal's earlier comment and the person's comment stay.
  assert.match(result.text, /\/\/ Loops over the brackets\.\n {2}for \(const bracket/);
  assert.match(result.text, /\/\/ Starts with all of the gross pay\.\n {2}let remaining/);
  assert.deepStrictEqual(result.stats.earlier, { kept: 1, restyled: 0, removed: {} });
  // The new block comment stays; the new line comment goes.
  assert.match(result.text, /\/\*\*\n \* Tax owed on gross pay under progressive brackets\.\n \*\/\nfunction withholding/);
  assert.doesNotMatch(result.text, /Adds the tax for this bracket/);
  assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code': 1 });
});

test('a verdict without the usefulness answers keeps the comment', async () => {
  const mock = await startMockOllama((body) => {
    if (kindOf(body) === 'accuracy') return { verdicts: [{ id: 1, accurate: true }] };
    if (kindOf(body) === 'blocks') return { comments: [] };
    return { summary: 's', symbols: [], comments: [proposal('    const taxed = Math.min(remaining, bracket.upTo);', WHY)] };
  });
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: WITHHOLDING, level: 'heavy', model: 'm', host: mock.host });
    assert.strictEqual(result.added, 1);
  } finally {
    await mock.close();
  }
});

// The greedy wrap the engine used before: as many words per line as fit.
function greedy(text, width) {
  const lines = [''];
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines;
}

test('wrapped comments are balanced, so the last line is not a single short word', () => {
  const text = 'function roundCents(amount) {\n  return Math.round((amount + Number.EPSILON) * 100) / 100;\n}\n';
  const comment = 'Adds Number.EPSILON before scaling so values such as 1.005 round up to 1.01 and not down, times 100.';
  // At this indentation the line comment wraps at 95 characters, and a greedy wrap leaves "100." alone.
  assert.deepStrictEqual(greedy(comment, 95).slice(-1), ['100.']);

  const result = applyProposals({ text, language: js, level: 'medium', proposals: [{ line: 2, text: comment, kind: 'line' }] });
  const wrapped = result.text.split('\n').filter((l) => l.trimStart().startsWith('//'));
  assert.strictEqual(wrapped.length, 2);
  for (const l of wrapped) {
    assert.ok(l.length <= 100);
    assert.ok(l.slice(5).split(' ').length >= 5, l);
  }
  assert.ok(Math.abs(wrapped[0].length - wrapped[1].length) < 15, wrapped.join('\n'));
  assert.strictEqual(wrapped.map((l) => l.slice(5)).join(' '), comment);

  // Block comments are balanced the same way.
  const block = applyProposals({
    text,
    language: js,
    level: 'heavy',
    proposals: [{ line: 1, text: 'Rounds a money amount to whole cents, so that every total on a payslip adds up to the same cents as its parts.', kind: 'block' }],
  });
  const body = block.text.split('\n').filter((l) => l.startsWith(' * '));
  assert.strictEqual(body.length, 2);
  assert.ok(body[1].split(' ').length >= 5, body.join('\n'));
});

test('a JavaScript file with syntax errors is skipped before any model call', async () => {
  const broken = 'function payStub(entry) {\n  const gross = grossPay(entry.hours, entry.rate;\n  return gross;\n}\n';
  const mock = await startMockOllama(() => {
    throw new Error('no model call expected');
  });
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: broken, level: 'heavy', model: 'm', host: mock.host });
    assert.strictEqual(result.skipped, 'the file has syntax errors');
    assert.strictEqual(result.text, broken);
    assert.strictEqual(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test('a Python file with syntax errors is skipped too', { skip: !findPython() }, async () => {
  const broken = 'def pay_stub(entry):\n    gross = gross_pay(entry.hours,\n    return gross\n';
  const result = await commentFile({ path: 'payroll.py', text: broken, level: 'heavy', model: 'm', chat: async () => assert.fail('no model call expected') });
  assert.strictEqual(result.skipped, 'the file has syntax errors');
  const indented = 'def pay_stub(entry):\nreturn entry\n';
  assert.strictEqual((await commentFile({ path: 'p.py', text: indented, level: 'low', model: 'm', chat: async () => assert.fail() })).skipped, 'the file has syntax errors');
});

test('last-run.md lists skipped files with the reason, and counts restating comments', () => {
  const stats = {
    proposed: 3,
    added: 1,
    dropped: { placement: {}, anchor: {}, length: {}, density: {}, inaccurate: {}, restates: { 'restates the code': 1, 'repeats the function comment': 1 }, safety: {}, off: {} },
    earlier: { kept: 0, restyled: 0, removed: {} },
  };
  const report = buildReport({
    processed: [{ path: 'src/tax.js', verifier: 'typescript', added: 1, rejections: [], stats }],
    skipped: [{ path: 'src/payroll.js', reason: 'the file has syntax errors' }],
    models: { comment: 'c', docs: 'd', level: 'heavy' },
  });
  assert.match(report, /\| `src\/tax\.js` \| 1 \| Yes \(TypeScript\) \| proposed 3, 2 restates the code, 1 added \|/);
  assert.match(report, /## Files skipped\n\n- `src\/payroll\.js`: skipped, the file has syntax errors\n/);
  assert.match(proposalSummary(stats, { reasons: true }), /2 restates the code \(restates the code: 1, repeats the function comment: 1\)/);
});
