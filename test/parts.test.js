'use strict';

// A large project is documented as a hierarchy: a part for each workspace package and each
// other top-level folder, with sub-documents for a big document's subfolders and its tests, at
// most three levels deep. The layout is checked on a project shaped like excalidraw/excalidraw
// (788 files in 15 parts, so packages/ is grouped as one), with model time
// simulated at the calibrated speeds (see speed-model.js): every part's doc is written in the
// first run, within the 90-minute budget, and the sub-documents that do not fit follow on the
// next run. A small project, such as Docturnal's own, keeps its flat layers.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { excalidrawLike, PACKAGES, SOURCE_FILES } = require('./excalidraw-like');
const { gitRepo } = require('./git-repo');
const { startMockOllama } = require('./mock-ollama');
const { simulatedChat } = require('./speed-model');
const { findPackages, isLargeProject, isTestFile, packageTitle, partDocuments, topParts, workspacePatterns } = require('../src/parts');

const ROOT = path.join(__dirname, '..');
const DOC_PROMPT_LIMIT = 4000;

test('a file belongs to the deepest package that holds it', () => {
  const files = ['apps/web/index.ts', 'apps/web/plugins/maps/index.ts', 'apps/web/plugins/maps/tiles.ts', 'README.md'];
  const packages = findPackages([...files, 'apps/web/package.json', 'apps/web/plugins/maps/package.json'], () => '{}');
  const parts = topParts(files.filter((f) => f.endsWith('.ts')), packages);
  assert.deepStrictEqual(parts.map((p) => [p.folder, p.files.length]), [['apps/web', 1], ['apps/web/plugins/maps', 2]]);
});

