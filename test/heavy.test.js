'use strict';

// Heavy level: a block comment above every function, class, and component, which the
// density limit never drops, plus line comments on non-obvious logic, which it still limits.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { commentFile } = require('../src/comments');
const { applyAnchored: applyProposals, withAnchor } = require('./helpers');
const { findPython } = require('../src/python');
const { languageById } = require('../src/languages');
const { accuracyReply, blocksReply, kindOf, startMockOllama } = require('./mock-ollama');

const js = languageById('javascript');
const noPython = !findPython();

// The file from the real test install: 5 functions and 3 constants.
const PAYROLL = fs.readFileSync(path.join(__dirname, 'fixtures/payroll.js'), 'utf8');
const FUNCTIONS = ['grossPay', 'incomeTax', 'netPay', 'formatCurrency', 'payslip'];
const lineOf = (code) => PAYROLL.split('\n').findIndex((l) => l.startsWith(code)) + 1;

// What the model proposed in the real run: one block comment and four line comments.
const FIRST_PASS = [
  { line: lineOf('function grossPay'), text: 'Pays hours past the weekly threshold at the overtime rate.', kind: 'block' },
  { line: lineOf('  const regular'), text: 'Hours up to the threshold are paid at the base rate.', kind: 'line' },
  { line: lineOf('  const overtime'), text: 'Only hours past the threshold earn the multiplier.', kind: 'line' },
  { line: lineOf('const OVERTIME_THRESHOLD_HOURS'), text: 'Weekly hours before overtime starts.', kind: 'line' },
  { line: lineOf('  return Math.round'), text: 'Rounds to cents so payslip totals add up.', kind: 'line' },
].map((p) => withAnchor(PAYROLL, p));

function hasBlockAbove(text, name) {
  return new RegExp(`/\\*\\*\\n(?: \\*.*\\n)+ \\*/\\n(?:function|const) ${name}\\b`).test(text);
}

function firstPassHandler(body) {
  if (kindOf(body) === 'blocks') return blocksReply(body);
  if (kindOf(body) === 'accuracy') return accuracyReply(body);
  return { summary: 'Computes pay, tax, and payslips.', symbols: FUNCTIONS, comments: FIRST_PASS };
}

test('heavy: a block comment above a function never uses up the level or the gap', () => {
  const result = applyProposals({ text: PAYROLL, language: js, level: 'heavy', proposals: FIRST_PASS });
  // The line comment directly below the grossPay block is kept; before, the gap rule dropped it.
  assert.match(result.text, /\/\*\*\n \* Pays hours past[^\n]*\n \*\/\nfunction grossPay\(hours, hourlyRate\) \{\n  \/\/ Hours up to the threshold/);
  assert.strictEqual(result.added, 4);
  // Line comments are still limited among themselves.
  assert.deepStrictEqual(result.stats.dropped.density, { 'within 2 lines of another comment': 1 });
  assert.deepStrictEqual(result.undocumented.map((d) => d.name), ['incomeTax', 'netPay', 'formatCurrency', 'payslip']);
});

test('heavy: block comments are added even when line comments have used up the level', () => {
  const blocks = FUNCTIONS.map((name) => ({ line: lineOf(name === 'formatCurrency' ? 'const formatCurrency' : `function ${name}`), text: `Explains ${name}.`, kind: 'line' }));
  const lineComments = PAYROLL.split('\n')
    .map((code, i) => ({ code, line: i + 1 }))
    .filter(({ code }) => /^ {2,}(const|let|tax|lower|if|for|return)\b/.test(code))
    .map(({ line }) => ({ line, text: 'Explains this step.', kind: 'line' }));
  const result = applyProposals({ text: PAYROLL, language: js, level: 'heavy', proposals: [...lineComments, ...blocks] });
  // A "line" proposal on a declaration becomes a block at heavy level.
  for (const name of FUNCTIONS) assert.ok(hasBlockAbove(result.text, name), name);
  assert.deepStrictEqual(result.undocumented, []);
  const limited = Object.values(result.stats.dropped.density).reduce((a, b) => a + b, 0);
  assert.ok(limited > 0, 'some line comments are dropped by the density limit');
  assert.strictEqual(result.added + limited, lineComments.length + blocks.length);
});

test('heavy: every function in payroll.js gets a block comment, with one follow-up request', async () => {
  const mock = await startMockOllama(firstPassHandler);
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host });
    for (const name of FUNCTIONS) assert.ok(hasBlockAbove(result.text, name), `${name}:\n${result.text}`);
    assert.deepStrictEqual(result.undocumented, []);
    assert.deepStrictEqual(result.errors, []);

    assert.deepStrictEqual(mock.requests.map(kindOf), ['comments', 'blocks', 'accuracy']);
    const followUp = mock.requests[1];
    assert.deepStrictEqual(followUp.format.required, ['comments']);
    const prompt = followUp.messages[1].content;
    assert.deepStrictEqual([...prompt.matchAll(/^- line (\d+): (\w+)$/gm)].map((m) => `${m[1]} ${m[2]}`), [
      `${lineOf('function incomeTax')} incomeTax`,
      `${lineOf('function netPay')} netPay`,
      `${lineOf('const formatCurrency')} formatCurrency`,
      `${lineOf('function payslip')} payslip`,
    ]);
    assert.match(prompt, new RegExp(`\\n${lineOf('function payslip')}\\| function payslip\\(employee\\) \\{\\n`));
    // The code before the first listed function is not sent again.
    assert.doesNotMatch(prompt, /\| const OVERTIME_MULTIPLIER/);
    // 5 blocks plus the line comments that fit the level.
    assert.strictEqual(result.stats.proposed, 9);
    assert.strictEqual(result.added, 8);
    // The output is valid JavaScript with the original code untouched.
    const withoutComments = result.text.split('\n').filter((l) => !/^\s*(\/\*\*| \*|\/\/)/.test(l)).join('\n');
    assert.strictEqual(withoutComments, PAYROLL);
  } finally {
    await mock.close();
  }
});

