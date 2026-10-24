'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cleanText, commentFile, buildWindows } = require('../src/comments');
const { applyAnchored: applyProposals, withAccuracy, withAnchor } = require('./helpers');
const { classifyFile, languageById } = require('../src/languages');
const { baseUrl } = require('../src/ollama');
const { findPython } = require('../src/python');
const { verifyCandidates } = require('../src/verify');
const { splitLines } = require('../src/analyze');
const { kindOf, startMockOllama } = require('./mock-ollama');

const noPython = findPython() ? false : 'python3 is not available';

const lang = (id) => languageById(id);
const source = (lines) => lines.join('\n') + '\n';
const reasons = (result) => result.rejections.map((r) => `${r.line}: ${r.reason}`);

// Builds a hand-made candidate that inserts one line before `beforeLine`, bypassing the filters.
function forcedInsertion(text, beforeLine, commentLine) {
  const lines = text.split('\n');
  lines.splice(beforeLine - 1, 0, commentLine);
  return { text: lines.join('\n'), inserted: [beforeLine - 1] };
}

// --- Acceptance: unsafe positions are rejected, valid comments are kept ---

const TEMPLATE_JS = source([
  'function greet(name) {',
  '  const message = `Hello ${name},',
  '  welcome back.`;',
  '  return message;',
  '}',
]);

