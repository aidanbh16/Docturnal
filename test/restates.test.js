'use strict';

// The word-match filter for new line comments that only restate the code, with the comments
// from the real heavy run on payroll.js.

const test = require('node:test');
const assert = require('node:assert');

const { commentFile } = require('../src/comments');
const { recordFor } = require('../src/owned');
const { proposalSummary } = require('../src/report');
const { RESTATES_AT, restatement, restates } = require('../src/restates');
const { withAccuracy } = require('./helpers');
const { blocksReply, kindOf, startMockOllama } = require('./mock-ollama');

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

const proposal = (text, code, kind = 'line') => ({ line: LINES.indexOf(code) + 1, anchor: code.trim(), text, kind });

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

test('in a run, the restating comments are dropped and counted, and the epsilon comment is kept', async () => {
  // A model as lenient as the real one: every comment is accurate and useful.
  const proposals = [...DROP, KEEP].map(([text, code]) => proposal(text, code));
  const mock = await startMockOllama(withAccuracy((body) => (kindOf(body) === 'blocks'
    ? blocksReply(body)
    : { summary: 'Payroll math.', symbols: [], comments: proposals })));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host });
    for (const [text] of DROP) assert.ok(!result.text.includes(text), text);
    assert.match(result.text, /\n {2}\/\/ Rounds the amount by adding a small epsilon to avoid floating-point precision issues\.\n {2}return Math\.round/);
    assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code (word match)': 5 });
    assert.match(proposalSummary(result.stats), /5 restates the code/);
    // Each drop carries its score for the log, and nothing else from the comment.
    const dropped = result.rejections.filter((r) => r.category === 'restates');
    assert.strictEqual(dropped.length, 5);
    for (const r of dropped) {
      assert.deepStrictEqual(Object.keys(r).sort(), ['category', 'coverage', 'line', 'reason']);
      assert.ok(r.coverage >= RESTATES_AT);
    }
  } finally {
    await mock.close();
  }
});

test('never applied to block comments, comments on constants or declarations, or comments already in the file', async () => {
  const withComments = PAYROLL
    // A person's comment and an earlier Docturnal comment, both pure restatements.
    .replace('  let remaining = gross;', '  // Sets remaining to gross.\n  let remaining = gross;')
    .replace('  return roundCents(tax);', '  // Returns the tax rounded to cents.\n  return roundCents(tax);');
  const records = [recordFor(['  // Returns the tax rounded to cents.'], '  return roundCents(tax);')];
  const at = (code) => withComments.split('\n').indexOf(code) + 1;
  const proposals = [
    { line: at('function grossPay(hours, rate) {'), anchor: 'function grossPay(hours, rate) {', text: 'Gross pay from hours and rate, with overtime.', kind: 'block' },
    { line: at('const OVERTIME_RATE = 1.5;'), anchor: 'const OVERTIME_RATE = 1.5;', text: 'The overtime rate.', kind: 'line' },
  ];
  const mock = await startMockOllama(withAccuracy((body) => (kindOf(body) === 'blocks'
    ? { comments: [] }
    : { summary: 's', symbols: [], comments: proposals })));
  try {
    const heavy = await commentFile({ path: 'src/payroll.js', text: withComments, level: 'heavy', model: 'm', host: mock.host, records });
    assert.match(heavy.text, /\/\*\*\n \* Gross pay from hours and rate, with overtime\.\n \*\/\nfunction grossPay/);
    assert.match(heavy.text, /\/\/ The overtime rate\.\nconst OVERTIME_RATE/);
    assert.match(heavy.text, /\/\/ Sets remaining to gross\.\n {2}let remaining/);
    assert.match(heavy.text, /\/\/ Returns the tax rounded to cents\.\n {2}return roundCents\(tax\);/);
    assert.deepStrictEqual(heavy.stats.dropped.restates, {});
    assert.deepStrictEqual(heavy.stats.earlier, { kept: 1, restyled: 0, removed: {} });

    // At medium, the function's summary is a line comment on its declaration, and stays.
    const medium = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'medium', model: 'm', host: mock.host });
    assert.match(medium.text, /\/\/ Gross pay from hours and rate, with overtime\.\nfunction grossPay/);
  } finally {
    await mock.close();
  }
});
