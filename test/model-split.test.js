'use strict';

// The fourth real first run split src/ by clustering its imports, and on the live code the parts
// were poor: "Source Ollama" held the comment engine and Ollama, a 13-file grab bag held the
// rest, and descriptions fell back to "Holds accuracy.js, comments.js, and 7 more files". Now
// the docs model divides a big group, its answer is checked in code, and clustering is only the
// fallback. These tests use this repository's live src/ files.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const docs = require('../src/docs');
const { importSpecifiers, resolveImport } = require('../src/importance');
const { clusterFiles } = require('../src/clusters');
const { planGroundedLayers, purposeSentence } = require('../src/layers');
const { checkSplit } = require('../src/split');
const { defaultHandler, kindOf, startMockOllama } = require('./mock-ollama');
const { gitRepo, runAction } = require('./git-repo');

const ROOT = path.join(__dirname, '..');
const RUN = require('./fixtures/docturnal-run3.json');
const readRepo = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return null;
  }
};
// The live src/ files, each with its purpose from the third run, or for a file added since, the
// first sentence of its leading comment, as the parsers would take it.
const SRC = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /\.(js|py)$/.test(f)).map((f) => `src/${f}`).sort();
const leadingPurpose = (file) => {
  const comment = (readRepo(file).match(/^(?:'use strict';\s*)?((?:\/\/.*\n)+)/) || [])[1] || '';
  return `${comment.replace(/^\/\/ ?/gm, '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0]}`;
};
const PURPOSE = new Map(SRC.map((f) => [f, RUN.files[f] ? RUN.files[f].summary : leadingPurpose(f)]));
const FILES = [...Object.keys(RUN.files).filter((f) => !f.startsWith('src/')), ...SRC].sort();
const FILE_INFO = new Map(FILES.map((f) => [f, f.startsWith('src/') ? { path: f, summary: PURPOSE.get(f) } : RUN.files[f]]));
const FOLDERS = new Map(Object.entries(RUN.folders));

// What a good model answers: the comment engine; the docs and the README; Ollama and its
// models; and the run itself, with git and the state. A file added to src/ later goes with the run.
const NAMES = ['comment', 'docs', 'ollama', 'run'];
const SETS = {
  comment: ['accuracy', 'analyze', 'comments', 'languages', 'owned', 'python', 'python-helper', 'restates', 'verify'],
  docs: ['clusters', 'configuration', 'docs', 'folders', 'grounding', 'layers', 'links', 'readme', 'split', 'structure'],
  ollama: ['install-ollama', 'models', 'ollama', 'verify-models'],
};
const stemOf = (f) => path.posix.basename(f).replace(/\.\w+$/, '');
const setOf = (f) => NAMES.find((n) => (SETS[n] || []).includes(stemOf(f))) || 'run';
const filesOf = (name) => SRC.filter((f) => setOf(f) === name);
const goodParts = () => [
  { name: 'Comment Engine', description: 'Plans comments for each file, checks their accuracy, and proves the inserted comments leave the program unchanged.', files: filesOf('comment') },
  { name: 'Docs and README', description: 'Writes the layer docs and the README from folder summaries and file purposes.', files: filesOf('docs') },
  { name: 'Ollama Models', description: 'Installs the pinned Ollama release, picks the models, and checks them against their pins.', files: filesOf('ollama') },
  { name: 'Run State and Git', description: 'Plans each run from the changes, keeps its state, and pushes the branch with git.', files: filesOf('run') },
];

// A docs model: split requests get the answers in turn (the last one again after that), and the
// layer plan names each group after its folders.
function model(...answers) {
  const requests = [];
  const call = async (label, request) => {
    requests.push({ label, prompt: request.messages[1].content, request });
    if (label.startsWith('split ')) {
      const answer = answers[Math.min(answers.length - 1, requests.filter((r) => r.label.startsWith('split ')).length - 1)];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }
    const ids = [...request.messages[1].content.matchAll(/^- (g\d+): ([^(]+) \(/gm)].map((m) => ({ id: m[1], folders: m[2] }));
    return JSON.stringify({ layers: ids.map(({ id, folders }) => ({ name: '', description: '', groups: [id], folders })) });
  };
  return { call, requests, splits: () => requests.filter((r) => r.label.startsWith('split ')) };
}

async function plan(answers, files = FILES) {
  const m = model(...answers);
  const errors = [];
  const splits = [];
  const layers = await docs.planLayers({ files, fileInfo: FILE_INFO, folders: FOLDERS, call: m.call, contextTokens: 8192, errors, splits, readSource: readRepo });
  return { layers, errors, splits, m, src: layers.filter((l) => l.files.every((f) => f.startsWith('src/'))) };
}

const importsOf = (() => {
  const known = new Set(FILES);
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      const text = readRepo(file);
      cache.set(file, text ? importSpecifiers(file, text).map((s) => resolveImport(file, s, known)).filter(Boolean) : []);
    }
    return cache.get(file);
  };
})();

