'use strict';

// Heavy level: a block comment above every function, class, and component, which the
// density limit never drops, plus line comments on constants and complex blocks, which it
// still limits. Code chooses every one of these spots before the model writes a word.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { applyProposals, commentFile } = require('../src/comments');
const { writing } = require('./helpers');
const { findPython } = require('../src/python');
const { languageById } = require('../src/languages');
const { kindOf, startMockOllama, targetsOf } = require('./mock-ollama');

const js = languageById('javascript');
const noPython = !findPython();

// The file from the real test install: 5 functions and 3 constants.
const PAYROLL = fs.readFileSync(path.join(__dirname, 'fixtures/payroll.js'), 'utf8');
const FUNCTIONS = ['grossPay', 'incomeTax', 'netPay', 'formatCurrency', 'payslip'];
const lineOf = (code) => PAYROLL.split('\n').findIndex((l) => l.startsWith(code)) + 1;
const EXPORTS = { exportNames: FUNCTIONS };

// What the model proposed in the real run: one block comment and four line comments.
const FIRST_PASS = [
  { line: lineOf('function grossPay'), text: 'Pays hours past the weekly threshold at the overtime rate.', kind: 'block' },
  { line: lineOf('  const regular'), text: 'Regular hours never exceed the threshold, whatever was logged.', kind: 'line' },
  { line: lineOf('  const overtime'), text: 'Only hours past the threshold earn the multiplier.', kind: 'line' },
  { line: lineOf('const OVERTIME_THRESHOLD_HOURS'), text: 'Weekly hours before overtime starts.', kind: 'line' },
  { line: lineOf('  return Math.round'), text: 'Rounds to cents so payslip totals add up.', kind: 'line' },
];

function hasBlockAbove(text, name) {
  return new RegExp(`/\\*\\*\\n(?: \\*.*\\n)+ \\*/\\n(?:function|const) ${name}\\b`).test(text);
}

// The model's comment for each target: what a function is for, and why for the rest.
const describe = (t) => (t.name && t.kind !== 'constant'
  ? `Works out ${t.name} per employee, without side effects.`
  : t.kind === 'constant' ? 'Hours and rates as the employment contract states them.' : 'Rounds to cents so payslip totals add up.');

const without = (text) => text.split('\n').filter((l) => !/^\s*(\/\*\*| \*|\/\/)/.test(l)).join('\n');

test('heavy: a block comment above a function never uses up the level or the gap', () => {
  const result = applyProposals({ text: PAYROLL, language: js, level: 'heavy', proposals: FIRST_PASS });
  // The line comment directly below the grossPay block is kept; before, the gap rule dropped it.
  assert.match(result.text, /\/\*\*\n \* Pays hours past[^\n]*\n \*\/\nfunction grossPay\(hours, hourlyRate\) \{\n  \/\/ Regular hours never exceed the threshold/);
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

test('heavy: every function in payroll.js gets a block comment, and every comment written is kept', async () => {
  const mock = await startMockOllama(writing(describe));
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host, ...EXPORTS });
    for (const name of FUNCTIONS) assert.ok(hasBlockAbove(result.text, name), `${name}:\n${result.text}`);
    assert.deepStrictEqual(result.undocumented, []);
    assert.deepStrictEqual(result.errors, []);

    // No follow-up request: the requests ask for every function at once, by name and line.
    assert.deepStrictEqual([...new Set(mock.requests.map(kindOf))], ['comments', 'accuracy']);
    const asked = mock.requests.filter((r) => kindOf(r) === 'comments').flatMap(targetsOf);
    // In order of importance: the exported functions, longest first, before the constants.
    assert.deepStrictEqual(asked.slice(0, 5).map((t) => t.kind), Array(5).fill('function'));
    const targets = [...asked].sort((a, b) => a.line - b.line);
    assert.deepStrictEqual(targets.filter((t) => t.kind === 'function').map((t) => `${t.line} ${t.name}`), FUNCTIONS.map((name) => `${lineOf(name === 'formatCurrency' ? 'const formatCurrency' : `function ${name}`)} ${name}`));
    assert.deepStrictEqual(targets.filter((t) => t.kind === 'constant').map((t) => t.name), ['OVERTIME_THRESHOLD_HOURS', 'OVERTIME_MULTIPLIER', 'TAX_BRACKETS']);
    // The magic number 100 in incomeTax is a block of its own.
    assert.deepStrictEqual(targets.filter((t) => t.kind === 'block').map((t) => `${t.line} ${t.fn}: ${t.what}`), [`${lineOf('  return Math.round')} incomeTax: a block in \`incomeTax\` with the number 100`]);
    // Every function asks for its block comment's length, and the rest for a line's.
    for (const t of targets) assert.strictEqual(t.words, t.kind === 'function' ? 50 : 30, t.what);
    // Every comment the model wrote is inserted: nothing is dropped for its place or the level.
    assert.strictEqual(result.stats.proposed, targets.length);
    assert.strictEqual(result.added, targets.length);
    assert.deepStrictEqual(result.rejections, []);
    // The output is valid JavaScript with the original code untouched.
    assert.strictEqual(without(result.text), PAYROLL);
  } finally {
    await mock.close();
  }
});

