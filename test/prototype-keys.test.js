'use strict';

// Words from code, file and folder names, and README text can be any string, including the
// names a plain object answers from its prototype. Every lookup keyed by them reads only own
// properties, so "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", and
// "prototype" are ordinary words. A run on excalidraw crashed on LassoTrail's constructor.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commentFile } = require('../src/comments');
const { checkInstall } = require('../src/install-ollama');
const { own } = require('../src/own');
const { folderName } = require('../src/parts');
const { planReadme } = require('../src/readme');
const { onlyItsName } = require('../src/restates');
const { emptyState, readState, writeState } = require('../src/state');
const { writing } = require('./helpers');
const { startMockOllama } = require('./mock-ollama');

const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype'];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-proto-'));

test('own reads only own properties', () => {
  for (const name of NAMES) {
    assert.strictEqual(own({}, name), undefined, name);
    assert.strictEqual(own(Object.fromEntries([[name, 1]]), name), 1, name);
  }
  assert.strictEqual(own(null, 'constructor'), undefined);
});

test('onlyItsName takes any name: the words of names from code are not keys of a plain object', () => {
  for (const name of NAMES) {
    assert.doesNotThrow(() => onlyItsName('Builds the lasso trail from the pointer path.', [name, 'LassoTrail']), name);
    assert.strictEqual(onlyItsName('Builds the lasso trail from the pointer path.', [name, 'LassoTrail']), false, name);
  }
  assert.strictEqual(onlyItsName('Converts it to a string.', ['toString']), true);
  assert.strictEqual(onlyItsName('Returns the trail as SVG path data, in scene coordinates.', ['toString', 'LassoTrail']), false);
});

// Shaped like excalidraw's lasso/index.ts: a class whose methods have those names.
const LASSO = [
  'export class LassoTrail {',
  '  private points: number[][] = [];',
  '',
  '  constructor(private readonly app: { scene: unknown }) {',
  '    this.points = [];',
  '  }',
  '',
  '  toString() {',
  '    return this.points.map(([x, y]) => `${x},${y}`).join(" ");',
  '  }',
  '',
  '  valueOf() {',
  '    return this.points.length;',
  '  }',
  '',
  '  hasOwnProperty(key: string) {',
  '    return key in this;',
  '  }',
  '',
  '  __proto__() {',
  '    return null;',
  '  }',
  '',
  '  prototype() {',
  '    return this.app;',
  '  }',
  '}',
  '',
].join('\n');

test('a class with methods named constructor, toString, valueOf, hasOwnProperty, __proto__, and prototype is commented', async () => {
  for (const level of ['low', 'medium', 'heavy']) {
    // Some summaries say no more than the name; the others say more.
    const text = (t) => (t.name === 'toString' ? 'Converts it to a string.' : `Keeps the ${t.name} rule for lasso trails.`);
    const mock = await startMockOllama(writing(text));
    try {
      const result = await commentFile({ path: 'packages/excalidraw/lasso/index.ts', text: LASSO, level, model: 'm', host: mock.host, exportNames: ['LassoTrail'] });
      assert.ok(result.added > 0, level);
      assert.doesNotMatch(result.text, /Converts it to a string/, level);
      assert.deepStrictEqual(result.errors, [], level);
    } finally {
      await mock.close();
    }
  }
});

test('the state keeps files and folders named like prototype keys as its own entries', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.docturnal'));
    const state = emptyState();
    state.files = Object.fromEntries(NAMES.map((name, i) => [name, { hash: `h${i}` }]));
    state.folders = Object.fromEntries(NAMES.map((name) => [name, `The ${name} folder.`]));
    writeState(dir, state);
    const read = readState(dir);
    assert.strictEqual(Object.getPrototypeOf(read.files), Object.prototype);
    assert.strictEqual(Object.getPrototypeOf(read.folders), Object.prototype);
    NAMES.forEach((name, i) => {
      assert.strictEqual(own(read.files, name).hash, `h${i}`, name);
      assert.strictEqual(own(read.folders, name), `The ${name} folder.`, name);
    });
    assert.deepStrictEqual(Object.keys(read.files).sort(), [...NAMES].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('folder names that are prototype keys are named like any other folder', () => {
  assert.strictEqual(folderName('constructor'), 'Constructor');
  assert.strictEqual(folderName('src/toString'), 'Source ToString');
  assert.strictEqual(folderName('packages/__proto__'), 'Packages Proto');
  assert.strictEqual(folderName('hasOwnProperty'), 'HasOwnProperty');
});

test('README blocks named like prototype keys are left as a person wrote them', async () => {
  const blocks = { layers: 'The layers.', scripts: 'The scripts.', tree: 'The tree.' };
  const run = (current, saved) => planReadme({
    current,
    saved,
    blocks,
    regenerate: false,
    name: 'excalidraw',
    facts: { description: '', envVars: [], scripts: {}, packageManagers: ['npm'] },
    generate: async () => ({ prose: { intro: 'Excalidraw draws diagrams.' }, fallback: false }),
  });
  const person = '# Excalidraw\n\n## Notes\n\n<!-- docturnal:constructor -->\nKept as it is.\n<!-- /docturnal:constructor -->\n\n<!-- docturnal:prototype -->\nThis too.\n<!-- /docturnal:prototype -->\n';
  const first = await run(person, null);
  assert.ok(first.content === null || first.content.includes('<!-- docturnal:constructor -->\nKept as it is.\n<!-- /docturnal:constructor -->'));
  // The person removes one of those blocks: nothing is suppressed under a prototype's name.
  const current = (first.content || person).replace(/<!-- docturnal:constructor -->[\s\S]*?<!-- \/docturnal:constructor -->\n/, '');
  const second = await run(current, first.state);
  for (const s of second.state.suppressed || []) assert.strictEqual(typeof s.heading, 'string', s.key);
  assert.ok((second.content || current).includes('<!-- docturnal:prototype -->\nThis too.'));
});

test('an Ollama install with files named like prototype keys fails its check, without a crash', () => {
  const dir = tmp();
  try {
    for (const name of ['constructor', 'toString', 'valueOf']) fs.writeFileSync(path.join(dir, name), 'x');
    assert.match(checkInstall(dir, { files: {}, links: {} }), /^(constructor|toString|valueOf) does not match its pinned hash$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