test('the docs model divides the live src/ into the comment engine, the docs and README, Ollama and its models, and the run', async () => {
  const { layers, src, splits, errors, m } = await plan([{ parts: goodParts() }]);
  assert.deepStrictEqual(splits, [`src/ (${SRC.length} files) was split into 4 layers by the docs model`]);
  assert.deepStrictEqual(errors, []);
  // Each part is a layer with the model's name, description, and files.
  assert.deepStrictEqual(src.map(({ name, description, files }) => ({ name, description, files })).sort((a, b) => a.name.localeCompare(b.name)),
    goodParts().sort((a, b) => a.name.localeCompare(b.name)));
  assert.strictEqual(new Set(layers.map((l) => l.slug)).size, layers.length);
  // One request to split, with every file's path and purpose, within the docs prompt limit.
  const [split] = m.splits();
  assert.strictEqual(m.splits().length, 1);
  assert.match(split.prompt, /^These \d+ files are src\/ of a project\. .* divide them into 2 to 4 parts/);
  for (const file of SRC) assert.match(split.prompt, new RegExp(`^- ${file.replace(/[.]/g, '\\.')}: \\S`, 'm'), file);
  assert.match(split.prompt, /at least 3 files in each part/);
  assert.ok(split.request.messages[0].content.length + split.prompt.length <= docs.DOC_PROMPT_CHARS);
  assert.ok(split.request.options.num_predict >= 300);
  // The layer plan names only the other groups.
  const plans = m.requests.filter((r) => r.label === 'layers');
  assert.strictEqual(plans.length, 1);
  assert.doesNotMatch(plans[0].prompt, /part of src|(^|[\s,;])(comments|ollama)\.js/m);
});

test('an answer that breaks a rule is asked for again with the problems listed, and the second answer is used', async () => {
  const first = { parts: goodParts().map((p) => ({ ...p, files: p.files.filter((f) => f !== 'src/main.js') })) };
  const { src, splits, errors, m } = await plan([first, { parts: goodParts() }]);
  assert.strictEqual(m.splits().length, 2);
  assert.match(m.splits()[1].prompt, /Your last answer broke these rules\. Fix them:\n- `src\/main\.js` is in no part\n/);
  assert.doesNotMatch(m.splits()[0].prompt, /Your last answer/);
  assert.deepStrictEqual(splits, [`src/ (${SRC.length} files) was split into 4 layers by the docs model, on its second answer`]);
  assert.ok(errors.includes('layers: answer 1 for splitting src/ broke 1 rule: `src/main.js` is in no part'), errors.join('\n'));
  assert.ok(src.some((l) => l.name === 'Run State and Git' && l.files.includes('src/main.js')));
});

// Each rule, broken in both answers: the problem is named, and src/ is clustered instead.
const broken = (change) => {
  const parts = goodParts();
  change(parts);
  return { parts };
};
const move = (parts, file, from, to) => {
  parts[from].files = parts[from].files.filter((f) => f !== file);
  parts[to].files.push(file);
};
const RULES = [
  ['a file in no part', broken((p) => { p[3].files = p[3].files.filter((f) => f !== 'src/main.js'); }), '`src/main.js` is in no part'],
  ['a file in two parts', broken((p) => p[0].files.push('src/main.js')), '`src/main.js` is in more than one part'],
  ['a file not in the list', broken((p) => p[3].files.push('src/payments.js')), '`src/payments.js` is not in the list'],
  ['one part', { parts: [{ ...goodParts()[3], files: SRC }] }, 'it has 1 part; give 2 to 4'],
  ['five parts', broken((p) => p.push({ name: 'Verification', description: 'Checks the pulled models and the inserted comments against what they must be.', files: ['src/verify.js', 'src/verify-models.js', 'src/restates.js'] })), 'it has 5 parts; give 2 to 4'],
  ['a part of two files', broken((p) => { move(p, 'src/models.js', 2, 3); move(p, 'src/verify-models.js', 2, 3); }), '"Ollama Models" has 2 files; each part needs at least 3'],
  ['two parts with one name', broken((p) => { p[1].name = 'Comment Engine'; }), 'the name "Comment Engine" is given to two parts'],
  ['a name its files do not support', broken((p) => { p[2].name = 'Payment Processing'; }), 'the name "Payment Processing" does not say what its files do'],
  ['a generic name', broken((p) => { p[3].name = 'Business Logic'; }), 'the name "Business Logic" does not say what its files do'],
  ['a part with no name', broken((p) => { p[2].name = ' '; }), 'part 3 has no name'],
  ['a description that copies one file\'s purpose', broken((p) => { p[2].description = 'Installs the Ollama release.'; }), 'the description of "Ollama Models" only repeats one file\'s purpose'],
  ['a part with no description', broken((p) => { p[1].description = ''; }), '"Docs and README" has no description'],
  ['an answer that is not JSON', '{"parts": [{"name": "Comment', 'the answer is not JSON with a list of parts'],
];