test('rejects a comment inside a template literal and keeps a valid one', () => {
  const result = applyProposals({
    text: TEMPLATE_JS,
    language: lang('javascript'),
    level: 'medium',
    proposals: [
      { line: 3, text: 'Second line of the greeting.', kind: 'line' },
      { line: 2, text: 'The greeting spans two lines on purpose.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), ['3: inside a string, template literal, JSX, or block comment']);
  assert.strictEqual(result.text, source([
    'function greet(name) {',
    '  // The greeting spans two lines on purpose.',
    '  const message = `Hello ${name},',
    '  welcome back.`;',
    '  return message;',
    '}',
  ]));
});

test('verification catches a comment forced into a template literal', () => {
  const candidate = forcedInsertion(TEMPLATE_JS, 3, '  // sneaky');
  assert.deepStrictEqual(verifyCandidates(lang('javascript'), TEMPLATE_JS, [candidate]), [false]);
});

const DOCSTRING_PY = source([
  'def load(path):',
  '    """Read the config file.',
  '',
  '    Returns a dict.',
  '    """',
  '    with open(path) as f:',
  '        return parse(f)',
]);

test('rejects a comment inside a Python triple-quoted string and keeps a valid one', { skip: noPython }, () => {
  const result = applyProposals({
    text: DOCSTRING_PY,
    language: lang('python'),
    level: 'medium',
    proposals: [
      { line: 4, text: 'Describe the return value.', kind: 'line' },
      { line: 6, text: 'The file is closed even when parsing fails.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), ['4: inside a string, template literal, JSX, or block comment']);
  assert.match(result.text, /    """\n    # The file is closed even when parsing fails\.\n    with open/);
});

test('verification catches a comment forced into a Python docstring', { skip: noPython }, () => {
  const candidate = forcedInsertion(DOCSTRING_PY, 4, '    # sneaky');
  assert.deepStrictEqual(verifyCandidates(lang('python'), DOCSTRING_PY, [candidate]), [false]);
});

const BANNER_TSX = source([
  'export function Banner({ user }: { user: string }) {',
  '  const greeting = user.trim();',
  '  return (',
  '    <div className="banner">',
  '      Welcome back',
  '      <strong>{greeting}</strong>',
  '    </div>',
  '  );',
  '}',
]);

test('rejects comments that would become JSX text in a .tsx file and keeps a valid one', () => {
  const result = applyProposals({
    text: BANNER_TSX,
    language: lang('tsx'),
    level: 'medium',
    proposals: [
      { line: 5, text: 'Shown before the user name.', kind: 'line' },
      { line: 6, text: 'Bold so the name stands out.', kind: 'line' },
      { line: 2, text: 'Names can arrive with stray whitespace from the form.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), [
    '5: inside a string, template literal, JSX, or block comment',
    '6: inside a string, template literal, JSX, or block comment',
  ]);
  assert.match(result.text, /\{\n  \/\/ Names can arrive with stray whitespace from the form\.\n  const greeting/);
});

test('verification catches a comment forced between JSX tags', () => {
  const candidate = forcedInsertion(BANNER_TSX, 5, '      // sneaky');
  assert.deepStrictEqual(verifyCandidates(lang('tsx'), BANNER_TSX, [candidate]), [false]);
});

// --- One passing case per level ---

test('low: keeps one short comment, enforces spacing and word limit', () => {
  const lines = [];
  // 56 code lines, so the low level allows two comments and spacing decides.
  for (const name of ['score', 'weight', 'blend', 'scale', 'rank', 'mix', 'sum', 'fold']) {
    lines.push(
      `function ${name}(values, weights) {`,
      '  let total = 0;',
      '  for (let i = 0; i < values.length; i++) {',
      '    total += values[i] * weights[i];',
      '  }',
      '  return total;',
      '}'
    );
  }
  const text = source(lines);
  const result = applyProposals({
    text,
    language: lang('javascript'),
    level: 'low',
    proposals: [
      { line: 4, text: 'Weights are assumed to sum to one.', kind: 'line' },
      { line: 6, text: 'Callers rely on this.', kind: 'line' },
      { line: 25, text: 'This comment is far too long for the low level because it keeps going on and on.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), ['25: longer than 10 words', '6: within 15 lines of another comment']);
  assert.match(result.text, /\n    \/\/ Weights are assumed to sum to one\.\n    total \+=/);
});

const MAIN_GO = [
  'package main',
  '',
  'import (',
  '\t"fmt"',
  '\t"strings"',
  ')',
  '',
  'const usage = `Usage:',
  '  tool run',
  '`',
  '',
  'func main() {',
  '\targs := strings.Fields("run fast")',
  '\tif len(args) > 1 {',
  '\t\tfmt.Println(args[1])',
  '\t}',
  '\tfmt.Print(usage)',
  '}',
];

test('medium: Go file uses placement rules, rejects raw strings and imports', () => {
  const result = applyProposals({
    text: source(MAIN_GO),
    language: lang('go'),
    level: 'medium',
    proposals: [
      { line: 9, text: 'Example command.', kind: 'line' },
      { line: 4, text: 'Formatting.', kind: 'line' },
      { line: 16, text: 'End of check.', kind: 'line' },
      { line: 13, text: 'Fields splits on any run of spaces, so repeated spaces never create empty arguments.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), [
    '9: inside a string, template literal, JSX, or block comment',
    '4: import',
    '16: closing bracket',
  ]);
  assert.match(result.text, /\{\n\t\/\/ Fields splits on any run of spaces, so repeated spaces never create empty arguments\.\n\targs :=/);
});

const RETRY_JS = source([
  'function retry(fn, attempts) {',
  '  let lastError;',
  '  for (let i = 0; i < attempts; i++) {',
  '    try {',
  '      return fn();',
  '    } catch (err) {',
  '      lastError = err;',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
]);
const RETRY_PROPOSALS = [
  { line: 10, text: 'Rethrow the final failure instead of a generic error.', kind: 'line' },
  {
    line: 1,
    text: 'Calls fn until it succeeds or the attempts run out.\n\nThrows the last error so callers see the real failure.',
    kind: 'block',
  },
];

test('heavy: JSDoc block above a function plus a line comment', () => {
  const result = applyProposals({ text: RETRY_JS, language: lang('javascript'), level: 'heavy', proposals: RETRY_PROPOSALS });
  assert.strictEqual(result.added, 2);
  assert.strictEqual(result.text, source([
    '/**',
    ' * Calls fn until it succeeds or the attempts run out.',
    ' *',
    ' * Throws the last error so callers see the real failure.',
    ' */',
    'function retry(fn, attempts) {',
    '  let lastError;',
    '  for (let i = 0; i < attempts; i++) {',
    '    try {',
    '      return fn();',
    '    } catch (err) {',
    '      lastError = err;',
    '    }',
    '  }',
    '  // Rethrow the final failure instead of a generic error.',
    '  throw lastError;',
    '}',
  ]));
});

test('heavy: Python block moves above a multi-line decorator', { skip: noPython }, () => {
  const text = source([
    'import functools',
    '',
    '',
    '@functools.lru_cache(',
    '    maxsize=None,',
    ')',
    'def fib(n):',
    '    if n < 2:',
    '        return n',
    '    return fib(n - 1) + fib(n - 2)',
  ]);
  const result = applyProposals({
    text,
    language: lang('python'),
    level: 'heavy',
    proposals: [
      { line: 1, text: 'Caching.', kind: 'line' },
      { line: 7, text: 'Returns the nth Fibonacci number.\n\nThe cache keeps the naive recursion linear.', kind: 'block' },
      { line: 10, text: 'Plain recursion is fine because the cache runs each n once.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 2);
  assert.deepStrictEqual(reasons(result), ['1: import']);
  assert.match(result.text, /\n\n# Returns the nth Fibonacci number\.\n#\n# The cache keeps the naive recursion linear\.\n@functools\.lru_cache\(/);
  assert.match(result.text, /\n    # Plain recursion is fine because the cache runs each n once\.\n    return fib/);
});

test('TypeScript decorators: comment moves above the decorator', () => {
  const text = source([
    'class Service {',
    '  @memoize()',
    '  load(id: string) {',
    '    return fetchUser(id);',
    '  }',
    '}',
  ]);
  const result = applyProposals({
    text,
    language: lang('typescript'),
    level: 'medium',
    proposals: [{ line: 3, text: 'Repeated loads for one id share a single request.', kind: 'line' }],
  });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\n  \/\/ Repeated loads for one id share a single request\.\n  @memoize\(\)\n  load/);
});

// --- Text filters ---

test('directive filter rejects tool directives', () => {
  const js = lang('javascript');
  for (const text of [
    'eslint-disable-next-line no-console',
    '@ts-ignore the types are wrong here',
    'ts-expect-error until the upstream fix',
    'prettier-ignore',
    'istanbul ignore next',
    'noqa: E501',
    'type: ignore',
    'pragma: no cover',
    'nolint',
  ]) {
    assert.strictEqual(cleanText(text, js).reason, 'tool directive', text);
  }
  assert.strictEqual(cleanText('Keeps the cache warm between requests.', js).reason, undefined);

  const result = applyProposals({
    text: RETRY_JS,
    language: js,
    level: 'medium',
    proposals: [{ line: 2, text: 'eslint-disable-line prefer-const', kind: 'line' }],
  });
  assert.strictEqual(result.added, 0);
  assert.deepStrictEqual(reasons(result), ['2: tool directive']);
});

test('strips comment markers and escapes */', () => {
  const js = lang('javascript');
  assert.deepStrictEqual(cleanText('// Handles */ in input', js).paragraphs, ['Handles *\\/ in input']);
  assert.deepStrictEqual(cleanText('/** Wraps the client */', js).paragraphs, ['Wraps the client']);
  assert.deepStrictEqual(cleanText('# Retries once', lang('python')).paragraphs, ['Retries once']);
  assert.strictEqual(cleanText('Uses the @type tag', js).reason, 'JSDoc tag');
  assert.strictEqual(cleanText('Fast path 🚀', js).reason, 'emoji');
});

// --- Files that already have comments ---

const COMMENTED_JS = source([
  '// Parses CLI flags into an options object.',
  'function parseFlags(argv) {',
  '  const options = {};',
  '  for (const arg of argv) {',
  '    // Flags without a value are treated as true.',
  "    const [key, value = 'true'] = arg.split('=');",
  "    options[key.replace(/^--/, '')] = value;",
  '  }',
  '  return options;',
  '}',
]);

const COMMENTED_PROPOSALS = [
  { line: 5, text: 'Duplicate.', kind: 'line' },
  { line: 6, text: 'Splits only on the first equals sign.', kind: 'line' },
  { line: 2, text: 'Another comment on the function.', kind: 'line' },
  { line: 9, text: 'Callers mutate the returned object.', kind: 'line' },
];

test('existing comments count toward the level and block stacking', () => {
  const result = applyProposals({ text: COMMENTED_JS, language: lang('javascript'), level: 'medium', proposals: COMMENTED_PROPOSALS });
  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.text, COMMENTED_JS);
  assert.deepStrictEqual(reasons(result), [
    '5: existing comment',
    '6: previous line is a comment',
    '2: previous line is a comment',
    '9: level limit reached',
  ]);
});

test('heavy: an existing comment above a function does not count toward the level', () => {
  const result = applyProposals({ text: COMMENTED_JS, language: lang('javascript'), level: 'heavy', proposals: COMMENTED_PROPOSALS });
  assert.strictEqual(result.added, 1);
  assert.match(result.text, /\n  \/\/ Callers mutate the returned object\.\n  return options;/);
  assert.deepStrictEqual(reasons(result), [
    '5: existing comment',
    '6: previous line is a comment',
    '2: previous line is a comment',
  ]);
});

test('re-running on already commented output stays within the level', () => {
  const first = applyProposals({ text: RETRY_JS, language: lang('javascript'), level: 'heavy', proposals: RETRY_PROPOSALS });
  // first.text: the block is lines 1 to 5, "function retry" is line 6, and the loop is line 8.
  const rerun = (text) => applyProposals({
    text,
    language: lang('javascript'),
    level: 'heavy',
    proposals: [
      { line: 6, text: 'Another block on the function.', kind: 'block' },
      { line: 8, text: 'Loops once per attempt.', kind: 'line' },
      { line: 12, text: 'Keeps only the latest error.', kind: 'line' },
    ],
  });
  const second = rerun(first.text);
  assert.strictEqual(second.added, 1);
  assert.deepStrictEqual(reasons(second), ['6: previous line is a comment', '12: level limit reached']);
  const third = rerun(second.text);
  assert.strictEqual(third.added, 0);
  assert.strictEqual(third.text, second.text);
});

// --- Formatting and safety details ---

test('keeps CRLF line endings and the byte order mark', () => {
  const text = '﻿const a = 1;\r\nconst b = compute(a);\r\n';
  const result = applyProposals({
    text,
    language: lang('javascript'),
    level: 'medium',
    proposals: [{ line: 2, text: 'Compute is pure, so this is safe to cache.', kind: 'line' }],
  });
  assert.strictEqual(result.added, 1);
  assert.strictEqual(result.text, '﻿const a = 1;\r\n// Compute is pure, so this is safe to cache.\r\nconst b = compute(a);\r\n');
});

test('never inserts above a shebang', () => {
  const text = source(['#!/usr/bin/env node', "console.log('hi');"]);
  const result = applyProposals({
    text,
    language: lang('javascript'),
    level: 'medium',
    proposals: [{ line: 1, text: 'Entry point.', kind: 'line' }],
  });
  assert.strictEqual(result.added, 0);
  assert.deepStrictEqual(reasons(result), ['1: shebang or encoding line']);
});

test('shell: heredoc bodies are rejected and a shebang does not count as a comment', () => {
  const text = source(['#!/bin/bash', 'echo $#', 'cat <<EOF', '  inside heredoc', 'EOF', 'count=${#items[@]}', 'deploy "$1"']);
  const result = applyProposals({
    text,
    language: lang('shell'),
    level: 'medium',
    proposals: [
      { line: 4, text: 'Heredoc body.', kind: 'line' },
      { line: 7, text: 'Deploys the first argument only.', kind: 'line' },
    ],
  });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(reasons(result), ['4: inside a string, template literal, JSX, or block comment']);
  assert.match(result.text, /\n# Deploys the first argument only\.\ndeploy/);
});

test('level off adds nothing', () => {
  const result = applyProposals({ text: RETRY_JS, language: lang('javascript'), level: 'off', proposals: RETRY_PROPOSALS });
  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.text, RETRY_JS);
});

test('windows split long files into line ranges that fit the budget', () => {
  const lines = splitLines(source(Array.from({ length: 3000 }, (_, i) => `const value${i} = compute(${i});`)));
  const windows = buildWindows(lines, 4096);
  assert.ok(windows.length > 1);
  assert.strictEqual(windows[0].start, 0);
  assert.strictEqual(windows[windows.length - 1].end, 3000);
  for (let i = 1; i < windows.length; i++) assert.strictEqual(windows[i].start, windows[i - 1].end);
});

// --- End to end with the mock Ollama server ---

test('commentFile asks the model per window and applies its proposals', async () => {
  const mock = await startMockOllama(withAccuracy(() => ({
    summary: 'Retries a function a fixed number of times.',
    symbols: ['retry'],
    comments: [withAnchor(RETRY_JS, { line: 10, text: 'Rethrow the final failure instead of a generic error.', kind: 'line' })],
  })));
  try {
    const result = await commentFile({
      path: 'src/retry.js',
      text: RETRY_JS,
      level: 'medium',
      model: 'qwen2.5-coder:3b',
      host: mock.host,
    });
    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.summary, 'Retries a function a fixed number of times.');
    assert.deepStrictEqual(result.symbols, ['retry']);
    assert.match(result.text, /\/\/ Rethrow the final failure/);

    // One request for proposals, then one accuracy check.
    assert.deepStrictEqual(mock.requests.map(kindOf), ['comments', 'accuracy']);
    const request = mock.requests[0];
    assert.strictEqual(request.model, 'qwen2.5-coder:3b');
    assert.strictEqual(request.stream, false);
    assert.deepStrictEqual(request.format.required, ['summary', 'symbols', 'comments']);
    assert.match(request.messages[1].content, /^File: src\/retry\.js\nLanguage: JavaScript\n/);
    assert.match(request.messages[1].content, /\n10\|   throw lastError;/);
  } finally {
    await mock.close();
  }
});

test('commentFile survives a malformed model response', async () => {
  const mock = await startMockOllama(() => 'not json');
  try {
    const result = await commentFile({ path: 'src/retry.js', text: RETRY_JS, level: 'medium', model: 'm', host: mock.host });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.failedWindows, 1);
    assert.strictEqual(result.text, RETRY_JS);
  } finally {
    await mock.close();
  }
});

test('the Ollama client refuses non-local hosts', () => {
  assert.throws(() => baseUrl('example.com:11434'), /only talks to a local server/);
  assert.strictEqual(baseUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434');
});

// --- File selection ---

test('classifyFile comments code, reads config for docs, and skips the rest', () => {
  const action = (file, opts) => classifyFile(file, opts).action;
  assert.strictEqual(action('src/app.ts'), 'comment');
  assert.strictEqual(action('lib/util.py'), 'comment');
  assert.strictEqual(action('package.json'), 'docs');
  assert.strictEqual(action('services/api/Dockerfile'), 'docs');
  assert.strictEqual(action('docker-compose.yml'), 'docs');
  assert.strictEqual(action('schema.prisma'), 'docs');
  assert.strictEqual(action('node_modules/x/index.js'), 'skip');
  assert.strictEqual(action('dist/bundle.js'), 'skip');
  assert.strictEqual(action('.github/workflows/ci.yml'), 'skip');
  assert.strictEqual(action('.docturnal/state.json'), 'skip');
  assert.strictEqual(action('docs/README.md'), 'skip');
  assert.strictEqual(action('manual/guide.js', { docsDir: 'manual' }), 'skip');
  assert.strictEqual(action('package-lock.json'), 'skip');
  assert.strictEqual(action('app.min.js'), 'skip');
  assert.strictEqual(action('big.js', { size: 300 * 1024 }), 'skip');
  assert.strictEqual(action('image.js', { sample: Buffer.from([0x47, 0x00, 0x49]) }), 'skip');
  assert.strictEqual(action('src/legacy/old.js', { exclude: ['legacy'] }), 'skip');
  assert.strictEqual(action('src/gen/types.ts', { exclude: ['src/gen/**'] }), 'skip');
  assert.strictEqual(action('src/app.ts', { extensions: ['py'] }), 'skip');
});
