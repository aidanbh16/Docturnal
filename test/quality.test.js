'use strict';

// The quality bugs from the second real first run on this repository, reproduced with its real
// files, folder summaries, file purposes, and model replies (test/fixtures/docturnal-run.json):
// a table the model wrote into the README, a layer described by one file's purpose, prose the
// files don't support, and an environment variable read from a comment.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const docs = require('../src/docs');
const { layerConfiguration } = require('../src/configuration');
const { copiesPurpose, groupFiles } = require('../src/layers');
const { importSpecifiers, resolveImport } = require('../src/importance');
const { defaultHandler, kindOf, startMockOllama } = require('./mock-ollama');
const { gitRepo, runAction } = require('./git-repo');

const ROOT = path.join(__dirname, '..');
const RUN = require('./fixtures/docturnal-run.json');
const FILE_INFO = new Map(Object.entries(RUN.files));
const FOLDERS = new Map(Object.entries(RUN.folders));
// The source files the run documented, in its layers.
const ALL_FILES = RUN.layers.flatMap((l) => l.files).sort();
const PKCS8_PURPOSE = RUN.files['app/scripts/pkcs8.mjs'].summary;

const readRepo = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return null;
  }
};
const tables = (text) => (text.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) || []).length;
const section = (text, heading) => ((text.match(new RegExp(`^## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm')) || [])[1] || '').trim();

// --- 1. Tables come only from computed blocks ---

test('the model\'s own Architecture table is dropped from README.md, which keeps short prose and the computed layers block', async () => {
  const base = defaultHandler();
  // The real reply, with more prose after its table: a second paragraph, a list, and a third.
  const reply = RUN.replies.readme.replace('\n\n## Getting started', '\n\nThe layers share their state through git.\n\n- A list the model added.\n\nA third paragraph.\n\n## Getting started');
  const mock = await startMockOllama((body, n) => (kindOf(body) === 'readme' ? reply : base(body, n)));
  const repo = gitRepo();
  try {
    repo.commit({ 'src/a.js': 'export function a() {}\n', 'src/b.js': 'export function b() {}\n', 'src/c.js': 'export function c() {}\n' }, 'Code');
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    const readme = repo.text('docturnal/update', 'README.md');
    const architecture = section(readme, 'Architecture');
    assert.doesNotMatch(readme, /Files \(Count\)|PKCS/);
    // One table in the section: the computed one, between its markers.
    assert.strictEqual(tables(architecture), 1);
    // Two paragraphs of prose, then the computed block.
    assert.match(architecture, /^Docturnal consists of several layers that work together to achieve its goals:\n\nThe layers share their state through git\.\n\n<!-- docturnal:layers -->\n\| Layer \| Description \|/);
    assert.doesNotMatch(architecture, /A list the model added|A third paragraph/);
    assert.match(run.log, /Docturnal: dropped 1 table the model wrote into the docs/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('a table in a layer doc reply is dropped, and the only table is the computed Key components', () => {
  const layer = { name: 'Tests', slug: 'tests', description: 'Tests for the Action and the app.', files: ALL_FILES.filter((f) => /^(test|app\/tests)\//.test(f)) };
  const reply = `${RUN.replies.tests}\n\n| Folder | Files |\n| --- | --- |\n| test | 23 |\n\nFolder | Kind\n---|---\napp/tests | specs`;
  const stats = {};
  const doc = docs.buildLayerDoc(reply, { layer, layers: [layer], fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  assert.strictEqual(tables(doc), 1);
  assert.match(doc, /## Key components\n\n\| File \| Purpose \| Main definitions \|/);
  assert.doesNotMatch(doc, /\| test \| 23 \||app\/tests \| specs/);
  assert.strictEqual(stats.droppedTables, 2);
});

test('the Architecture prose is at most two paragraphs, without lists, and the prompt asks for no table', () => {
  const { proseParagraphs, readmePrompt } = require('../src/readme');
  const prompt = readmePrompt({ projectName: 'P', layers: [], facts: docs.collectProjectFacts(() => null, []) })[1].content;
  assert.match(prompt, /Do not write a table/);
  assert.match(prompt, /Do not add other sections or any table/);
  assert.strictEqual(proseParagraphs('One.\n\n- a list\n\nTwo.\n\n### More\n\nThree.', 2), 'One.\n\nTwo.');
});

// --- 2. Layers: groups and descriptions ---

test('app/scripts, which the app tests import, joins app/src, and test folders hold only tests', () => {
  const known = new Set(ALL_FILES);
  const importsOf = (file) => {
    const text = readRepo(file);
    return text ? importSpecifiers(file, text).map((s) => resolveImport(file, s, known)).filter(Boolean) : [];
  };
  // The reason it was merged into Tests: the app's tests import pkcs8.mjs.
  assert.ok(ALL_FILES.filter((f) => f.startsWith('app/tests/')).some((f) => importsOf(f).includes('app/scripts/pkcs8.mjs')));
  const groups = groupFiles(ALL_FILES, importsOf);
  const withPkcs8 = groups.find((g) => g.files.includes('app/scripts/pkcs8.mjs'));
  assert.deepStrictEqual(withPkcs8.folders, ['app/src', 'app/scripts']);
  for (const group of groups.filter((g) => g.folders.some((f) => /(^|\/)tests?$/.test(f)))) {
    assert.ok(group.files.every((f) => /^(test|app\/tests)\//.test(f)), group.folders.join('+'));
  }
});

test('a small group joins the group that shares its top folder, even when it imports more from another', () => {
  const files = [
    'app/src/a.ts', 'app/src/b.ts', 'app/src/c.ts', 'app/scripts/register.mjs', 'app/scripts/pkcs8.mjs',
    'lib/x.js', 'lib/y.js', 'lib/z.js', 'tools/p.js', 'tools/q.js', 'tools/r.js', 'docs-site/s.js', 'docs-site/t.js', 'docs-site/u.js',
  ];
  const importsOf = (file) => (file.startsWith('app/scripts/') ? ['lib/x.js', 'lib/y.js'] : []);
  const groups = groupFiles(files, importsOf);
  assert.deepStrictEqual(groups.find((g) => g.files.includes('app/scripts/pkcs8.mjs')).folders, ['app/src', 'app/scripts']);
});

test('a layer description that copies one file\'s purpose is replaced by one from the folder summaries', async () => {
  const prompts = [];
  // A docs model that names each group after its folders, and describes the test group with
  // pkcs8.mjs's purpose, as the real run did.
  const call = async (label, request) => {
    const prompt = request.messages[1].content;
    prompts.push(prompt);
    const ids = [...prompt.matchAll(/^- (g\d+): ([^(]+) \(/gm)].map((m) => ({ id: m[1], folders: m[2] }));
    return JSON.stringify({
      layers: ids.map(({ id, folders }) => (/test/.test(folders)
        ? { name: 'Tests', description: PKCS8_PURPOSE, groups: [id] }
        : { name: folders.includes('app/src') ? 'GitHub App' : folders.includes('scripts') && !folders.includes('app') ? 'Ollama Scripts' : 'Comment Engine', description: `The code in ${folders}.`, groups: [id] })),
    });
  };
  const errors = [];
  const layers = await docs.planLayers({ files: ALL_FILES, fileInfo: FILE_INFO, folders: FOLDERS, call, contextTokens: 8192, errors, readSource: readRepo });
  const tests = layers.find((l) => l.name === 'Tests');
  assert.notStrictEqual(tests.description, PKCS8_PURPOSE);
  assert.ok(!copiesPurpose(tests.description, [PKCS8_PURPOSE]));
  // From the summary of its largest folder, test/.
  assert.strictEqual(tests.description, 'This folder contains test files that define and evaluate various aspects of the project, including action steps, checks, comments, configurations, and end-to-end tests.');
  assert.ok(errors.includes('layers: the description of "Tests" repeats one file\'s purpose, so it comes from its folders'));
  assert.ok(!tests.files.some((f) => f.startsWith('app/scripts/')));
  assert.match(prompts[0], /one sentence that sums up the whole layer, from its folder summaries\. Never one file's purpose/);
  // A description of the whole group is kept.
  assert.ok(!copiesPurpose('Tests for the Action and the app, with a mock Ollama server.', [...FILE_INFO.values()].map((i) => i.summary)));
});

// --- 3. Prose grounded in the layer's material ---

function commentEngine() {
  return { name: 'Comment Engine', slug: 'comment-engine', description: 'The Action code that comments files and writes the docs.', files: ALL_FILES.filter((f) => f.startsWith('src/')) };
}

test('invented prose is dropped from a layer doc: TODO extraction, formatting for display, simulated user interactions', () => {
  const layer = commentEngine();
  const grounded = '`comments.js` applies the proposals, and `verify.js` proves that inserting comments did not change the program.';
  const reply = `${RUN.replies['comment-engine']}\n\n${grounded}`;
  const stats = {};
  const doc = docs.buildLayerDoc(reply, { layer, layers: [layer], fileInfo: FILE_INFO, folders: FOLDERS, linkStats: stats });
  for (const invented of [/TODO/, /documentation tags/, /display/, /keywords/, /identify/i]) assert.doesNotMatch(doc, invented);
  assert.ok(stats.ungrounded >= 5, `${stats.ungrounded} dropped`);
  // A sentence the material supports stays.
  assert.ok(doc.includes(grounded));
  // Too little of the Overview was left, so it comes from the folder summary.
  assert.strictEqual(section(doc, 'Overview'), RUN.folders.src);

  const testsLayer = { name: 'Tests', slug: 'tests', description: 'Tests for the Action and the app.', files: ALL_FILES.filter((f) => /^(test|app\/tests)\//.test(f)) };
  const testsDoc = docs.buildLayerDoc(RUN.replies.tests, { layer: testsLayer, layers: [testsLayer], fileInfo: FILE_INFO, folders: FOLDERS });
  assert.doesNotMatch(testsDoc, /user interactions|behaves as expected/);
});

test('the layer doc prompt gives folder summaries, every file\'s purpose, and definitions, and asks for nothing more', () => {
  const layer = commentEngine();
  const [system, user] = docs.layerDocPrompt({ layer, layers: [layer], fileInfo: FILE_INFO, facts: docs.collectProjectFacts(() => null, []), readSource: readRepo, projectName: 'docturnal', folders: FOLDERS });
  const prompt = `${system.content}\n${user.content}`;
  assert.ok(prompt.length <= 4000, `${prompt.length} characters`);
  assert.match(prompt, /Never add a capability, feature, or behavior they do not state/);
  assert.match(prompt, /Folder summaries:/);
  assert.ok(prompt.includes(`- src: ${RUN.folders.src}`));
  // 31 files: under their folder by name, each with its purpose, shortened to fit.
  assert.match(prompt, /^In src\/:$/m);
  for (const file of layer.files) assert.ok(prompt.includes(`- ${file.slice(4)}: ${RUN.files[file].summary.slice(0, 15)}`), file);
});

// --- 4. Configuration from code only ---

test('an environment variable named only in a comment is not configuration: the API_KEY in configuration.js', () => {
  const source = `const ENV_PATTERNS = [\n${RUN.configurationComment}\n];\nexport function run(env) {\n  return env.WEBHOOK_SECRET;\n}\n`;
  const read = (file) => (file === 'src/configuration.js' ? source : null);
  assert.deepStrictEqual(layerConfiguration(['src/configuration.js'], read, ['src/configuration.js']).envVars, ['WEBHOOK_SECRET']);
  // This repository's real Action code: what it reads, and no API_KEY.
  const src = ALL_FILES.filter((f) => f.startsWith('src/') && f.endsWith('.js'));
  const { envVars } = layerConfiguration(src, readRepo, ALL_FILES);
  assert.ok(!envVars.includes('API_KEY'));
  for (const name of ['BASE_BRANCH', 'GITHUB_OUTPUT', 'OLLAMA_HOST', 'RUNNER_TEMP']) assert.ok(envVars.includes(name), name);
});

test('names in strings and comments are not configuration, in JavaScript, Python, and other languages', () => {
  const files = {
    'test/a.test.js': "// process.env.IN_COMMENT\nconst fixture = 'process.env.DATABASE_URL';\nconst { TOKEN } = process.env;\nconst port = process.env['PORT'];\n",
    'lib/b.py': 'import os\n# os.environ["IN_COMMENT"]\nDOC = "os.getenv(\'IN_STRING\')"\nURL = os.environ.get("DATABASE_URL")\n',
    'cmd/c.go': '// os.Getenv("IN_COMMENT")\n/* os.Getenv("IN_BLOCK") */\nvar home = os.Getenv("HOME_DIR")\n',
  };
  const read = (file) => files[file] || null;
  const vars = (file) => layerConfiguration([file], read, Object.keys(files)).envVars;
  assert.deepStrictEqual(vars('test/a.test.js'), ['PORT', 'TOKEN']);
  assert.deepStrictEqual(vars('lib/b.py'), ['DATABASE_URL']);
  assert.deepStrictEqual(vars('cmd/c.go'), ['HOME_DIR']);
});
