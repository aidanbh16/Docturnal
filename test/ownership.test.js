'use strict';

// The real heavy-level run on payroll.js: comments placed by anchor, an accuracy check that
// drops wrong comments, Docturnal replacing or removing only comments it wrote itself, wrapped
// line comments, and comments on constants.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commentFile } = require('../src/comments');
const { languageById } = require('../src/languages');
const { findOwned, recordFor } = require('../src/owned');
const { buildReport, proposalSummary } = require('../src/report');
const { readState, writeState, emptyState } = require('../src/state');
const { splitLines } = require('../src/analyze');
const { applyAnchored: applyProposals, withAccuracy } = require('./helpers');
const { blocksReply, kindOf, startMockOllama } = require('./mock-ollama');

const js = languageById('javascript');

// payroll.js on main after the earlier heavy run.
const PAYROLL = fs.readFileSync(path.join(__dirname, 'fixtures/payroll-after-run.js'), 'utf8');

// What Docturnal recorded on that run. A person since shortened the validateTimesheet comment.
const RECORDS = [
  recordFor(['// Checks the timesheet entry for errors.'], 'function validateTimesheet(entry) {'),
  recordFor(['// Rounds a number to two decimal places.'], 'function roundCents(amount) {'),
  recordFor(['/**', ' * Calculates gross pay.', ' */'], 'function grossPay(hours, rate) {'),
  recordFor(['  // Loops over the brackets.'], '  for (const bracket of TAX_BRACKETS) {'),
  recordFor(['// Validates the timesheet entry and throws when the hours are out of range.'], 'function payStub(entry) {'),
  recordFor(['  // Calculates the withholding taxes for the gross amount.'], '  const gross = grossPay(entry.hours, entry.rate);'),
];

const LONG = 'Entries above the weekly maximum are rejected rather than capped, because a capped value would silently underpay or overpay the employee for that week.';

// The first pass, by the code each comment is meant for. The model sees the file without
// Docturnal's own comments, so the line numbers come from the prompt.
function firstPass(prompt) {
  const numberOf = (code) => {
    const match = [...prompt.matchAll(/^(\d+)\| (.*)$/gm)].find(([, , text]) => text.trim() === code);
    assert.ok(match, `prompt has ${code}`);
    return Number(match[1]);
  };
  const comment = (code, text, extra = {}) => ({ line: numberOf(code), anchor: code, text, kind: 'line', ...extra });
  return [
    comment('const OVERTIME_THRESHOLD = 40;', 'Weekly hours paid at the base rate; hours past this earn overtime.'),
    comment('const OVERTIME_RATE = 1.5;', 'Overtime multiplier on the hourly rate: 1.5 is time and a half.'),
    comment('const MAX_HOURS_PER_WEEK = 80;', 'Upper bound on hours in one week; anything above it is a data error.'),
    comment('if (entry.hours > MAX_HOURS_PER_WEEK) {', LONG),
    comment('return Math.round((amount + Number.EPSILON) * 100) / 100;', 'Adding Number.EPSILON first makes values like 1.005 round to 1.01 instead of 1.00.'),
    comment('tax += taxed * bracket.rate;', "Each bracket's upTo is that bracket's width, not a running total."),
    // Off by one: the line number is that of "const gross", but the anchor names the next line.
    { ...comment('const tax = withholding(gross);', 'Tax is withheld from gross pay, before other deductions.'), line: numberOf('const gross = grossPay(entry.hours, entry.rate);') },
    // An anchor that is nowhere near.
    comment('const regular = Math.min(hours, OVERTIME_THRESHOLD);', 'Hours up to the threshold.', { anchor: 'const regularHours = hours;' }),
    // Wrong, and the accuracy check says so.
    comment('const overtime = Math.max(0, hours - OVERTIME_THRESHOLD);', 'Applies the overtime rate to every hour.'),
  ];
}

const WRONG = /Validates the timesheet|Calculates the withholding|Applies the overtime rate to every hour/;

function handler(body) {
  if (kindOf(body) === 'blocks') return blocksReply(body);
  const prompt = body.messages.map((m) => m.content).join('\n');
  return { summary: 'Computes pay stubs.', symbols: ['payStub'], comments: firstPass(prompt) };
}

async function run(text, { level = 'heavy', records = RECORDS } = {}) {
  const mock = await startMockOllama(withAccuracy(handler, (comment) => !WRONG.test(comment)));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text, level, model: 'comment-model', checkModel: 'docs-model', host: mock.host, records });
    return { result, requests: mock.requests };
  } finally {
    await mock.close();
  }
}