test('the state keeps a sub-document\'s doc name and part, and drops anything that could be a path', () => {
  const { readState } = require('../src/state');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-state-'));
  try {
    fs.mkdirSync(path.join(dir, '.docturnal'));
    const layer = (slug, part) => ({ name: slug, slug, ...(part === undefined ? {} : { part }), description: '', files: [] });
    fs.writeFileSync(path.join(dir, '.docturnal/state.json'), JSON.stringify({
      version: 1,
      layers: [
        layer('packages'), layer('excalidraw', 'packages'), layer('components', 'packages/excalidraw'),
        layer('evil', '../x'), layer('worse', 'a/b/c'), layer('odd', 'a//b'), layer('up', 'a/..'),
      ],
      docs: ['packages', 'packages/excalidraw', 'packages/excalidraw/components', '../escape', 'a/b/c/d', 'a//b', 'a/../b'],
      staleDocs: ['README', 'packages/excalidraw/tests', '/abs'],
    }));
    const state = readState(dir);
    assert.deepStrictEqual(state.layers.map((l) => [l.slug, l.part]), [['packages', undefined], ['excalidraw', 'packages'], ['components', 'packages/excalidraw']]);
    assert.deepStrictEqual(state.docs, ['packages', 'packages/excalidraw', 'packages/excalidraw/components']);
    assert.deepStrictEqual(state.staleDocs, ['README', 'packages/excalidraw/tests']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a big folder is divided by the docs model only while the part documents still have their time', async () => {
  const { planGroundedLayers } = require('../src/layers');
  const files = [...Array.from({ length: 45 }, (_, i) => `a/s/f${i}.ts`), 'b/x.ts', 'b/y.ts', 'b/z.ts'];
  const fileInfo = new Map(files.map((f) => [f, { summary: `Handles step ${f}.` }]));
  const plan = async (deadline) => {
    const labels = [];
    const splits = [];
    await planGroundedLayers({
      files, allFiles: [...files, 'a/package.json', 'b/package.json'], fileInfo, splits, deadline, now: () => 0,
      call: async (label) => {
        labels.push(label);
        return '{}';
      },
    });
    return { labels, splits };
  };
  const late = await plan(5 * 60000);
  assert.deepStrictEqual(late.labels, []);
  // With no imports between them, clustering keeps the files together.
  assert.ok(late.splits.includes('a/s/ (45 files) stays one document: the time left went to the part documents, and clustering its imports found no parts'), late.splits.join('\n'));
  const early = await plan(Infinity);
  assert.deepStrictEqual(early.labels, ['split a/s', 'split a/s']);
});

test('a batch names a sub-document with its part when another layer has its name', () => {
  const { selectBatch } = require('../src/importance');
  const layers = [
    { name: 'Element', slug: 'element', files: [] }, { name: 'Tests', slug: 'tests', part: 'element', files: ['e.test.ts'] },
    { name: 'Math', slug: 'math', files: ['m.ts'] }, { name: 'Tests', slug: 'tests', part: 'math', files: ['m.test.ts'] },
  ];
  const ranked = ['m.test.ts', 'e.test.ts', 'm.ts'].map((p) => ({ path: p }));
  assert.deepStrictEqual(selectBatch(ranked, layers, 2), { files: ['m.test.ts', 'e.test.ts'], layers: ['Math Tests', 'Element Tests'] });
  // A third-level document is named with the document it is in.
  const nested = [
    { name: 'Packages', slug: 'packages', files: [] }, { name: 'Math', slug: 'math', part: 'packages', files: [] },
    { name: 'Tests', slug: 'tests', part: 'packages/math', files: ['m.test.ts'] }, { name: 'Tests', slug: 'tests', part: 'scripts', files: ['s.test.ts'] },
  ];
  assert.deepStrictEqual(selectBatch([{ path: 'm.test.ts' }], nested, 1).layers, ['Math Tests']);
});

test('packages come from manifests and workspace settings, never the root, test fixtures, or node_modules', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['apps/*', '!apps/legacy'] } }),
    'pnpm-workspace.yaml': "packages:\n  - 'tools/*'\n  # a comment\n  - \"libs/core\"\nother: true\n",
    'apps/web/index.js': '', 'apps/legacy/index.js': '', 'tools/bundler/run.js': '', 'libs/core/index.js': '',
    'services/api/pyproject.toml': '[project]\nname = "billing-api"\n',
    'services/worker/Cargo.toml': '[package]\nname = "queue_worker"\nversion = "0.1.0"\n',
    'services/proxy/go.mod': 'module github.com/acme/edge-proxy\n\ngo 1.22\n',
    'services/proxy/main.go': '',
    'web/package.json': JSON.stringify({ name: '@acme/web-ui' }),
    'test/fixtures/sample/package.json': '{}',
    'node_modules/left-pad/package.json': '{}',
  };
  const read = (file) => (file in files ? files[file] : null);
  assert.deepStrictEqual(workspacePatterns(read), ['apps/*', '!apps/legacy', 'tools/*', 'libs/core']);
  const packages = findPackages(Object.keys(files), read);
  assert.deepStrictEqual(packages.map((p) => [p.folder, p.name]).sort(), [
    ['apps/web', ''], ['libs/core', ''], ['services/api', 'billing-api'], ['services/proxy', 'edge-proxy'],
    ['services/worker', 'queue_worker'], ['tools/bundler', ''], ['web', '@acme/web-ui'],
  ]);
  assert.strictEqual(packageTitle('@excalidraw/element'), 'Excalidraw Element');
  assert.strictEqual(packageTitle('@excalidraw/excalidraw'), 'Excalidraw');
  assert.strictEqual(packageTitle('excalidraw-app'), 'Excalidraw App');
  assert.strictEqual(packageTitle('@excalidraw/utils'), 'Excalidraw Utilities');
});

