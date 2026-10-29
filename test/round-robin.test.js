'use strict';

// Comments in turns: the run plans every file first, then asks for one request per file at
// a time, each file's highest-ranked targets first, new and changed files before the backlog,
// so the time budget spreads over the batch instead of going to the first big file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processItems } = require('../src/process');
const { emptyState } = require('../src/state');
const { defaultHandler } = require('./mock-ollama');

// A file of n exported functions of 4 lines.
function moduleText(prefix, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`export function ${prefix}${i}(items: number[]) {`, '  const kept = items.filter((x) => x > 0);', '  return kept.length;', '}', '');
  return out.join('\n');
}

// Runs processItems on the files, with a clock that moves `ms` for every comment request and
// a quarter of that for other calls, such as an accuracy check.
async function run(files, items, { budget = 90, ms = 30000, level = 'heavy' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-turns-'));
  try {
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, file), text);
    const handler = defaultHandler();
    let clock = 0;
    const order = [];
    const chat = async (request) => {
      const match = /^comments for (\S+), lines? /.exec(request.label || '');
      clock += match ? ms : ms / 4;
      if (match) order.push(match[1]);
      const reply = handler(request);
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    };
    const { results } = await processItems({
      cwd,
      items,
      previous: emptyState(),
      config: { commentLevel: level, contextTokens: 8192, timeBudgetMinutes: budget },
      models: { comment: 'comment-model', docs: 'docs-model' },
      chat,
      now: () => clock,
      started: 0,
      log: () => {},
    });
    return { order, results };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const FILES = { 'big.ts': moduleText('big', 12), 'mid.ts': moduleText('mid', 12), 'small.ts': moduleText('small', 4) };

test('every file gets its first request before any file gets a second, new and changed files first', async () => {
  const items = [
    { path: 'big.ts', kind: 'comment', reason: 'backlog' },
    { path: 'mid.ts', kind: 'comment', reason: 'backlog' },
    { path: 'small.ts', kind: 'comment', reason: 'changed' },
  ];
  const { order } = await run(FILES, items);
  // 12 small functions at heavy are 3 requests of 4; 4 functions are 1.
  assert.deepStrictEqual(order, ['small.ts', 'big.ts', 'mid.ts', 'big.ts', 'mid.ts', 'big.ts', 'mid.ts']);
});

test('a short budget spreads over the files, and a file left without its later requests is not marked done', async () => {
  const items = ['big.ts', 'mid.ts', 'small.ts'].map((file) => ({ path: file, kind: 'comment', reason: 'backlog' }));
  // At 2.5 minutes a call, 30 minutes has room for a few of the 7 requests and their checks.
  const { order, results } = await run(FILES, items, { budget: 30, ms: 150000 });
  assert.ok(order.length >= 3 && order.length < 7, order.join(', '));
  // Every file had its turn before any file had a second.
  assert.deepStrictEqual(order.slice(0, 3), ['big.ts', 'mid.ts', 'small.ts']);
  const byPath = new Map(results.map((r) => [r.path, r]));
  for (const file of ['big.ts', 'mid.ts']) {
    assert.strictEqual(byPath.get(file).outcome, 'commented', file);
    assert.ok(byPath.get(file).report.added > 0, file);
    // big.ts and mid.ts have 3 requests each, and not all of them fit.
    if (order.filter((f) => f === file).length < 3) assert.strictEqual(byPath.get(file).entry.level, null, `${file} waits for a later batch`);
  }
  assert.ok(['big.ts', 'mid.ts'].some((f) => byPath.get(f).entry.level === null));
  assert.strictEqual(byPath.get('small.ts').entry.level, 'heavy');
});

test('new and changed files take all their turns before the backlog takes any', async () => {
  const items = [
    { path: 'mid.ts', kind: 'comment', reason: 'backlog' },
    { path: 'big.ts', kind: 'comment', reason: 'changed' },
  ];
  const { order } = await run(FILES, items);
  assert.deepStrictEqual(order, ['big.ts', 'big.ts', 'big.ts', 'mid.ts', 'mid.ts', 'mid.ts']);
});
