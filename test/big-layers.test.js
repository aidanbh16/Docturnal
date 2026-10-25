'use strict';

// The issues from the third real first run on this repository, all in how big layers are
// written, reproduced with its real files, folder summaries, file purposes, definitions, and
// published docs (test/fixtures/docturnal-run3.json): a layer doc cut off mid-sentence at the
// output limit, a Responsibilities list of all 32 file purposes, all of src/ in one layer, and
// an Overview that says the same thing twice.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const docs = require('../src/docs');
const grounding = require('../src/grounding');
const ollama = require('../src/ollama');
const { clusterFiles } = require('../src/clusters');
const { MAX_LAYERS, copiesPurpose, groupFiles } = require('../src/layers');
const { cutOff, defaultHandler, kindOf, startMockOllama } = require('./mock-ollama');
const { gitRepo, runAction } = require('./git-repo');

const RUN = require('./fixtures/docturnal-run3.json');
const FILES = Object.keys(RUN.files).sort();
const SRC = FILES.filter((f) => f.startsWith('src/'));
const FILE_INFO = new Map(Object.entries(RUN.files));
const FOLDERS = new Map(Object.entries(RUN.folders));
const PURPOSES = Object.values(RUN.files).map((f) => f.summary);
const importsOf = (file) => RUN.imports[file] || [];
const purposeOf = (file) => RUN.files[file].summary;
const readRepo = (file) => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  } catch {
    return null;
  }
};
const layerNamed = (name) => RUN.layers.find((l) => l.name === name);
const section = (text, heading) => ((text.match(new RegExp(`^## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm')) || [])[1] || '').trim();
const items = (text) => text.split('\n').filter((line) => /^\s*[-*+]\s/.test(line));
// The published doc, as the model's reply: the computed parts in it are dropped again.
const reply = (doc) => doc.split('\n').slice(1).join('\n');

// --- 3. Big flat folders split into layers by their imports ---

test('src/ splits by its imports into the comment engine, the docs, Ollama and its models, and git and state', () => {
  const groups = groupFiles(FILES, importsOf, purposeOf);
  assert.ok(groups.length <= MAX_LAYERS, `${groups.length} groups`);
  const parts = groups.filter((g) => g.part && g.part.of === 'src');
  assert.strictEqual(parts.length, 4);
  for (const part of parts) assert.ok(part.files.length >= 3, part.files.join(', '));
  assert.deepStrictEqual(parts.flatMap((p) => p.files).sort(), SRC);

  const partOf = (name) => parts.find((p) => p.files.includes(`src/${name}`));
  const together = [
    ['comments.js', 'accuracy.js', 'analyze.js', 'owned.js', 'restates.js', 'verify.js', 'python.js'],
    ['docs.js', 'layers.js', 'grounding.js', 'configuration.js', 'links.js'],
    ['ollama.js', 'install-ollama.js', 'models.js', 'verify-models.js'],
    ['git.js', 'state.js', 'changes.js', 'apply.js', 'main.js'],
  ];
  for (const set of together) {
    for (const name of set) assert.strictEqual(partOf(name), partOf(set[0]), `${name} is with ${set[0]}`);
  }
  assert.strictEqual(new Set(together.map((set) => partOf(set[0]))).size, 4);

  // The tests stay one layer, and hold only tests.
  const tests = groups.filter((g) => g.files.some((f) => /^(test|app\/tests)\//.test(f)));
  assert.strictEqual(tests.length, 1);
  assert.ok(!tests[0].part);
  assert.ok(tests[0].files.every((f) => /^(test|app\/tests)\//.test(f)));
  // The same files in another order give the same parts.
  const again = groupFiles([...FILES].reverse(), importsOf, purposeOf).filter((g) => g.part);
  assert.deepStrictEqual(again.map((g) => g.files), parts.map((g) => g.files));
});

test('a group splits only above 15 files, into at most 4 parts of at least 3 files each', () => {
  // 15 files stay one group.
  const fifteen = SRC.slice(0, 15).map((f) => f.replace('src/', 'lib/'));
  const groups = groupFiles([...fifteen, 'test/a.test.js'], () => [], () => '');
  assert.ok(groups.every((g) => !g.part));
  // A cluster smaller than 3 files joins another, and there are never more than 4.
  for (const max of [2, 3, 4]) {
    const parts = clusterFiles(SRC, { importsOf, purposeOf, maxClusters: max, minSize: 3 });
    assert.ok(parts.length <= max && parts.length >= 2);
    assert.ok(parts.every((p) => p.length >= 3));
  }
  // Two files that only import each other would be a cluster of two: they join another.
  const clique = (prefix, n) => Array.from({ length: n }, (_, i) => `lib/${prefix}${i}.js`);
  const a = clique('a', 6);
  const b = clique('b', 6);
  const pair = ['lib/x.js', 'lib/y.js'];
  const graph = new Map([...a.map((f) => [f, a]), ...b.map((f) => [f, b]), ['lib/x.js', ['lib/y.js']], ['lib/y.js', ['lib/x.js']]]);
  const small = clusterFiles([...a, ...b, ...pair], { importsOf: (f) => graph.get(f) || [], maxClusters: 4 });
  assert.strictEqual(small.length, 2);
  assert.ok(small.every((p) => p.length >= 3));
  // Too few files for two parts of 3: one cluster.
  assert.strictEqual(clusterFiles(SRC.slice(0, 5), { importsOf, purposeOf }).length, 1);
});

test('each part of src/ is a layer of its own with its own doc, named from its files, never merged back', async () => {
  const groups = groupFiles(FILES, importsOf, purposeOf);
  const idOf = (name) => groups.find((g) => g.files.includes(`src/${name}`)).id;
  const others = groups.filter((g) => !g.part);
  const answer = {
    layers: [
      // The model puts two parts in one layer: they stay apart.
      { name: 'Comment Engine', description: 'Plans, checks, and inserts comments, and proves the code is unchanged.', groups: [idOf('comments.js'), idOf('docs.js')] },
      { name: 'Ollama Models', description: 'Installs Ollama, picks its models, and checks them against their pins.', groups: [idOf('ollama.js')] },
      // A name only the summary of all of src/ supports ("line analysis, file processing, and
      // language detection"), not this part's own files.
      { name: 'Language Detection', description: 'The rules.', groups: [idOf('git.js')] },
      ...others.map((g) => ({ name: '', description: '', groups: [g.id] })),
    ],
  };
  const written = [];
  const chat = async (request) => {
    if (request.format) return JSON.stringify(answer);
    written.push(request.label);
    return '# X\n\nIntro.';
  };
  const result = await docs.generateDocs({
    files: FILES.map((f) => ({ path: f, ...RUN.files[f] })),
    allFiles: FILES,
    // This repository's real files, for their imports; the docs are not there yet.
    readFile: (file) => (file.startsWith('docs/') ? null : readRepo(file)),
    root: path.join(__dirname, 'fixtures', 'no-such-folder'),
    model: 'docs',
    chat,
    projectName: 'docturnal',
    folders: FOLDERS,
  });
  const srcLayers = result.layers.filter((l) => l.files.every((f) => f.startsWith('src/')));
  assert.strictEqual(srcLayers.length, 4);
  assert.ok(result.layers.length <= MAX_LAYERS);
  const names = srcLayers.map((l) => l.name);
  assert.ok(names.includes('Comment Engine'));
  assert.ok(names.includes('Ollama Models'));
  assert.ok(!names.includes('Language Detection'));
  // The two parts without a supported name are named after src/ and their most central file.
  assert.strictEqual(new Set(names).size, 4);
  assert.ok(names.filter((n) => n.startsWith('Source ')).length === 2, names.join(', '));
  assert.ok(result.errors.some((e) => /"Language Detection" is not supported/.test(e)));
  // One doc for each layer, each part included.
  for (const layer of srcLayers) assert.ok(written.includes(`docs/${layer.slug}.md`), layer.slug);
  assert.strictEqual(new Set(srcLayers.map((l) => l.slug)).size, 4);
  // A part's fallback description never borrows the summary of all of src/.
  for (const layer of srcLayers.filter((l) => l.name.startsWith('Source '))) {
    assert.notStrictEqual(layer.description, docs.normalizeLayers(null, SRC, { folders: FOLDERS })[0].description);
    assert.match(layer.description, /^Holds `[^`]+`, .+ in `src\/`\.$/);
  }
});

// --- 1. A reply cut off at its output limit ---

test('a reply that stops at its output limit is cut back to its last complete sentence or list item', async () => {
  // The real source.md reply ended mid-item: "- **ollama.js**: A minimal client".
  const raw = reply(RUN.docs.source);
  assert.match(raw, /- \*\*ollama\.js\*\*: A minimal client\n/);
  const stats = {};
  const text = docs.completeReply({ content: raw.slice(0, raw.indexOf('\n\n## Configuration')), doneReason: 'length' }, stats);
  assert.strictEqual(stats.cutReplies, 1);
  const doc = docs.buildLayerDoc(text, { layer: layerNamed('Source'), layers: RUN.layers, fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  const how = section(doc, 'How it works');
  assert.doesNotMatch(doc, /A minimal client/);
  assert.match(how, /- \*\*models\.js\*\*: Selects the appropriate Ollama models for processing\.$/);
  // Every line of prose ends a sentence.
  for (const line of how.split('\n').filter(Boolean)) assert.match(line, /[.!?]$/, line);

  // A reply that finished keeps its text as it is.
  assert.strictEqual(docs.completeReply({ content: 'Ends mid', doneReason: 'stop' }, stats), 'Ends mid');
  assert.strictEqual(stats.cutReplies, 1);

  // Paragraphs, headings, and code blocks.
  assert.strictEqual(docs.cutToComplete('One. Two, e.g. the next is cut'), 'One.');
  assert.strictEqual(docs.cutToComplete('Intro.\n\n## How it wo'), 'Intro.');
  assert.strictEqual(docs.cutToComplete('Intro.\n\n## How it works\n\nThe client'), 'Intro.');
  assert.strictEqual(docs.cutToComplete('Intro.\n\n```js\nconst a = 1;'), 'Intro.');
  assert.strictEqual(docs.cutToComplete('- First item.\n- Second item, which\n  continues'), '- First item.');
});

test('the Ollama client reports a reply cut at num_predict, and the log says so', async () => {
  const mock = await startMockOllama(() => cutOff('Complete. Not compl'));
  try {
    const lines = [];
    const chat = ollama.loggedChat(ollama.chat, { log: (line) => lines.push(line) });
    const result = await chat({ host: mock.host, model: 'm', label: 'docs/source.md', messages: [{ role: 'user', content: 'x' }], withReason: true });
    assert.deepStrictEqual(result, { content: 'Complete. Not compl', doneReason: 'length' });
    assert.match(lines[0], /^Ollama: docs\/source\.md with m, [\d.]+ s, stopped at its length limit$/);
    // Without withReason, the text as before.
    assert.strictEqual(await ollama.chat({ host: mock.host, model: 'm', messages: [{ role: 'user', content: 'x' }] }), 'Complete. Not compl');
  } finally {
    await mock.close();
  }
});

test('in a run, a layer doc and the README cut off at the limit end at a complete sentence, and the log counts them', async () => {
  const base = defaultHandler();
  const mock = await startMockOllama((body, n) => {
    const kind = kindOf(body);
    if (kind === 'layer-doc') return cutOff('# Source\n\nThe `src` folder holds the code for `a`, `b`, and `c`.\n\n## How it works\n\n- `a.js` holds the code for `a`.\n- `b.js` hol');
    if (kind === 'readme') return cutOff(`${base(body, n)}\n\nThe code in \`src\` is spl`);
    return base(body, n);
  });
  const repo = gitRepo();
  try {
    repo.commit({ 'src/a.js': 'export function a() {}\n', 'src/b.js': 'export function b() {}\n', 'src/c.js': 'export function c() {}\n' }, 'Code');
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    const { layers } = JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    const layerDoc = repo.text('docturnal/update', `docs/${layers[0].slug}.md`);
    assert.doesNotMatch(layerDoc, /b\.js` hol/);
    assert.match(layerDoc, /## How it works\n\n- `a\.js` holds the code for `a`\.\n/);
    const readme = repo.text('docturnal/update', 'README.md');
    assert.doesNotMatch(readme, /is spl/);
    assert.match(run.log, /stopped at its length limit/);
    assert.match(run.log, /Docturnal: 2 replies for the docs reached the length limit, so each was cut back to its last complete sentence/);
  } finally {
    await mock.close();
  }
});

// --- 2. Responsibilities describe the layer ---

test('Responsibilities never lists file purposes: the real list of 32 purposes is dropped, and at most 6 items stay', () => {
  const stats = {};
  const raw = reply(RUN.docs.source);
  assert.strictEqual(items(section(RUN.docs.source, 'Responsibilities')).length, 32);
  const doc = docs.buildLayerDoc(raw, { layer: layerNamed('Source'), layers: RUN.layers, fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  const kept = items(section(doc, 'Responsibilities'));
  assert.ok(kept.length <= 6);
  for (const item of kept) assert.ok(!copiesPurpose(item.replace(/^\s*[-*+]\s+/, ''), PURPOSES), item);
  assert.ok(stats.purposeItems >= 26, `${stats.purposeItems} dropped`);
  // The per-file detail stays in the Key components table.
  assert.match(section(doc, 'Key components'), /\| \[`src\/install-ollama\.js`\]\(\.\.\/src\/install-ollama\.js\) \| Installs the Ollama release\. \|/);

  // Summaries of groups of files are kept, at most 6 of them.
  const summaries = [
    '- Plans comments for each file, checks them for accuracy, and proves the inserted comments did not change the program.',
    '- Installs the pinned Ollama release, picks the models for the run, and checks each pulled model against its pins.',
    '- Writes the layer docs and the README from folder summaries and file purposes.',
    '- Keeps the state of each run in `.docturnal/state.json` and pushes the branch with git.',
    '- Reads the action inputs and validates them.',
    '- Orders existing code by importance and analyzes file structures.',
    '- Plans the work of each run from its changes, applies the results, and reports them in the pull request.',
    '- Tokenizes lines and finds the comments in each language, and in Python with its own parser.',
  ];
  const withSummaries = raw.replace(section(RUN.docs.source, 'Responsibilities'), summaries.join('\n'));
  const second = docs.buildLayerDoc(withSummaries, { layer: layerNamed('Source'), layers: RUN.layers, fileInfo: FILE_INFO, folders: FOLDERS });
  assert.deepStrictEqual(items(section(second, 'Responsibilities')), summaries.slice(0, 6));
  // The prompt asks for at most 6 items that sum up groups of files.
  const prompt = docs.layerDocPrompt({ layer: layerNamed('Source'), layers: RUN.layers, fileInfo: FILE_INFO, facts: docs.collectProjectFacts(() => null, []), readSource: () => null, projectName: 'docturnal', folders: FOLDERS });
  assert.match(prompt[1].content, /A bulleted list of at most 6 items\. Each item sums up what a group of files does together; never one file's purpose\./);
});

// --- 4. Each thing is said once ---

test('a sentence that repeats an earlier one in the doc is dropped: the real tests.md Overview said its intro again', () => {
  const stats = {};
  const before = section(RUN.docs.tests, 'Overview');
  assert.match(before, /^This folder contains test files that define and evaluate various aspects of the project/);
  const doc = docs.buildLayerDoc(reply(RUN.docs.tests), { layer: layerNamed('Tests'), layers: RUN.layers, fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  const overview = section(doc, 'Overview');
  assert.strictEqual(overview, 'This folder contains test files for various components of the app, including in-memory mock objects and test functions for the PKCS#1 to PKCS#8 conversion, scheduler, setup, and webhook functionalities.');
  assert.ok(stats.repeated >= 1);
  // No two sentences of the prose say the same thing.
  const prose = doc.split('\n## Key components')[0] + section(doc, 'How it works');
  const sentences = prose.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--'))
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/));
  const seen = [];
  const fresh = grounding.isNew(seen);
  for (const s of sentences) assert.ok(fresh(s), `repeated: ${s}`);
});