for (const [rule, answer, problem] of RULES) {
  test(`a split that breaks a rule twice is replaced by clustering: ${rule}`, async () => {
    const { src, splits, errors, m } = await plan([answer]);
    assert.strictEqual(m.splits().length, 2);
    assert.ok(m.splits()[1].prompt.includes(`\n- ${problem}\n`), m.splits()[1].prompt.split('Fix them:')[1]);
    assert.ok(errors.some((e) => e.startsWith('layers: answer 2 for splitting src/ broke') && e.includes(problem)), errors.join('\n'));
    // The parts clustering finds, named in the layer plan or after src/.
    const clustered = clusterFiles(SRC, { importsOf, purposeOf: (f) => PURPOSE.get(f), maxClusters: 4, minSize: 3 });
    assert.deepStrictEqual(src.map((l) => l.files).sort((a, b) => a[0].localeCompare(b[0])), clustered.sort((a, b) => a[0].localeCompare(b[0])));
    assert.deepStrictEqual(splits, [`src/ (${SRC.length} files) was split into ${clustered.length} layers by clustering its imports, because both answers broke the rules`]);
    assert.ok(!src.some((l) => ['Comment Engine', 'Docs and README', 'Ollama Models', 'Run State and Git'].includes(l.name)));
  });
}

test('a name another layer already has is a problem, and so is a part the folder does not hold', () => {
  const group = { folder: 'src', folders: ['src'], files: SRC };
  const rules = { maxParts: 4, minSize: 3, supported: () => true, copies: () => false };
  assert.deepStrictEqual(checkSplit({ parts: goodParts() }, group, { ...rules, taken: new Set(['ollama models']) }).problems, ['the name "Ollama Models" is already another layer\'s']);
  assert.deepStrictEqual(checkSplit({ parts: goodParts() }, group, rules).problems, []);
  // A file named without its folder counts when only one listed file ends with it.
  const short = goodParts();
  short[2].files = short[2].files.map((f) => f.replace('src/', ''));
  assert.deepStrictEqual(checkSplit({ parts: short }, group, rules).parts[2].files, filesOf('ollama'));
  assert.deepStrictEqual(checkSplit(null, group, rules).problems, ['the answer is not JSON with a list of parts']);
});

test('a failed request, or files too many for one request, go straight to clustering', async () => {
  const failed = await plan([new Error('connect ECONNREFUSED')]);
  assert.strictEqual(failed.m.splits().length, 1);
  assert.match(failed.splits[0], /^src\/ \(\d+ files\) was split into \d layers by clustering its imports, because the request failed$/);
  assert.ok(failed.errors.includes('layers: the request to split src/ failed (connect ECONNREFUSED)'));

  // 200 files with long purposes do not fit in 4,000 characters, even cut short.
  const many = Array.from({ length: 200 }, (_, i) => `lib/module-number-${String(i).padStart(3, '0')}.js`);
  for (const f of many) FILE_INFO.set(f, { path: f, summary: 'Reads one kind of record from the archive and writes it back in the current format.' });
  try {
    const big = await plan([{ parts: goodParts() }], [...FILES, ...many]);
    assert.ok(!big.m.splits().some((r) => r.label === 'split lib'));
    assert.ok(big.splits.some((s) => /^lib\/ \(200 files\) .*its files do not fit in one request/.test(s)), big.splits.join('\n'));
  } finally {
    for (const f of many) FILE_INFO.delete(f);
  }
});

// --- 3. A part's description from its most imported files ---