test('a small project keeps the flat layout: Docturnal\'s own repository, and one package under 100 files', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const code = tracked.filter((f) => /\.(js|ts|mjs|cjs|sh)$/.test(f) && !f.startsWith('test/fixtures/'));
  const packages = findPackages(tracked, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  assert.deepStrictEqual(packages.map((p) => p.folder), ['app']);
  assert.ok(code.length < 100, `${code.length} files`);
  assert.strictEqual(isLargeProject(code, packages), false);
  // Two packages, or 100 files, make a project large.
  assert.strictEqual(isLargeProject(['a/x.js', 'b/y.js'], [{ folder: 'a' }, { folder: 'b' }]), true);
  assert.strictEqual(isLargeProject(Array.from({ length: 100 }, (_, i) => `src/m${i}.js`), []), true);
});

test('a part\'s documents: tests apart, subfolders split off, tiny ones kept with the part, a lone src/ divided', () => {
  const files = [
    ...Array.from({ length: 30 }, (_, i) => `pkg/a${i}.ts`),
    ...Array.from({ length: 12 }, (_, i) => `pkg/views/v${i}.ts`),
    ...Array.from({ length: 3 }, (_, i) => `pkg/tiny/t${i}.ts`),
    ...Array.from({ length: 50 }, (_, i) => `pkg/big/b${i}.ts`),
    'pkg/a0.test.ts', 'pkg/tests/setup.ts',
  ];
  const docs = partDocuments({ folder: 'pkg', name: 'Pkg', files });
  // The 3 files of pkg/tiny stay with the part's own 30.
  assert.deepStrictEqual(docs.own.length, 33);
  assert.ok(docs.own.includes('pkg/tiny/t0.ts'));
  assert.deepStrictEqual(docs.subs.map((s) => [s.name, s.files.length, s.divide]), [['Big', 50, true], ['Views', 12, false], ['Tests', 2, false]]);
  assert.ok(docs.subs[2].files.every(isTestFile));
  // All code in one src/: its files are the part's own, divided, since there are too many.
  const lone = partDocuments({ folder: 'lib', name: 'Lib', files: Array.from({ length: 60 }, (_, i) => `lib/src/m${i}.ts`) });
  assert.deepStrictEqual([lone.own.length, lone.subs.map((s) => [s.folder, s.divide, s.rest])], [0, [['lib/src', true, true]]]);
  // At most 12 parts: a top-level folder of many packages becomes one part, each a document.
  const many = Array.from({ length: 14 }, (_, i) => `packages/p${i}/index.ts`);
  const parts = topParts([...many, 'scripts/run.js'], many.map((f) => ({ folder: path.posix.dirname(f), name: '' })));
  assert.deepStrictEqual(parts.map((p) => [p.folder, p.name, p.files.length]), [['packages', 'Packages', 14], ['scripts', 'Scripts', 1]]);
  assert.strictEqual(partDocuments(parts[0]).subs.length, 14);
});

test('a document of more than 40 code files gets sub-documents by its subfolders at any level, never deeper than 3', () => {
  const many = (dir, n, ext = 'ts') => Array.from({ length: n }, (_, i) => `${dir}/f${String(i).padStart(2, '0')}.${ext}`);
  // packages/ has more parts than the README lists, so it is one part with each package below it.
  const files = [
    ...Array.from({ length: 13 }, (_, i) => `packages/p${i}/index.ts`),
    ...many('packages/big', 10), ...many('packages/big/ui', 30), ...many('packages/big/ui/menus', 20), ...many('packages/big/ui/icons', 20),
    ...many('packages/big/flat', 45), ...many('packages/big/tiny', 3), ...many('packages/big/tests', 6, 'test.ts'),
  ];
  const packages = [...Array.from({ length: 13 }, (_, i) => ({ folder: `packages/p${i}`, name: '' })), { folder: 'packages/big', name: '@acme/big' }];
  const [part] = topParts(files, packages);
  assert.strictEqual(part.name, 'Packages');
  const docs = partDocuments(part);
  const big = docs.subs.find((s) => s.folder === 'packages/big');
  const show = (doc) => [doc.name, doc.files.length, doc.divide, doc.subs.map(show)];
  // Level 2 is the package, level 3 its subfolders. ui/ is too big for one document, but at the
  // third level it is divided within itself rather than split by its own subfolders; so is flat/,
  // which has none. tiny/ stays with the package's own files.
  assert.deepStrictEqual(show(big), ['Acme Big', 13, false, [['Flat', 45, true, []], ['UI', 70, true, []], ['Tests', 6, false, []]]]);
  // A top-level part has room for one more level: its big subfolder gets its subfolders.
  const alone = partDocuments({ folder: 'packages/big', name: 'Big', files: files.filter((f) => f.startsWith('packages/big/')) });
  assert.deepStrictEqual(alone.subs.map(show), [
    ['Flat', 45, true, []],
    ['UI', 30, false, [['Icons', 20, false, []], ['Menus', 20, false, []]]],
    ['Tests', 6, false, []],
  ]);
});

