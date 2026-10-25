'use strict';

// The documentation pass on real-looking projects: folder calls sized to fit, unusable answers
// split and tried again, no file left without a purpose, and layers grounded in real folders.

const assert = require('node:assert');
const { test } = require('node:test');

const { MAX_FILES_PER_CALL, callTokens, planFolderCalls } = require('../src/folders');
const { languageForPath } = require('../src/languages');
const { groupFiles, planGroundedLayers } = require('../src/layers');
const { defaultHandler, kindOf, startMockOllama } = require('./mock-ollama');
const { gitRepo, runAction } = require('./git-repo');

// A file with no leading comment, so the model must give its purpose.
const plain = (name) => `import { x } from './x';\n\nexport function ${name}(input) {\n  return x(input) + 1;\n}\n`;

test('folder calls hold at most 10 files that need a purpose, and fit half the context', () => {
  const files = Array.from({ length: 29 }, (_, i) => ({ path: `src/m${String(i).padStart(2, '0')}.js`, text: plain(`m${i}`), language: languageForPath('a.js') }));
  const calls = planFolderCalls(files, 8192);
  assert.deepStrictEqual(calls.map((c) => c.files.length), [10, 10, 9]);
  for (const call of calls) {
    assert.ok(call.files.filter((f) => !f.purpose).length <= MAX_FILES_PER_CALL);
    assert.ok(callTokens(call.files.map((f) => f.line)) <= 8192 / 2);
  }
});

test('a large folder whose answers are cut off is split and tried again until every file is described by the model', async () => {
  const base = defaultHandler();
  // Like a small model running out of room: an answer for more than 3 files is cut off.
  const mock = await startMockOllama((body, n) => {
    if (kindOf(body) === 'folder' && (body.messages[1].content.match(/^\* /gm) || []).length > 3) return '{"summary": "The folder", "files": [{"name": "m0';
    return base(body, n);
  });
  const repo = gitRepo();
  try {
    const files = {};
    for (let i = 0; i < 29; i++) files[`src/m${String(i).padStart(2, '0')}.js`] = plain(`m${i}`);
    repo.commit(files, 'A large folder');
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    assert.match(run.log, /^summary of src \(part 1 of 3\), 10 files: the answer could not be used \(answer cut off before its end\), trying again with 5 and 5 files$/m);
    assert.doesNotMatch(run.log, /described from its structure/);
    const state = repo.state();
    const summaries = Object.values(state.files).map((e) => e.summary);
    assert.strictEqual(summaries.length, 29);
    // Every purpose came from the model, which names each file's first export.
    assert.ok(summaries.every((s) => /^Defines m\d+ for m\d+\.js\.$/.test(s)), summaries.join(' | '));
    assert.strictEqual(state.docsComplete, true);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('no file is left without a purpose, even when every answer is unusable', async () => {
  const base = defaultHandler();
  const mock = await startMockOllama((body, n) => (kindOf(body) === 'folder' ? 'not JSON at all' : base(body, n)));
  const repo = gitRepo();
  try {
    repo.commit({
      'src/a.js': plain('alpha'),
      'src/b.js': '// Sends the nightly report by email.\nexport function send() {}\n',
      'src/c.js': 'const x = 1;\n',
      'lib/d.py': 'def go():\n    pass\n',
    }, 'Four files');
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    const state = repo.state();
    assert.deepStrictEqual(Object.fromEntries(Object.entries(state.files).map(([file, e]) => [file, e.summary])), {
      'lib/d.py': 'Defines `go`.',
      'src/a.js': 'Defines `alpha`.',
      'src/b.js': 'Sends the nightly report by email.',
      'src/c.js': 'A file in the `src` folder.',
    });
    assert.match(run.log, /src\/a\.js: described from its structure, the answer could not be used \(invalid JSON\)/);
    assert.strictEqual(state.docsComplete, true);
    // The docs list every file.
    const docs = state.layers.map((l) => repo.text('docturnal/update', `docs/${l.slug}.md`)).join('\n');
    for (const file of ['src/a.js', 'src/b.js', 'src/c.js', 'lib/d.py']) assert.ok(docs.includes(file), file);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('layers come from the real folders: test folders join, small groups join a neighbor, and the folder tree decides the groups', () => {
  const files = [
    ...Array.from({ length: 29 }, (_, i) => `src/m${i}.js`),
    ...Array.from({ length: 23 }, (_, i) => `test/t${i}.test.js`),
    ...Array.from({ length: 8 }, (_, i) => `app/src/s${i}.ts`),
    ...Array.from({ length: 7 }, (_, i) => `app/tests/w${i}.spec.ts`),
    'scripts/a.js', 'scripts/b.js', 'scripts/c.js', 'app/scripts/d.mjs', 'app/scripts/e.mjs',
  ];
  assert.deepStrictEqual(groupFiles(files).map((g) => [g.folders.join('+'), g.files.length]), [
    ['app/src+app/scripts', 10], ['scripts', 3], ['src', 29], ['test+app/tests', 30],
  ]);
  // A small project keeps its folders as they are.
  assert.deepStrictEqual(groupFiles(['src/api/users.js', 'src/api/orders.js', 'src/db/client.js', 'lib/util.py']).map((g) => g.folder), ['lib', 'src/api', 'src/db']);
});

test('a layer name the folders do not support, such as "User Interface", is replaced by the folder\'s name', async () => {
  const files = ['src/a.js', 'src/b.js', 'src/c.js', 'app/src/x.ts', 'app/src/y.ts', 'app/src/z.ts'];
  const fileInfo = new Map([
    ['src/a.js', { summary: 'Inserts comments into source files.' }],
    ['src/b.js', { summary: 'Checks each comment for accuracy.' }],
    ['src/c.js', { summary: 'Writes the documentation.' }],
    ['app/src/x.ts', { summary: 'Handles GitHub webhooks.' }],
    ['app/src/y.ts', { summary: 'Serves the settings page.' }],
    ['app/src/z.ts', { summary: 'Runs the hourly schedule.' }],
  ]);
  const prompts = [];
  const call = async (label, request) => {
    prompts.push(request.messages.map((m) => m.content).join('\n'));
    return JSON.stringify({
      layers: [
        // g1 is app/: settings, webhooks, and a schedule, so no user interface.
        { name: 'User Interface', description: 'Shows pages to users.', groups: ['g1'] },
        // g2 is src/, whose files insert and check comments.
        { name: 'Comment Engine', description: 'Adds and checks comments.', groups: ['g2'] },
      ],
    });
  };
  const errors = [];
  const { layers } = await planGroundedLayers({ files, fileInfo, call, contextTokens: 8192, errors });
  assert.deepStrictEqual(layers.map((l) => [l.name, l.files.length, l.description]), [['App', 3, ''], ['Comment Engine', 3, 'Adds and checks comments.']]);
  assert.deepStrictEqual(errors, ['layers: the name "User Interface" is not supported by its folders, so it is named after them']);
  // The prompt shows the real folders and asks for no generic names.
  assert.match(prompts[0], /- g1: app \(3 files\)/);
  assert.match(prompts[0], /- g2: src \(3 files\)/);
  assert.match(prompts[0], /Never use a generic name/);
});