test('a part with no description is described by the purposes of its most imported files', async () => {
  const purposes = new Map([
    ['src/a.js', 'Calls the local Ollama server.'],
    ['src/b.js', 'Ollama model names and their pins.'],
    ['src/c.js', 'The run\'s state on disk.'],
    ['src/d.js', 'Installs the release.'],
  ]);
  const importers = new Map([['src/a.js', 9], ['src/b.js', 4], ['src/c.js', 2]]);
  assert.strictEqual(purposeSentence([...purposes.keys()], (f) => purposes.get(f), (f) => importers.get(f) || 0),
    'Calls the local Ollama server, Ollama model names and their pins, and the run\'s state on disk.');
  assert.strictEqual(purposeSentence(['src/d.js', 'src/a.js'], (f) => purposes.get(f)), 'Calls the local Ollama server and installs the release.');
  assert.strictEqual(purposeSentence(['src/x.js'], () => ''), '');

  // In a plan where the model's split is not used and the layer plan names nothing.
  const { src } = await plan(['not json']);
  const count = new Map();
  for (const f of FILES) for (const t of new Set(importsOf(f))) if (t !== f) count.set(t, (count.get(t) || 0) + 1);
  for (const layer of src) {
    assert.doesNotMatch(layer.description, /Holds|more files/);
    const top = [...layer.files].sort((a, b) => (count.get(b) || 0) - (count.get(a) || 0) || a.localeCompare(b))[0];
    assert.ok(layer.description.startsWith(PURPOSE.get(top).replace(/\.$/, '')), `${layer.description} / ${top}`);
  }
});

// --- 4. Responsibilities that list file names ---

test('a Responsibilities item that lists file names instead of what the files do is dropped', () => {
  const names = new Set(SRC.flatMap((f) => [path.posix.basename(f), stemOf(f)]));
  for (const item of [
    '- Handles `comments.js`, `accuracy.js`, and `owned.js`.',
    '- Contains comments.js, accuracy.js, owned.js, and restates.js.',
    '- The files `ollama`, `models`, and `install-ollama`.',
    '- Comments in `comments.js` and `owned.js`.',
    '- Plans and checks comments in `comments.js`, `accuracy.js`, `verify.js`, and `owned.js`.',
    // Four names are a list, however much else the item says.
    '- Plans, inserts, verifies, and restyles the comments in `comments.js`, `accuracy.js`, `verify.js`, and `owned.js`.',
  ]) assert.ok(docs.listsFiles(item, names), item);
  for (const item of [
    '- Plans comments for each file, checks their accuracy, and proves the program is unchanged.',
    '- Plans comments in `comments.js` and checks their accuracy in `accuracy.js`.',
    '- Reads the action inputs, e.g. the comment level.',
    '- Keeps the state in `.docturnal/state.json`.',
    '- Uses `models` to pick the docs model.',
  ]) assert.ok(!docs.listsFiles(item, names), item);

  const layer = { name: 'Comment Engine', slug: 'comment-engine', description: goodParts()[0].description, files: filesOf('comment') };
  const raw = `# Comment Engine\n\nThe comment engine adds comments to source files.\n\n## Responsibilities\n\n- Handles \`comments.js\`, \`accuracy.js\`, and \`owned.js\`.\n- Plans comments for each file and checks their accuracy before they are inserted.\n- Contains restates.js, verify.js, python.js, and analyze.js.`;
  const stats = {};
  const doc = docs.buildLayerDoc(raw, { layer, layers: [layer], fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  assert.strictEqual(stats.fileListItems, 2);
  const kept = (doc.match(/## Responsibilities\n\n([\s\S]*?)\n\n## /) || [])[1];
  assert.strictEqual(kept, '- Plans comments for each file and checks their accuracy before they are inserted.');
});

// --- 5. The log says which method split each big group ---

test('in a run, the log says the docs model split src/, and the parts are layers with their own docs', async () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
  const mock = await startMockOllama(defaultHandler());
  const repo = gitRepo();
  try {
    repo.commit(Object.fromEntries(words.map((w) => [`src/${w}.js`, `export function ${w}() {}\n`])), 'Code');
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    assert.match(run.log, /Docturnal: src\/ \(16 files\) was split into 2 layers by the docs model\n/);
    const { layers } = JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    assert.deepStrictEqual(layers.map((l) => l.name).sort(), ['Alpha Files', 'India Files']);
    for (const layer of layers) assert.match(repo.text('docturnal/update', `docs/${layer.slug}.md`), /^<!-- Generated by Docturnal/);
    assert.strictEqual(mock.requests.filter((r) => kindOf(r) === 'split').length, 1);
    // Every group is named by the split, so there is no layer plan request.
    assert.strictEqual(mock.requests.filter((r) => kindOf(r) === 'layers').length, 0);
  } finally {
    await mock.close();
  }
});