// The file with every comment line removed, to show that the code itself never changes.
function codeOnly(text) {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\/\*\*|\*|\*\/)/.test(l.trim()) && !/^\s*\*/.test(l)).join('\n');
}

const above = (text, comment, code) => new RegExp(`${comment}\\n${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

test('the wrong payStub comment, recorded as Docturnal\'s, is replaced', async () => {
  const { result } = await run(PAYROLL);
  assert.doesNotMatch(result.text, /Validates the timesheet entry/);
  assert.ok(above(result.text, '/\\*\\*\\n \\* Explains what payStub is for and what it returns\\.\\n \\*/', 'function payStub(entry) {'), result.text);
  // The new comment is recorded as Docturnal's; the wrong one is not.
  assert.ok(result.records.some((r) => r.text === '/**\n* Explains what payStub is for and what it returns.\n*/'));
  assert.ok(!result.records.some((r) => /Validates the timesheet/.test(r.text)));
  assert.deepStrictEqual(result.stats.earlier.removed, { inaccurate: 2 });
});

test('the off-by-one proposal is placed by its anchor, and a missing anchor is dropped', async () => {
  const { result } = await run(PAYROLL);
  assert.doesNotMatch(result.text, /Calculates the withholding taxes/);
  assert.ok(above(result.text, '  // Tax is withheld from gross pay, before other deductions\\.', '  const tax = withholding(gross);'), result.text);
  assert.doesNotMatch(result.text, /Hours up to the threshold/);
  assert.deepStrictEqual(result.stats.dropped.anchor, { 'anchor not found': 1 });
});

test('a "no" verdict from the accuracy check drops the comment', async () => {
  const { result, requests } = await run(PAYROLL);
  assert.doesNotMatch(result.text, /Applies the overtime rate/);
  assert.deepStrictEqual(result.stats.dropped.inaccurate, { inaccurate: 1 });

  // One check per file, with the check model, showing each comment over the code it describes.
  const checks = requests.filter((r) => kindOf(r) === 'accuracy');
  assert.strictEqual(checks.length, 1);
  assert.strictEqual(checks[0].model, 'docs-model');
  const prompt = checks[0].messages[1].content;
  assert.match(prompt, /Comment: Validates the timesheet entry and throws when the hours are out of range\.\nCode:\n\d+\| function payStub\(entry\) \{\n\d+\|   validateTimesheet\(entry\);/);
  for (const [, code] of prompt.matchAll(/\nCode:\n((?:\d+\| .*\n?)+)/g)) {
    assert.ok(code.trim().split('\n').length <= 5);
  }
});

test('a comment a person edited is never touched', async () => {
  const { result, requests } = await run(PAYROLL);
  assert.ok(above(result.text, '// Checks the timesheet entry\\.', 'function validateTimesheet(entry) {'));
  assert.ok(!result.records.some((r) => /Checks the timesheet/.test(r.text)));
  // The follow-up does not ask for a block comment on validateTimesheet, since it has the person's.
  const followUp = requests.find((r) => kindOf(r) === 'blocks').messages[1].content;
  assert.doesNotMatch(followUp, /^- line \d+: validateTimesheet$/m);
  assert.match(followUp, /^- line \d+: withholding$/m);
  assert.match(followUp, /: payStub$/m);

  // Even at level off, a person's comment stays while every Docturnal comment goes.
  const off = applyProposals({ text: PAYROLL, language: js, level: 'off', proposals: [], records: RECORDS });
  assert.match(off.text, /\/\/ Checks the timesheet entry\.\nfunction validateTimesheet/);
  assert.doesNotMatch(off.text, /Rounds a number|Calculates gross pay|Loops over|Validates the timesheet|Calculates the withholding/);
  assert.deepStrictEqual(off.stats.earlier.removed, { 'comment level is off': 5 });
  assert.deepStrictEqual(off.records, []);
  assert.strictEqual(codeOnly(off.text), codeOnly(PAYROLL));
});

test('an earlier line comment above a function is restyled as a block at heavy', async () => {
  const { result } = await run(PAYROLL);
  assert.ok(above(result.text, '/\\*\\*\\n \\* Rounds a number to two decimal places\\.\\n \\*/', 'function roundCents(amount) {'));
  assert.ok(above(result.text, '/\\*\\*\\n \\* Calculates gross pay\\.\\n \\*/', 'function grossPay(hours, rate) {'));
  assert.ok(above(result.text, '  // Loops over the brackets\\.', '  for (const bracket of TAX_BRACKETS) {'));
  assert.deepStrictEqual(result.stats.earlier, { kept: 3, restyled: 1, removed: { inaccurate: 2 } });
});

test('long line comments wrap at 100 characters with the same indentation', async () => {
  const { result } = await run(PAYROLL);
  const lines = result.text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('  // Entries above the weekly maximum'));
  assert.ok(start > 0);
  const wrapped = lines.slice(start, lines.indexOf('  if (entry.hours > MAX_HOURS_PER_WEEK) {'));
  assert.strictEqual(wrapped.length, 2);
  for (const l of wrapped) {
    assert.ok(l.length <= 100, l);
    assert.match(l, /^ {2}\/\/ \S/);
  }
  assert.strictEqual(wrapped.map((l) => l.slice(5)).join(' '), LONG);
  // A wrapped comment is recorded as one comment, so it is recognized as a whole next time.
  assert.ok(result.records.some((r) => r.text.startsWith('// Entries above') && r.text.split('\n').length === 2));
});

test('constants get comments at heavy, though they sit on neighboring lines', async () => {
  const { result } = await run(PAYROLL);
  assert.match(result.text, /\/\/ Weekly hours paid at the base rate[^\n]*\nconst OVERTIME_THRESHOLD = 40;\n\/\/ Overtime multiplier[^\n]*\nconst OVERTIME_RATE = 1\.5;\n\/\/ Upper bound[^\n]*\nconst MAX_HOURS_PER_WEEK = 80;/);
  assert.match(result.text, /\/\/ Adding Number\.EPSILON first makes values like 1\.005 round to 1\.01 instead of 1\.00\.\n {2}return Math\.round/);
  assert.match(result.text, /\/\/ Each bracket's upTo is that bracket's width, not a running total\.\n {4}tax \+= taxed/);
});

test('every function ends up with a block comment and the code is unchanged', async () => {
  const { result } = await run(PAYROLL);
  for (const name of ['roundCents', 'grossPay', 'withholding', 'payStub']) {
    assert.match(result.text, new RegExp(` \\*/\\nfunction ${name}\\(`), name);
  }
  assert.strictEqual(codeOnly(result.text), codeOnly(PAYROLL));
});

test('a second run on the result changes nothing', async () => {
  const first = (await run(PAYROLL)).result;
  const second = (await run(first.text, { records: first.records })).result;
  assert.strictEqual(second.text, first.text);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.stats.earlier.restyled, 0);
  assert.deepStrictEqual(second.records, first.records);
});

test('a failed accuracy check leaves the file as it was', async () => {
  const mock = await startMockOllama((body) => (kindOf(body) === 'accuracy' ? 'not json' : handler(body)));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host, records: RECORDS });
    assert.strictEqual(result.text, PAYROLL);
    assert.match(result.checkFailed, /JSON/);
  } finally {
    await mock.close();
  }
});

test('the same comment text twice: the record\'s anchor decides which one is Docturnal\'s', () => {
  const text = 'function a() {\n  // Retries once.\n  call();\n  // Retries once.\n  send();\n}\n';
  const lines = splitLines(text);
  const info = lines.map((l) => ({ blank: l.text.trim() === '', commentOnly: l.text.trim().startsWith('//') }));
  const owned = findOwned(lines, info, [recordFor(['// Retries once.'], '  send();')]);
  assert.deepStrictEqual(owned.map((o) => [o.start, o.anchor]), [[3, 4]]);
});

test('records survive the state file, and last-run.md counts anchors, inaccuracy, and earlier comments', async () => {
  const { result } = await run(PAYROLL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-owned-'));
  try {
    writeState(dir, { ...emptyState(), files: { 'src/payroll.js': { hash: 'sha256-x', summary: 's', symbols: [], comments: result.records } } });
    assert.deepStrictEqual(readState(dir).files['src/payroll.js'].comments, result.records);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const summary = proposalSummary(result.stats);
  assert.match(summary, /1 anchor not found/);
  assert.match(summary, /1 inaccurate/);
  assert.match(summary, /; earlier Docturnal comments: 3 kept \(1 restyled for the level\), 2 removed \(inaccurate: 2\)$/);
  const report = buildReport({
    processed: [{ path: 'src/payroll.js', verifier: 'typescript', added: result.added, rejections: result.rejections, stats: result.stats }],
    models: { comment: 'c', docs: 'd', level: 'heavy' },
  });
  assert.match(report, /1 anchor not found/);
  assert.doesNotMatch(report, /Validates the timesheet|Explains what|Each bracket/);
});
