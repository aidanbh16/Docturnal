'use strict';

// A large project is documented as a hierarchy: a part for each workspace package and each
// other top-level folder, with sub-documents for a big part's subfolders and its tests. The
// layout is checked on a project shaped like excalidraw/excalidraw (788 files), with model time
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
      layers: [layer('excalidraw'), layer('components', 'excalidraw'), layer('evil', '../x'), layer('worse', 'a/b')],
      docs: ['excalidraw', 'excalidraw/components', '../escape', 'a/b/c', 'a//b'],
      staleDocs: ['README', 'excalidraw/tests', '/abs'],
    }));
    const state = readState(dir);
    assert.deepStrictEqual(state.layers.map((l) => [l.slug, l.part]), [['excalidraw', undefined], ['components', 'excalidraw']]);
    assert.deepStrictEqual(state.docs, ['excalidraw', 'excalidraw/components']);
    assert.deepStrictEqual(state.staleDocs, ['README', 'excalidraw/tests']);
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

// The part a file belongs to: the package that holds it, else its top-level folder.
const partOfFile = (file) => Object.keys(PACKAGES).find((d) => file.startsWith(`${d}/`)) || (file.includes('/') ? file.split('/')[0] : '.');

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

test('a project shaped like excalidraw: a part per package, no mixed packages, tests apart, big parts split by subfolder, within 90 minutes', { timeout: 900000 }, async () => {
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

    // One part for each package, named after it, and for each other top-level folder.
    const parts = state.layers.filter((l) => !l.part);
    assert.deepStrictEqual(parts.map((l) => l.name), [
      'Top Level', 'Docs', 'With Nextjs', 'With Script in Browser', 'Excalidraw App', 'Excalidraw Common',
      'Excalidraw Element', 'Excalidraw', 'Excalidraw Math', 'Excalidraw Utilities', 'Scripts',
    ]);
    assert.ok(parts.length <= 12);
    assert.ok(first.logs.includes('Docturnal: the project is documented as 11 parts (9 packages) with 23 sub-documents'), first.logs.join('\n'));
    // No document holds files of two parts, every file is in exactly one, and a document holds
    // tests only or no tests.
    const seen = new Set();
    for (const part of parts) {
      const all = state.layers.filter((l) => l === part || l.part === part.slug).flatMap((l) => l.files);
      assert.strictEqual(new Set(all.map(partOfFile)).size, 1, `${part.name} mixes parts`);
    }
    for (const layer of state.layers) {
      assert.ok(layer.files.every(isTestFile) || !layer.files.some(isTestFile), `${layer.name} mixes tests and code`);
      for (const file of layer.files) {
        assert.ok(!seen.has(file), file);
        seen.add(file);
      }
    }
    assert.strictEqual(seen.size, SOURCE_FILES);

    // packages/excalidraw: its root files in its own doc, a sub-document for each subfolder,
    // with components/ and actions/ divided within themselves, and its tests apart.
    const subsOf = (slug) => state.layers.filter((l) => l.part === slug);
    const excalidraw = parts.find((p) => p.name === 'Excalidraw');
    assert.ok(excalidraw.files.length === 30 && excalidraw.files.every((f) => path.posix.dirname(f) === 'packages/excalidraw'));
    const folderOf = (layer) => [...new Set(layer.files.map((f) => f.split('/').slice(0, 3).join('/')))];
    const bySubfolder = subsOf(excalidraw.slug).map((l) => folderOf(l));
    assert.ok(bySubfolder.every((folders) => folders.length === 1), 'a sub-document spans two subfolders');
    assert.deepStrictEqual([...new Set(bySubfolder.flat())].sort(), ['actions', 'components', 'data', 'fonts', 'hooks', 'renderer', 'scene', 'tests'].map((s) => `packages/excalidraw/${s}`));
    assert.strictEqual(bySubfolder.flat().filter((f) => f.endsWith('/components')).length, 4);
    assert.strictEqual(bySubfolder.flat().filter((f) => f.endsWith('/actions')).length, 2);
    assert.deepStrictEqual(subsOf(excalidraw.slug).filter((l) => ['Data', 'Fonts', 'Hooks', 'Renderer', 'Scene', 'Tests'].includes(l.name)).map((l) => l.files.length), [26, 22, 6, 12, 16, 90]);
    // A package of fewer than 40 code files is one document, with its tests apart.
    const common = parts.find((p) => p.name === 'Excalidraw Common');
    assert.deepStrictEqual([common.files.length, subsOf(common.slug).map((l) => [l.name, l.files.length])], [22, [['Tests', 4]]]);
    // A package with all of its 80 files in src/ is divided within src/.
    const element = parts.find((p) => p.name === 'Excalidraw Element');
    assert.strictEqual(element.files.length, 0);
    assert.deepStrictEqual(subsOf(element.slug).map((l) => folderOf(l)[0]), ['packages/element/src', 'packages/element/src', 'packages/element/tests']);

    // Every part's doc is written before any sub-document's, code before tests, and the
    // sub-documents that do not fit are left for the next run and named in the pull request.
    const docCalls = sim.calls.filter((c) => /^docs\//.test(c.label)).map((c) => c.label);
    const isPartDoc = (label) => !label.slice('docs/'.length).includes('/');
    assert.strictEqual(docCalls.filter(isPartDoc).length, 11);
    assert.ok(docCalls.findIndex((l) => !isPartDoc(l)) > docCalls.findLastIndex(isPartDoc));
    const docOf = (layer) => `docs/${layer.part ? `${layer.part}/` : ''}${layer.slug}.md`;
    assert.ok(parts.every((p) => first.exists(docOf(p))));
    const left = state.layers.filter((l) => l.part && !first.exists(docOf(l)));
    assert.ok(left.length > 0 && left.length < 23, `${left.length} sub-documents left`);
    assert.deepStrictEqual(state.staleDocs.filter((s) => s !== 'README').sort(), left.map((l) => `${l.part}/${l.slug}`).sort());
    const lastRun = first.read('.docturnal/last-run.md');
    assert.match(lastRun, new RegExp(`- \\*\\*Documentation:\\*\\* every file is read, and \\d+ layer documents and the README are written\\. ${left.length} more documents follow on the next run\\.`));
    for (const layer of left) assert.ok(lastRun.includes(`\`${docOf(layer)}\`: time budget, after the part documents`), docOf(layer));

    // Links both ways: a part's doc lists its sub-documents, linking the written ones, and each
    // sub-document links its part and the README.
    const partDoc = first.read(docOf(excalidraw));
    for (const sub of subsOf(excalidraw.slug)) {
      if (first.exists(docOf(sub))) {
        assert.ok(partDoc.includes(`- [${sub.name}](${excalidraw.slug}/${sub.slug}.md): `), sub.name);
        const subDoc = first.read(docOf(sub));
        assert.ok(subDoc.includes(`- [Excalidraw](../${excalidraw.slug}.md): `));
        assert.ok(subDoc.includes('- [Project README](../../README.md)'));
      } else {
        assert.ok(partDoc.includes(`- ${sub.name}: `) && !partDoc.includes(`](${excalidraw.slug}/${sub.slug}.md)`), sub.name);
      }
    }
    // The README lists the parts, each with links to its written sub-documents.
    const readme = first.read('README.md');
    const table = readme.slice(readme.indexOf('<!-- docturnal:layers -->'), readme.indexOf('<!-- /docturnal:layers -->'));
    assert.match(table, /\| Part \| Description \| Details \|/);
    assert.strictEqual(table.split('\n').filter((l) => l.startsWith('| [')).length, 11);
    for (const layer of state.layers.filter((l) => l.part)) assert.strictEqual(table.includes(`(docs/${layer.part}/${layer.slug}.md)`), first.exists(docOf(layer)), layer.name);

    // The next run writes the sub-documents left, and each part's list then links them all.
    const second = await runOnce(repo, mock);
    assert.ok(second.state.layers.every((l) => second.exists(docOf(l))), second.logs.filter((l) => /docs\//.test(l)).join('\n'));
    assert.deepStrictEqual(second.state.staleDocs, []);
    const listed = second.read(docOf(excalidraw));
    for (const sub of subsOf(excalidraw.slug)) assert.ok(listed.includes(`- [${sub.name}](${excalidraw.slug}/${sub.slug}.md): `), sub.name);
    assert.ok(!listed.includes('not written yet'));
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
