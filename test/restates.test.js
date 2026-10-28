'use strict';

// The word-match filter for new line comments that only restate the code, with the comments
// from the real heavy run on payroll.js.

const test = require('node:test');
const assert = require('node:assert');

const { applyProposals } = require('../src/comments');
const { languageById } = require('../src/languages');
const { recordFor } = require('../src/owned');
const { proposalSummary } = require('../src/report');
const { RESTATES_AT, restatement, restates } = require('../src/restates');

const PAYROLL = `'use strict';

const OVERTIME_THRESHOLD = 40;
const OVERTIME_RATE = 1.5;
const MAX_HOURS_PER_WEEK = 80;

function roundCents(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function grossPay(hours, rate) {
  const regular = Math.min(hours, OVERTIME_THRESHOLD);
  const overtime = Math.max(0, hours - OVERTIME_THRESHOLD);
  return regular * rate + overtime * rate * OVERTIME_RATE;
}

function withholding(gross) {
  let remaining = gross;
  let tax = 0;
  for (const { upTo, rate } of TAX_BRACKETS) {
    const taxable = Math.min(remaining, upTo);
    tax += taxable * rate;
    remaining -= taxable;
    if (remaining <= 0) break;
  }
  return roundCents(tax);
}

function payStub(entry) {
  const gross = roundCents(grossPay(entry.hours, entry.rate));
  const tax = withholding(gross);
  return {
    employeeId: entry.employeeId,
    gross,
    tax,
    net: roundCents(gross - tax),
  };
}
`;
const LINES = PAYROLL.split('\n');

// The five comments the model judged useful in the real run, and the code each sat above.
const DROP = [
  ["Adds the taxable amount multiplied by the bracket's rate to the total tax.", '    tax += taxable * rate;'],
  ['Returns the total withholding taxes rounded to the nearest cent.', '  return roundCents(tax);'],
  ["Returns an object containing the employee's ID, gross pay, tax, and net pay.", '  return {'],
  ['Calculates the gross pay for the employee and rounds it to the nearest cent.', '  const gross = roundCents(grossPay(entry.hours, entry.rate));'],
  ['Calculates the regular pay up to the OVERTIME_THRESHOLD.', '  const regular = Math.min(hours, OVERTIME_THRESHOLD);'],
];
const KEEP = ['Rounds the amount by adding a small epsilon to avoid floating-point precision issues.', '  return Math.round((amount + Number.EPSILON) * 100) / 100;'];

// The 1 to 5 code lines under a line, as the check sees them.
function codeUnder(code) {
  const start = LINES.indexOf(code);
  assert.ok(start >= 0, code);
  const out = [];
  for (let i = start; i < Math.min(LINES.length, start + 5); i++) {
    if (out.length && LINES[i].trim() === '') break;
    out.push(LINES[i]);
  }
  return out;
}

const proposal = (text, code, kind = 'line') => ({ line: LINES.indexOf(code) + 1, text, kind });
const js = languageById('javascript');

test('the five restating comments from the real run score at or above the threshold', () => {
  assert.strictEqual(RESTATES_AT, 0.6);
  for (const [comment, code] of DROP) {
    const result = restatement(comment, codeUnder(code));
    assert.ok(result.coverage >= RESTATES_AT, `${result.coverage.toFixed(2)}: ${comment}`);
    assert.strictEqual(result.reason, null, comment);
    assert.ok(restates(result), comment);
  }
});

test('the epsilon comment is kept: it states a reason, and covers little of the code anyway', () => {
  const result = restatement(KEEP[0], codeUnder(KEEP[1]));
  assert.strictEqual(result.reason, 'states a reason');
  assert.ok(result.coverage < RESTATES_AT, result.coverage.toFixed(2));
  assert.ok(!restates(result));
});

test('comments that explain, without a reason word, stay well below the threshold', () => {
  const cases = [
    ["Each bracket's upTo is that bracket's width, not a running total.", ['    const taxable = Math.min(remaining, upTo);', '    tax += taxable * rate;']],
    ['Hours past the threshold earn time and a half.', ['  const overtime = Math.max(0, hours - OVERTIME_THRESHOLD);']],
    ['Withholding applies before deductions, as payroll law requires.', ['  const tax = withholding(gross);']],
    ['Rethrow the final failure instead of a generic error.', ['  throw lastError;', '}']],
  ];
  for (const [comment, code] of cases) {
    const result = restatement(comment, code);
    assert.ok(result.coverage < RESTATES_AT, `${result.coverage.toFixed(2)}: ${comment}`);
  }
});

test('a reason word, an edge case, or a unit the code does not name keeps a comment', () => {
  const code = ['  const regular = Math.min(hours, OVERTIME_THRESHOLD);'];
  assert.ok(restates(restatement('Caps the regular hours at the overtime threshold.', code)));
  assert.strictEqual(restatement('Caps the regular hours at the threshold because overtime pays more.', code).reason, 'states a reason');
  assert.strictEqual(restatement('Caps the regular hours at the threshold, so that overtime starts there.', code).reason, 'states a reason');
  assert.strictEqual(restatement('Caps regular hours at the threshold; negative hours stay negative.', code).reason, 'names an edge case');
  // "hours" is in the code, so it is not a unit the comment adds; "minutes" is.
  assert.strictEqual(restatement('Caps the regular hours at the overtime threshold.', code).reason, null);
  assert.strictEqual(restatement('Caps regular time, in minutes, at the overtime threshold.', ['  const regular = Math.min(time, OVERTIME_THRESHOLD);']).reason, 'names a unit');
});