test('heavy: the heavy prompt asks for line comments on non-obvious logic', async () => {
  const mock = await startMockOllama(firstPassHandler);
  try {
    await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host });
    const system = mock.requests[0].messages[0].content;
    assert.match(system, /Give every function, class, and component a comment of kind "block"/);
    assert.match(system, /non-obvious logic: calculations, loops, edge cases, and magic numbers/);
  } finally {
    await mock.close();
  }
});

test('heavy: no follow-up when every function already has a comment, or the model never answered', async () => {
  const documented = await startMockOllama(firstPassHandler);
  try {
    const first = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: documented.host });
    const again = await commentFile({ path: 'src/payroll.js', text: first.text, level: 'heavy', model: 'm', host: documented.host });
    assert.strictEqual(documented.requests.filter((r) => kindOf(r) === 'blocks').length, 1);
    assert.deepStrictEqual(again.undocumented, []);
  } finally {
    await documented.close();
  }
  const down = await startMockOllama(() => 'not json');
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: down.host });
    assert.strictEqual(down.requests.length, 1);
    assert.strictEqual(result.text, PAYROLL);
  } finally {
    await down.close();
  }
});

test('heavy: a failed follow-up keeps the first pass', async () => {
  const mock = await startMockOllama((body) => (kindOf(body) === 'blocks' ? 'not json' : firstPassHandler(body)));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host });
    assert.strictEqual(result.added, 4);
    assert.ok(hasBlockAbove(result.text, 'grossPay'));
    assert.match(result.errors[0], /^block comments: /);
    assert.strictEqual(result.failedWindows, 0);
  } finally {
    await mock.close();
  }
});

for (const [level, added, density] of [
  ['medium', 3, { 'within 5 lines of another comment': 2 }],
  ['low', 1, { 'level limit reached': 3 }],
]) {
  test(`${level}: the same proposals keep the existing limits and get no follow-up`, async () => {
    const mock = await startMockOllama(firstPassHandler);
    try {
      const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level, model: 'm', host: mock.host });
      assert.deepStrictEqual(mock.requests.map(kindOf), ['comments', 'accuracy']);
      assert.strictEqual(result.added, added);
      assert.deepStrictEqual(result.stats.dropped.density, density);
      assert.doesNotMatch(result.text, /\/\*\*/);
      assert.match(result.text, /\/\/ Pays hours past[^\n]*\nfunction grossPay/);
    } finally {
      await mock.close();
    }
  });
}

test('heavy: finds undocumented functions and classes in Python and in languages without a parser', { skip: noPython }, () => {
  const python = [
    'RATE = 1.5',
    '',
    '',
    '# Already documented.',
    'def documented():',
    '    return 1',
    '',
    '',
    '@staticmethod',
    'def decorated():',
    '    return 2',
    '',
    '',
    'class Payroll:',
    '    def run(self):',
    '        return 3',
    '',
  ].join('\n');
  const result = applyProposals({ text: python, language: languageById('python'), level: 'heavy', proposals: [] });
  assert.deepStrictEqual(result.undocumented, [
    { line: 9, name: 'decorated' },
    { line: 14, name: 'Payroll' },
    { line: 15, name: 'run' },
  ]);
});

test('heavy: names Go and Ruby declarations with the existing patterns', () => {
  const go = 'package pay\n\nfunc (p *Payroll) Run(hours int) int {\n\treturn hours\n}\n\nfunc Gross(h int) int {\n\treturn h\n}\n';
  assert.deepStrictEqual(
    applyProposals({ text: go, language: languageById('go'), level: 'heavy', proposals: [] }).undocumented.map((d) => d.name),
    ['Run', 'Gross']
  );
  const ruby = "class Payroll\n  def run(hours)\n    hours\n  end\nend\n";
  assert.deepStrictEqual(
    applyProposals({ text: ruby, language: languageById('ruby'), level: 'heavy', proposals: [] }).undocumented.map((d) => d.name),
    ['Payroll', 'run']
  );
});

test('medium and low never look for undocumented functions', () => {
  for (const level of ['medium', 'low']) {
    assert.deepStrictEqual(applyProposals({ text: PAYROLL, language: js, level, proposals: [] }).undocumented, []);
  }
});