test('a part that groups packages is described by them: their names, and one checked sentence about them all', async () => {
  const { groupDescription, groupSentenceProblem } = require('../src/layers');
  const members = [
    { name: 'Common', description: 'Holds shared constants and color helpers.', package: true },
    { name: 'Element', description: 'Creates, measures, and binds drawing elements.', package: true },
    { name: 'Math', description: 'Computes points, vectors, and curve geometry.', package: true },
  ];
  const folders = new Map([['packages/utils', 'Provides utility and helper functions for exporting and analytics tracking.']]);
  const answer = (sentence) => async () => JSON.stringify({ sentence });
  const part = { folder: 'packages' };
  const holds = "Holds the project's 3 packages: Common, Element, and Math.";
  const good = 'Together they hold the shared helpers, drawing elements, and geometry the editor uses.';
  assert.strictEqual(await groupDescription(part, members, { call: answer(good), folders }), `${holds} ${good}`);
  // A sentence that only repeats one folder's summary, is about one package, or says what the
  // descriptions do not, is dropped, and so is one when the request fails or time is short.
  const errors = [];
  assert.strictEqual(await groupDescription(part, members, { call: answer('Provides utility and helper functions for exporting and analytics tracking.'), folders, errors }), holds);
  assert.match(errors[0], /^layers: the sentence describing packages\/ was dropped: /);
  assert.strictEqual(groupSentenceProblem('Creates, measures, and binds drawing elements for the canvas.', members, folders), 'it is about only one of them');
  assert.strictEqual(groupSentenceProblem('Together they sync files to cloud storage and track payments.', members, folders), 'it says what the descriptions do not');
  assert.strictEqual(groupSentenceProblem('Together they hold `helpers` and elements.', members, folders), 'it is not one plain sentence');
  assert.strictEqual(groupSentenceProblem('Creates, measures, and binds drawing elements and points.', members, folders), 'it repeats one description');
  assert.strictEqual(await groupDescription(part, members, { call: async () => { throw new Error('down'); }, folders }), holds);
  assert.strictEqual(await groupDescription(part, members, { call: answer(good), folders, useModel: false }), holds);
  // Parts that are not all packages are counted as parts.
  assert.match(await groupDescription(part, [{ ...members[0], package: false }, members[1]], {}), /^Holds the project's 2 parts: Common and Element\.$/);
});

test('three-level documents keep their doc names, from the plan and from the previous run', () => {
  const { docName, normalizeLayers } = require('../src/docs');
  const files = ['packages/x/a.ts', 'packages/x/ui/b.ts', 'packages/x/ui/c.ts', 'packages/x/ui/deep/f.ts', 'packages/y/d.ts', 'scripts/e.js'];
  const planned = normalizeLayers({
    layers: [
      { name: 'Packages', description: "Holds the project's 2 packages: X and Y. Together they draw and store shapes.", files: [] },
      { name: 'X', part: 'Packages', files: ['packages/x/a.ts'] },
      { name: 'UI', part: 'Packages/X', files: ['packages/x/ui/b.ts', 'packages/x/ui/c.ts'] },
      { name: 'Deep', part: 'Packages/X/UI', files: ['packages/x/ui/deep/f.ts'] },
      { name: 'Y', part: 'Packages', files: ['packages/y/d.ts'] },
      { name: 'Scripts', files: ['scripts/e.js'] },
    ],
  }, files);
  const names = planned.map(docName);
  // A fourth level is not kept: its file goes to the closest document.
  assert.deepStrictEqual(names, ['packages', 'packages/x', 'packages/x/ui', 'packages/y', 'scripts']);
  assert.ok(planned.find((l) => l.slug === 'ui').files.includes('packages/x/ui/deep/f.ts'));
  // The grouped part keeps the sentence after its list.
  assert.strictEqual(planned[0].description, "Holds the project's 2 packages: X and Y. Together they draw and store shapes.");
  // The next run reads them back by doc name.
  const again = normalizeLayers({ layers: [] }, files, { previous: planned });
  assert.deepStrictEqual(again.map(docName), names);
  assert.deepStrictEqual(again.find((l) => l.slug === 'ui').files, ['packages/x/ui/b.ts', 'packages/x/ui/c.ts', 'packages/x/ui/deep/f.ts']);

  // Slugs are unique within each document's folder, so "tests" can be in docs/x/ and in
  // docs/packages/x/.
  const twice = normalizeLayers({
    layers: [
      { name: 'X', files: ['x/a.ts'] }, { name: 'Tests', part: 'X', files: ['x/a.test.ts'] },
      { name: 'Packages', files: [] }, { name: 'X', part: 'Packages', files: ['packages/x/a.ts'] }, { name: 'Tests', part: 'Packages/X', files: ['packages/x/a.test.ts'] },
    ],
  }, ['x/a.ts', 'x/a.test.ts', 'packages/x/a.ts', 'packages/x/a.test.ts']);
  assert.deepStrictEqual(twice.map(docName), ['x', 'x/tests', 'packages', 'packages/x', 'packages/x/tests']);
});

test('a document\'s prompt has the folders of every document below it, and stays within the size limit', () => {
  const { DOC_PROMPT_CHARS, collectProjectFacts, layerDocPrompt } = require('../src/docs');
  const facts = collectProjectFacts(() => null, []);
  const layers = [
    { name: 'Packages', slug: 'packages', description: 'Holds packages.', files: [] },
    { name: 'X', slug: 'x', part: 'packages', description: 'Draws shapes.', files: ['packages/x/a.ts'] },
    { name: 'UI', slug: 'ui', part: 'packages/x', description: 'Shows menus.', files: ['packages/x/ui/b.ts'] },
  ];
  const folders = new Map([['packages/x', 'Draws shapes on the canvas.'], ['packages/x/ui', 'Shows the menus and dialogs.']]);
  const [system, user] = layerDocPrompt({ layer: layers[0], layers, fileInfo: new Map(), facts, readSource: () => null, projectName: 'p', folders });
  assert.ok(user.content.includes('- packages/x/ui: Shows the menus and dialogs.'), user.content);
  assert.ok(system.content.length > 0);
  // Its doc keeps a sentence that only a folder two levels below supports.
  const { buildLayerDoc } = require('../src/docs');
  const doc = buildLayerDoc('# Packages\n\nHolds packages.\n\n## Overview\n\nIt shows the menus and the dialogs, and it draws the shapes on the canvas.\n', { layer: layers[0], layers, fileInfo: new Map(), folders });
  assert.ok(doc.includes('It shows the menus and the dialogs, and it draws the shapes on the canvas.'), doc);
  // A layer whose material is far larger than the limit: the system and user messages, and the
  // line between them, stay within it.
  const files = Array.from({ length: 300 }, (_, i) => `src/m${i}.ts`);
  const big = { name: 'Big', slug: 'big', description: 'Holds a lot.', files };
  const fileInfo = new Map(files.map((f) => [f, { summary: `Handles the long and detailed step number ${f} of the nightly run for every project.`, symbols: ['alpha', 'beta', 'gamma'] }]));
  const messages = layerDocPrompt({ layer: big, layers: [big], fileInfo, facts, readSource: () => null, projectName: 'p', folders: new Map() });
  assert.ok(messages.map((m) => m.content).join('\n').length <= DOC_PROMPT_CHARS);
  const long = { ...big, description: 'Holds a lot. '.repeat(400) };
  const cut = layerDocPrompt({ layer: long, layers: [long], fileInfo, facts, readSource: () => null, projectName: 'p', folders: new Map() });
  assert.ok(cut.map((m) => m.content).join('\n').length <= DOC_PROMPT_CHARS);
});

// The package or top-level folder a file belongs to.
const ownerOf = (file) => Object.keys(PACKAGES).find((d) => file.startsWith(`${d}/`)) || (file.includes('/') ? file.split('/')[0] : '.');

const RUN_ENV = { BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '90', INPUT_CONTEXT_TOKENS: '8192', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' };

async function runOnce(repo, mock) {
  const { run } = require('../src/main');
  const cwd = repo.clone();
  const sim = simulatedChat(mock);
  const logs = [];
  const result = await run({ cwd, env: { ...repo.gitEnv, ...RUN_ENV }, chat: sim.chat, now: sim.now, log: (l) => logs.push(l) });
  const read = (file) => fs.readFileSync(path.join(cwd, file), 'utf8');
  return { cwd, result, sim, logs, read, state: JSON.parse(read('.docturnal/state.json')), exists: (file) => fs.existsSync(path.join(cwd, file)) };
}

test('a project shaped like excalidraw: packages/ grouped as one part, packages/excalidraw split by its subfolders at the third level, within 90 minutes', { timeout: 900000 }, async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(excalidrawLike(), 'A project');
    const first = await runOnce(repo, mock);
    const { state, sim } = first;
    console.log(`  ${first.logs.find((l) => l.startsWith('Docturnal: benchmark: '))}`);
    assert.ok(sim.minutes() <= 90, `took ${sim.minutes().toFixed(1)} simulated minutes`);
    assert.deepStrictEqual(first.result.leftOver, []);
    assert.strictEqual(Object.values(state.files).filter((e) => typeof e.summary === 'string').length, SOURCE_FILES);
    for (const call of sim.calls.filter((c) => c.model === 'docs-model')) assert.ok(call.promptChars <= DOC_PROMPT_LIMIT, `${call.label}: ${call.promptChars}`);

    // 15 parts are more than the README lists, so packages/, which holds 7 of them, is one part.
    const docName = (layer) => `${layer.part ? `${layer.part}/` : ''}${layer.slug}`;
    const docOf = (layer) => `docs/${docName(layer)}.md`;
    const subsOf = (layer) => state.layers.filter((l) => l.part === docName(layer));
    const parts = state.layers.filter((l) => !l.part);
    assert.deepStrictEqual(parts.map((l) => l.name), ['Top Level', 'Docs', 'With Nextjs', 'With Script in Browser', 'Excalidraw App', 'Firebase Project', 'Packages', 'Public', 'Scripts']);
    assert.ok(first.logs.includes('Docturnal: the project is documented as 9 parts (11 packages) with 30 sub-documents'), first.logs.join('\n'));
    // No document holds files of two packages or folders, every file is in exactly one, a
    // document holds tests only or no tests, and none is deeper than three levels.
    const seen = new Set();
    for (const layer of state.layers) {
      assert.ok(new Set(layer.files.map(ownerOf)).size <= 1, `${layer.name} mixes packages`);
      assert.ok(layer.files.every(isTestFile) || !layer.files.some(isTestFile), `${layer.name} mixes tests and code`);
      assert.ok(docName(layer).split('/').length <= 3, docName(layer));
      for (const file of layer.files) {
        assert.ok(!seen.has(file), file);
        seen.add(file);
      }
    }
    assert.strictEqual(seen.size, SOURCE_FILES);

    // The grouped part lists its packages, and its one more sentence is about them, not one
    // folder's summary.
    const grouped = parts.find((p) => p.name === 'Packages');
    const holds = "Holds the project's 7 packages: Excalidraw Common, Excalidraw Element, Excalidraw Eslint Config, Excalidraw, Excalidraw Math, Excalidraw Prettier Config, and Excalidraw Utilities.";
    assert.ok(grouped.description.startsWith(`${holds} `), grouped.description);
    const sentence = grouped.description.slice(holds.length + 1);
    assert.match(sentence, /^[A-Z][^.]*\.$/);
    assert.ok(!Object.values(state.folders).includes(sentence), sentence);
    assert.deepStrictEqual(grouped.files, []);
    assert.deepStrictEqual(subsOf(grouped).map((l) => l.name), ['Excalidraw Common', 'Excalidraw Element', 'Excalidraw Eslint Config', 'Excalidraw', 'Excalidraw Math', 'Excalidraw Prettier Config', 'Excalidraw Utilities']);

    // packages/excalidraw, at the second level, keeps its root files, with a third-level
    // document for each of its subfolders: components/ and actions/ divided within themselves,
    // and its tests apart.
    const excalidraw = subsOf(grouped).find((l) => l.name === 'Excalidraw');
    assert.strictEqual(docName(excalidraw), 'packages/excalidraw');
    assert.ok(excalidraw.files.length === 30 && excalidraw.files.every((f) => path.posix.dirname(f) === 'packages/excalidraw'));
    const third = subsOf(excalidraw);
    assert.ok(third.every((l) => docName(l).startsWith('packages/excalidraw/') && subsOf(l).length === 0));
    const folderOf = (layer) => [...new Set(layer.files.map((f) => f.split('/').slice(0, 3).join('/')))];
    assert.ok(third.every((l) => folderOf(l).length === 1), 'a sub-document spans two subfolders');
    assert.deepStrictEqual([...new Set(third.flatMap(folderOf))].sort(), ['actions', 'components', 'data', 'fonts', 'hooks', 'renderer', 'scene', 'tests'].map((s) => `packages/excalidraw/${s}`));
    assert.strictEqual(third.filter((l) => folderOf(l)[0].endsWith('/components')).length, 4);
    assert.strictEqual(third.filter((l) => folderOf(l)[0].endsWith('/actions')).length, 2);
    assert.deepStrictEqual(['data', 'fonts', 'hooks', 'renderer', 'scene', 'tests'].map((s) => third.find((l) => l.slug === s)).map((l) => [docName(l), l.files.length]),
      [['packages/excalidraw/data', 26], ['packages/excalidraw/fonts', 22], ['packages/excalidraw/hooks', 6], ['packages/excalidraw/renderer', 12], ['packages/excalidraw/scene', 16], ['packages/excalidraw/tests', 90]]);
    // A package of fewer than 40 code files is one document, with its tests below it, and one
    // with all of its 80 files in src/ is divided within src/.
    const common = subsOf(grouped).find((l) => l.name === 'Excalidraw Common');
    assert.deepStrictEqual([common.files.length, subsOf(common).map((l) => [l.name, l.files.length])], [22, [['Tests', 4]]]);
    const element = subsOf(grouped).find((l) => l.name === 'Excalidraw Element');
    assert.deepStrictEqual([element.files.length, subsOf(element).map((l) => folderOf(l)[0])], [0, ['packages/element/src', 'packages/element/src', 'packages/element/tests']]);

    // Every part's doc is written first, then the sub-documents with the most files below them,
    // then tests; the ones that do not fit are left for the next run and named in the pull request.
    const byDoc = new Map(state.layers.map((l) => [docOf(l), l]));
    const written = sim.calls.filter((c) => /^docs\//.test(c.label)).map((c) => byDoc.get(c.label));
    assert.ok(written.every(Boolean));
    assert.deepStrictEqual(written.slice(0, parts.length).map((l) => l.name), parts.map((l) => l.name));
    const below = (layer) => layer.files.length + subsOf(layer).reduce((n, s) => n + below(s), 0);
    const code = written.slice(parts.length).filter((l) => !l.files.every(isTestFile));
    for (let i = 1; i < code.length; i++) assert.ok(below(code[i]) <= below(code[i - 1]), `${code[i].name} before ${code[i - 1].name}`);
    const firstTest = written.findIndex((l) => l.files.length && l.files.every(isTestFile));
    assert.ok(firstTest === -1 || written.slice(firstTest).every((l) => l.files.every(isTestFile)));
    assert.ok(parts.every((p) => first.exists(docOf(p))));
    const left = state.layers.filter((l) => l.part && !first.exists(docOf(l)));
    assert.ok(left.length > 0 && left.length < 30, `${left.length} sub-documents left`);
    assert.deepStrictEqual(state.staleDocs.filter((s) => s !== 'README').sort(), left.map(docName).sort());
    const lastRun = first.read('.docturnal/last-run.md');
    assert.match(lastRun, new RegExp(`- \\*\\*Documentation:\\*\\* every file is read, and \\d+ layer documents and the README are written\\. ${left.length} more documents follow on the next run\\.`));
    for (const layer of left) assert.ok(lastRun.includes(`\`${docOf(layer)}\`: time budget, after the part documents`), docOf(layer));

    // Links both ways at every level: a doc lists its sub-documents, linking the written ones,
    // and each sub-document links the doc it is in and the README.
    const checkLinks = (run, layer) => {
      const doc = run.read(docOf(layer));
      const depth = docName(layer).split('/').length;
      for (const sub of subsOf(layer)) {
        if (run.exists(docOf(sub))) {
          assert.ok(doc.includes(`- [${sub.name}](${layer.slug}/${sub.slug}.md): `), `${layer.name} lists ${sub.name}`);
          const subDoc = run.read(docOf(sub));
          assert.ok(subDoc.includes(`- [${layer.name}](../${layer.slug}.md): `), `${sub.name} links ${layer.name}`);
          assert.ok(subDoc.includes(`- [Project README](${'../'.repeat(depth + 1)}README.md)`), `${sub.name} links the README`);
        } else {
          assert.ok(doc.includes(`- ${sub.name}: `) && !doc.includes(`](${layer.slug}/${sub.slug}.md)`), sub.name);
        }
      }
    };
    checkLinks(first, grouped);
    checkLinks(first, excalidraw);
    // The README lists the parts, each with links to its written sub-documents.
    const readme = first.read('README.md');
    const table = readme.slice(readme.indexOf('<!-- docturnal:layers -->'), readme.indexOf('<!-- /docturnal:layers -->'));
    assert.match(table, /\| Part \| Description \| Details \|/);
    assert.strictEqual(table.split('\n').filter((l) => l.startsWith('| [')).length, parts.length);
    assert.ok(table.includes(`| [Packages](docs/packages.md) | ${holds} `));
    for (const layer of subsOf(grouped)) assert.strictEqual(table.includes(`(docs/${docName(layer)}.md)`), first.exists(docOf(layer)), layer.name);

    // The next run writes the sub-documents left, and each list then links them all.
    const second = await runOnce(repo, mock);
    assert.ok(second.state.layers.every((l) => second.exists(docOf(l))), second.logs.filter((l) => /docs\//.test(l)).join('\n'));
    assert.deepStrictEqual(second.state.staleDocs, []);
    for (const layer of [grouped, excalidraw]) {
      checkLinks(second, layer);
      assert.ok(!second.read(docOf(layer)).includes('not written yet'), layer.name);
    }
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