test('in a file, the restating comments are dropped and counted, and the epsilon comment is kept', () => {
  // As after a check as lenient as the real one: every comment is accurate and useful.
  const proposals = [...DROP, KEEP].map(([text, code]) => proposal(text, code));
  {
    const result = applyProposals({ text: PAYROLL, language: js, level: 'heavy', proposals });
    for (const [text] of DROP) assert.ok(!result.text.includes(text), text);
    assert.match(result.text, /\n {2}\/\/ Rounds the amount by adding a small epsilon to avoid floating-point precision issues\.\n {2}return Math\.round/);
    assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code (word match)': 5 });
    assert.match(proposalSummary(result.stats), /5 restates the code/);
    // Each drop carries its score for the log, and nothing else from the comment.
    const dropped = result.rejections.filter((r) => r.category === 'restates');
    assert.strictEqual(dropped.length, 5);
    for (const r of dropped) {
      assert.deepStrictEqual(Object.keys(r).sort(), ['category', 'coverage', 'line', 'narrates', 'reason']);
      assert.ok(r.coverage >= RESTATES_AT);
    }
  }
});

test('never applied to block comments, comments on constants or declarations, or comments already in the file', () => {
  const withComments = PAYROLL
    // A person's comment and an earlier Docturnal comment, both pure restatements.
    .replace('  let remaining = gross;', '  // Sets remaining to gross.\n  let remaining = gross;')
    .replace('  return roundCents(tax);', '  // Returns the tax rounded to cents.\n  return roundCents(tax);');
  const records = [recordFor(['  // Returns the tax rounded to cents.'], '  return roundCents(tax);')];
  const at = (code) => withComments.split('\n').indexOf(code) + 1;
  const proposals = [
    { line: at('function grossPay(hours, rate) {'), text: 'Gross pay from hours and rate, with overtime.', kind: 'block' },
    { line: at('const OVERTIME_RATE = 1.5;'), text: 'The overtime rate.', kind: 'line' },
  ];
  {
    const heavy = applyProposals({ text: withComments, language: js, level: 'heavy', proposals, records });
    assert.match(heavy.text, /\/\*\*\n \* Gross pay from hours and rate, with overtime\.\n \*\/\nfunction grossPay/);
    assert.match(heavy.text, /\/\/ The overtime rate\.\nconst OVERTIME_RATE/);
    assert.match(heavy.text, /\/\/ Sets remaining to gross\.\n {2}let remaining/);
    assert.match(heavy.text, /\/\/ Returns the tax rounded to cents\.\n {2}return roundCents\(tax\);/);
    assert.deepStrictEqual(heavy.stats.dropped.restates, {});
    assert.deepStrictEqual(heavy.stats.earlier, { kept: 1, restyled: 0, removed: {} });

    // At medium, the function's summary is a line comment on its declaration, and stays.
    const plain = (code) => PAYROLL.split('\n').indexOf(code) + 1;
    const medium = applyProposals({ text: PAYROLL, language: js, level: 'medium', proposals: [{ ...proposals[0], line: plain('function grossPay(hours, rate) {') }] });
    assert.match(medium.text, /\/\/ Gross pay from hours and rate, with overtime\.\nfunction grossPay/);
  }
});

// From the real run on src/readme.js: the comment passed the word match at 0.4, since "track"
// and "operations" are not in the code, though they say nothing about it either.
test('"It initializes a pending variable to track any pending operations." above `let pending = null;` restates the code', () => {
  const comment = 'It initializes a pending variable to track any pending operations.';
  const result = restatement(comment, ['  let pending = null;', '  const suppressed = new Map((saved ? saved.suppressed : []).map((s) => [s.key, s.heading]));']);
  assert.strictEqual(result.narrates, true);
  assert.strictEqual(restates(result), true);

  // In a file: dropped as restating the code, and counted.
  const text = 'async function planReadme({ current, saved }) {\n  const report = { updated: [] };\n  const errors = [];\n  let pending = null;\n  return { report, errors, pending, current, saved };\n}\n';
  const applied = applyProposals({ text, language: languageById('javascript'), level: 'medium', proposals: [{ line: 4, text: comment, kind: 'line' }] });
  assert.strictEqual(applied.added, 0);
  assert.deepStrictEqual(applied.stats.dropped.restates, { 'restates the code (word match)': 1 });
  assert.strictEqual(applied.rejections[0].narrates, true);
});

test('a comment that narrates a declaration is kept when it gives a reason, an edge case, or words of its own', () => {
  const line = ['let pending = null;'];
  const kept = [
    'It sets pending to null because the README may not need a model call at all.',
    'It initializes pending to null when nothing is left for the next run.',
    'This creates the queue of folders waiting for a summary.',
    'It stores the time budget left for the README.',
    'Pending stays null unless the README waits for the next run.',
    // It narrates the line, but names an edge case.
    'It initializes pending to null.',
  ];
  assert.strictEqual(restatement('It initializes pending to null.', line).narrates, true);
  for (const comment of kept) assert.strictEqual(restates(restatement(comment, line)), false, comment);
  for (const comment of ['This declares the pending variable.', 'It sets up a pending flag.', 'It creates a new pending state variable for later use.']) {
    assert.strictEqual(restates(restatement(comment, line)), true, comment);
  }
});