test('heavy: each request shows only its targets\' code, never the whole file', async () => {
  const mock = await startMockOllama(writing(describe));
  try {
    await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host, ...EXPORTS });
    const system = mock.requests[0].messages[0].content;
    assert.match(system, /- A function, method, class, or component: what it is for, what it takes and returns, and its side effects./);
    assert.match(system, /- A block: what it achieves, and why when the code shows it./);
    for (const request of mock.requests.filter((r) => kindOf(r) === 'comments')) {
      const prompt = request.messages[1].content;
      const shown = [...prompt.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1]));
      assert.ok(shown.length < PAYROLL.split('\n').length, `${shown.length} lines shown`);
      // Each target's own lines are shown, starting with its line.
      for (const t of targetsOf(request)) assert.ok(shown.includes(t.line), `line ${t.line}`);
    }
  } finally {
    await mock.close();
  }
});

test('heavy: a second run asks for nothing that already has a comment', async () => {
  const mock = await startMockOllama(writing(describe));
  try {
    const first = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host, ...EXPORTS });
    const before = mock.requests.length;
    const again = await commentFile({ path: 'src/payroll.js', text: first.text, level: 'heavy', model: 'm', host: mock.host, ...EXPORTS });
    assert.strictEqual(mock.requests.length, before, 'no request on the second run');
    assert.strictEqual(again.text, first.text);
    assert.deepStrictEqual(again.undocumented, []);
  } finally {
    await mock.close();
  }
  const down = await startMockOllama(() => 'not json');
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: down.host, ...EXPORTS });
    assert.ok(down.requests.length >= 1);
    assert.strictEqual(result.text, PAYROLL);
    assert.strictEqual(result.failedRequests, down.requests.length);
  } finally {
    await down.close();
  }
});

test('heavy: a failed request leaves its own targets for the next run and keeps the others', async () => {
  const handler = writing(describe);
  // The request that holds payslip fails, with every target in it, and so does payslip's
  // retry alone; the other functions in it get theirs on their retries.
  let lost = [];
  const mock = await startMockOllama((body) => {
    if (kindOf(body) !== 'comments' || !targetsOf(body).some((t) => t.name === 'payslip')) return handler(body);
    if (!lost.length) lost = targetsOf(body).filter((t) => t.kind === 'function').map((t) => t.name);
    return 'not json';
  });
  try {
    const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level: 'heavy', model: 'm', host: mock.host, ...EXPORTS });
    assert.ok(lost.includes('payslip') && lost.length < FUNCTIONS.length);
    for (const name of FUNCTIONS) assert.strictEqual(hasBlockAbove(result.text, name), name !== 'payslip', name);
    assert.strictEqual(result.failedRequests, 2);
    assert.match(result.errors[0], /^lines [\d, ]+: the reply is not valid JSON$/);
    assert.match(result.errors[1], /^lines \d+: the reply is not valid JSON$/);
    assert.deepStrictEqual(result.undocumented.map((d) => d.name), ['payslip']);
  } finally {
    await mock.close();
  }
});

for (const [level, names] of [
  // Medium: the exported functions, apart by the level's gap; formatCurrency is 3 lines above payslip.
  ['medium', ['grossPay', 'incomeTax', 'netPay', 'payslip']],
  // Low: the room for one comment, given to the longest exported function.
  ['low', ['incomeTax']],
]) {
  test(`${level}: only the declarations the level has room for, as line comments, and none dropped`, async () => {
    const mock = await startMockOllama(writing(describe));
    try {
      const result = await commentFile({ path: 'src/payroll.js', text: PAYROLL, level, model: 'm', host: mock.host, ...EXPORTS });
      const targets = mock.requests.filter((r) => kindOf(r) === 'comments').flatMap(targetsOf).sort((a, b) => a.line - b.line);
      assert.deepStrictEqual(targets.map((t) => t.name), names);
      assert.strictEqual(result.added, names.length);
      assert.deepStrictEqual(result.rejections, []);
      assert.doesNotMatch(result.text, /\/\*\*/);
      for (const name of names) assert.match(result.text, new RegExp(`// Works out ${name}[^\\n]*\\nfunction ${name}`));
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
