'use strict';

// Edge cases of how Docturnal covers a project, against real git with the mock Ollama server.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it, test } = require('node:test');

const { readCandidates } = require('../src/changes');
const { readConfig } = require('../src/config');
const { listFiles } = require('../src/git');
const { selectBatch } = require('../src/importance');
const { jobCount, splitShards } = require('../src/plan');
const { readState } = require('../src/state');
const { summarizeFile } = require('../src/summary');
const { defaultHandler, startMockOllama } = require('./mock-ollama');
const { fn, gitRepo, runAction } = require('./git-repo');

const summaries = (mock) => mock.requests.filter((r) => r.messages && r.messages[0] && r.messages[0].content.startsWith('You read one source file'));
const commentRequests = (mock) => mock.requests.filter((r) => r.format && r.format.properties && r.format.properties.comments && r.format.properties.summary);

// --- Repositories with nothing to cover ---

describe('repositories with no source files', () => {
  let mock;
  before(async () => {
    mock = await startMockOllama();
  });
  after(() => mock.close());

  for (const [name, files] of [
    ['only docs and config', { 'README.md': '# Notes\n', 'package.json': '{ "name": "notes" }\n', 'docs/guide.md': '# Guide\n' }],
    ['every source file ignored', { '.docturnalignore': 'src/\n', 'src/a.js': fn('a'), 'src/b.js': fn('b'), 'README.md': '# App\n' }],
    ['an empty repository', { '.gitkeep': '' }],
  ]) {
    it(`${name}: the pre-check stops, and a run opens no pull request`, async () => {
      const repo = gitRepo();
      try {
        repo.commit(files, 'Initial commit');
        const pre = await runAction(repo, repo.clone(), null, { GITHUB_OUTPUT: path.join(repo.work, 'out') }, 'src/precheck.js');
        assert.strictEqual(pre.code, 0, pre.stderr);
        assert.match(pre.log, /^No source files to document or comment$/m);
        assert.match(fs.readFileSync(path.join(repo.work, 'out'), 'utf8'), /^changed=false$/m);
        mock.requests.length = 0;
        const run = await runAction(repo, repo.clone(), mock);
        assert.strictEqual(run.code, 0, run.stderr);
        assert.match(run.log, /no source files to document or comment/);
        assert.deepStrictEqual(mock.requests, []);
        assert.strictEqual(repo.hasBranch('docturnal/update'), false);
      } finally {
        repo.cleanup();
      }
    });
  }
});

// --- Sizes ---

test('one source file: documented on the first run, commented in batch 1 on the next', async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit({ 'index.js': fn('main') }, 'Initial commit');
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.strictEqual(summaries(mock).length, 1);
    assert.strictEqual(repo.state().docsComplete, true);
    assert.match(repo.text('docturnal/update', '.docturnal/last-run.md'), /\*\*Comments:\*\* 0 of 1 file commented/);
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.deepStrictEqual(repo.state().pending.batch.files, ['index.js']);
    assert.match(repo.text('docturnal/update', '.docturnal/last-run.md'), /\*\*Comments:\*\* 1 of 1 file commented/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('job counts at 39, 40, 41, and 500+ files, public and private', () => {
  const at = (n, isPrivate) => jobCount(n, { isPrivate });
  assert.deepStrictEqual([39, 40, 41, 500, 5000].map((n) => at(n, false)), [1, 2, 3, 8, 8]);
  assert.deepStrictEqual([39, 40, 41, 500, 5000].map((n) => at(n, true)), [1, 2, 2, 2, 2]);
  // 600 files split over 8 shards: each file once, in a few milliseconds.
  const items = Array.from({ length: 600 }, (_, i) => ({ path: `src/dir${i % 30}/f${i}.js`, size: 200 + (i % 97) * 50 }));
  const started = Date.now();
  const shards = splitShards(items, 8);
  assert.ok(Date.now() - started < 500);
  assert.strictEqual(new Set(shards.flat().map((i) => i.path)).size, 600);
});

test('every file in one layer: a batch takes the batch size from that layer', () => {
  const files = Array.from({ length: 20 }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
  const batch = selectBatch(files.map((p) => ({ path: p })), [{ name: 'Core', files }], 15);
  assert.strictEqual(batch.files.length, 15);
  assert.deepStrictEqual(batch.layers, ['Core']);
});

// --- Branches and timing ---

test('a default branch named master works the same', async () => {
  const mock = await startMockOllama();
  const repo = gitRepo({ branch: 'master' });
  try {
    repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
    const out = path.join(repo.work, 'out');
    const pre = await runAction(repo, repo.clone(), null, { GITHUB_OUTPUT: out }, 'src/precheck.js');
    assert.match(fs.readFileSync(out, 'utf8'), /^base=master$/m, pre.stderr);
    const run = await runAction(repo, repo.clone(), mock);
    assert.strictEqual(run.code, 0, run.stderr);
    assert.match(run.log, /base master/);
    assert.ok(repo.hasBranch('docturnal/update'));
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

describe('changes while a parallel run is going', () => {
  let mock;
  before(async () => {
    mock = await startMockOllama();
  });
  after(() => mock.close());
  const modes = (repo, mode, extra = {}) => ({
    INPUT_MODE: mode,
    DOCTURNAL_PLAN: path.join(repo.work, 'plan', 'plan.json'),
    DOCTURNAL_RESULTS: path.join(repo.work, 'results'),
    GITHUB_OUTPUT: path.join(repo.work, `out-${mode}`),
    ...extra,
  });

  it('a person changes, deletes, and renames files on main between the plan and the finish: the run finishes on the tree it planned', async () => {
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b'), 'src/c.js': fn('c') }, 'Initial commit');
      assert.strictEqual((await runAction(repo, repo.clone(), mock, modes(repo, 'plan'))).code, 0);
      // While the work runs, a person pushes to main.
      repo.commit({ 'src/a.js': `${fn('a')}\nexport const EDITED = 1;\n`, 'src/b.js': null, 'src/c.js': null, 'src/renamed.js': fn('c') }, 'Edit, delete, and rename');
      assert.strictEqual((await runAction(repo, repo.clone(), mock, modes(repo, 'work'))).code, 0);
      const finish = await runAction(repo, repo.clone(), mock, modes(repo, 'finish'));
      assert.strictEqual(finish.code, 0, finish.stderr);
      // The pull request holds the planned tree: the person's push is not in it yet.
      assert.deepStrictEqual(Object.keys(repo.state().files).sort(), ['src/a.js', 'src/b.js', 'src/c.js']);
      assert.doesNotMatch(repo.text('docturnal/update', 'src/a.js'), /EDITED/);
      // The next night merges main in and picks up all three changes.
      const pre = await runAction(repo, repo.clone(), null, { GITHUB_OUTPUT: path.join(repo.work, 'out-next') }, 'src/precheck.js');
      assert.match(pre.log, /2 files new or changed, 2 files deleted/);
    } finally {
      repo.cleanup();
    }
  });

  it('the open pull request is merged while a run is going: the new run starts a new pull request', async () => {
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
      assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0); // Docs: pull request open.
      assert.strictEqual(repo.state().pending.docs, true);
      assert.strictEqual((await runAction(repo, repo.clone(), mock, modes(repo, 'plan'))).code, 0);
      repo.merge(); // The person merges the docs pull request while batch 1 runs.
      assert.strictEqual((await runAction(repo, repo.clone(), mock, modes(repo, 'work'))).code, 0);
      const finish = await runAction(repo, repo.clone(), mock, modes(repo, 'finish'));
      assert.strictEqual(finish.code, 0, finish.stderr);
      assert.match(finish.log, /the open pull request was merged during the run; this run starts a new one/);
      const state = repo.state();
      assert.strictEqual(state.pending.docs, false);
      assert.strictEqual(state.pending.batch.number, 1);
      assert.match(repo.text('docturnal/update', '.docturnal/last-run.md'), /\*\*This pull request:\*\* batch 1 of existing code/);
    } finally {
      repo.cleanup();
    }
  });
});

// --- Failures ---

test('the docs model cannot load in the finish job: the comment model writes the docs, and the pull request says so', async () => {
  const mock = await startMockOllama(defaultHandler({ oomModels: ['oom-docs-model'] }));
  const repo = gitRepo();
  try {
    const files = {};
    for (let i = 0; i < 4; i++) files[`src/m${i}.js`] = fn(`m${i}`);
    repo.commit(files, 'Initial commit');
    const env = (mode) => ({ INPUT_MODE: mode, DOCTURNAL_PLAN: path.join(repo.work, 'p', 'plan.json'), DOCTURNAL_RESULTS: path.join(repo.work, 'r'), INPUT_SELECTED_DOCS_MODEL: 'oom-docs-model', GITHUB_OUTPUT: path.join(repo.work, `o-${mode}`) });
    for (const mode of ['plan', 'work']) assert.strictEqual((await runAction(repo, repo.clone(), mock, env(mode))).code, 0);
    const finish = await runAction(repo, repo.clone(), mock, env('finish'));
    assert.strictEqual(finish.code, 0, finish.stderr);
    const lastRun = repo.text('docturnal/update', '.docturnal/last-run.md');
    assert.match(lastRun, /\(written with the fallback model\)/);
    assert.match(lastRun, /The docs model could not load/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('an interrupted first run, then a normal night, then the first batch', async () => {
  const { run } = require('../src/main');
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    const files = {};
    for (let i = 0; i < 6; i++) files[`src/f${i}.js`] = fn(`f${i}`);
    repo.commit(files, 'Initial commit');
    // The first run runs out of time after four files: each call takes 10 simulated minutes.
    let clock = Date.parse('2026-10-24T00:00:00Z');
    const chat = async (request) => {
      clock += 10 * 60000;
      const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
      return (await res.json()).message.content;
    };
    const first = await run({
      cwd: repo.clone(),
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '60', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' },
      chat,
      now: () => clock,
      log: () => {},
    });
    assert.strictEqual(first.leftOver.length, 2);
    assert.strictEqual(repo.state().docsComplete, false);
    // The next night reads the two files it missed, and still comments nothing.
    mock.requests.length = 0;
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.strictEqual(summaries(mock).length, 2);
    assert.strictEqual(commentRequests(mock).length, 0);
    assert.strictEqual(repo.state().docsComplete, true);
    // Then batch 1 follows.
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.strictEqual(repo.state().pending.batch.files.length, 6);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('"Only new and changed code" with a change of level: no batches, and changed files at the new level', async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
    await runAction(repo, repo.clone(), mock); // Docs.
    await runAction(repo, repo.clone(), mock); // Batch 1, at medium.
    repo.merge();
    repo.commit({ 'src/a.js': `${fn('a')}\nexport const LIMIT = 2;\n` }, 'Edit a');
    const result = await runAction(repo, repo.clone(), mock, { INPUT_COMMENT_LEVEL: 'heavy', INPUT_EXISTING_CODE: 'none' });
    assert.strictEqual(result.code, 0, result.stderr);
    const state = repo.state();
    assert.strictEqual(state.files['src/a.js'].level, 'heavy');
    assert.strictEqual(state.files['src/b.js'].level, 'medium');
    assert.strictEqual(state.pending.batch, null);
    assert.match(repo.text('docturnal/update', '.docturnal/last-run.md'), /\*\*Comments:\*\* 1 of 2 files commented at the heavy level\./);
    // A quiet night after that: still no batch for b.js.
    repo.merge();
    const pre = await runAction(repo, repo.clone(), null, { INPUT_COMMENT_LEVEL: 'heavy', INPUT_EXISTING_CODE: 'none', GITHUB_OUTPUT: path.join(repo.work, 'out') }, 'src/precheck.js');
    assert.match(pre.log, /^No changes since the last run$/m);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

// --- Unusual files ---

test('paths with spaces, Unicode, and deep folders, and CRLF line endings', async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  const deep = `src/${Array.from({ length: 12 }, (_, i) => `level${i}`).join('/')}/deep file.js`;
  const crlf = 'export function total(items) {\r\n  return items.length;\r\n}\r\n';
  try {
    repo.commit({ 'src/spa ce/ünïcödé ✓.js': fn('unicode'), [deep]: fn('deep'), 'src/windows.js': crlf }, 'Initial commit');
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.deepStrictEqual(Object.keys(repo.state().files).sort(), [deep, 'src/spa ce/ünïcödé ✓.js', 'src/windows.js'].sort());
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    const state = repo.state();
    assert.ok(Object.values(state.files).every((e) => e.level === 'medium'));
    // The comment in the CRLF file uses CRLF too, and every original line is unchanged.
    const windows = repo.file('docturnal/update', 'src/windows.js').toString('utf8');
    assert.match(windows, /^\/\/ [^\r\n]+\r\nexport function total/);
    assert.ok(!/[^\r]\n/.test(windows));
    assert.match(repo.text('docturnal/update', 'src/spa ce/ünïcödé ✓.js'), /^\/\/ Keeps the unicode logic/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('symlinks, submodules, and Git LFS pointer files are left out', () => {
  const repo = gitRepo();
  try {
    repo.commit({ 'src/real.js': fn('real'), 'src/big.js': 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n' }, 'Files');
    // A symlink and a submodule, added to the index directly so this works on every platform.
    const blob = repo.git(repo.seed, 'hash-object', '-w', '--stdin');
    repo.git(repo.seed, 'update-index', '--add', '--cacheinfo', `120000,${blob},src/link.js`);
    repo.git(repo.seed, 'update-index', '--add', '--cacheinfo', `160000,${repo.git(repo.seed, 'rev-parse', 'HEAD')},vendor/lib`);
    repo.git(repo.seed, 'commit', '-qm', 'Link and submodule');
    const listed = listFiles(repo.seed);
    assert.ok(!listed.includes('src/link.js'));
    assert.ok(!listed.includes('vendor/lib'));
    assert.ok(listed.includes('src/real.js'));
    assert.deepStrictEqual(readCandidates(repo.seed, readConfig({})).map((e) => e.path), ['src/real.js']);
  } finally {
    repo.cleanup();
  }
});

test('a huge file is read for its summary from its start, within the context budget', async () => {
  const text = Array.from({ length: 20000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  let prompt = '';
  const result = await summarizeFile({
    path: 'src/huge.js',
    text,
    model: 'm',
    contextTokens: 8192,
    chat: async ({ messages }) => {
      prompt = messages[1].content;
      return JSON.stringify({ summary: 'Many constants.', symbols: [] });
    },
  });
  assert.strictEqual(result.summary, 'Many constants.');
  assert.match(prompt, /The file is longer; this is its start\./);
  assert.ok(prompt.length < (8192 - 1500) * 3 + 200);
});

// --- States from every earlier version ---

test('state.json from every earlier version reads without losing what it recorded', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-states-'));
  const write = (data) => {
    fs.mkdirSync(path.join(dir, '.docturnal'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.docturnal/state.json'), typeof data === 'string' ? data : JSON.stringify(data));
    return readState(dir);
  };
  try {
    // The first versions: hashes, summaries, and layers.
    const v1 = write({ version: 1, updatedAt: '2026-06-01T00:00:00Z', commentLevel: 'medium', files: { 'a.js': { hash: 'h1', summary: 'A.', symbols: ['a'] }, 'cfg.json': { hash: 'h2' } }, layers: [{ slug: 'core', name: 'Core', files: ['a.js'] }], docs: ['core'], staleDocs: [] });
    assert.strictEqual(v1.docsComplete, null);
    assert.strictEqual(v1.files['a.js'].level, 'medium');
    assert.strictEqual(v1.files['cfg.json'].level, null);
    assert.deepStrictEqual(v1.pending, { docs: false, changed: [], batch: null });
    assert.strictEqual(v1.batchesDone, 0);
    // No layers yet: a first run that wrote no docs.
    assert.strictEqual(write({ version: 1, commentLevel: 'low', files: { 'a.js': { hash: 'h', summary: 'A.' } } }).docsComplete, false);
    // With .docturnalignore's hash and Docturnal's comment records.
    const v2 = write({ version: 1, commentLevel: 'heavy', ignoreHash: 'sha256-x', files: { 'a.js': { hash: 'h', summary: 'A.', symbols: [], comments: [{ text: '// A.', anchor: 'abc' }] } }, layers: [], docs: [], staleDocs: [] });
    assert.strictEqual(v2.ignoreHash, 'sha256-x');
    assert.deepStrictEqual(v2.files['a.js'].comments, [{ text: '// A.', anchor: 'abc' }]);
    // The current version, with a malformed pending record that is dropped rather than trusted.
    const v3 = write({ version: 1, commentLevel: 'medium', docsComplete: true, batchesDone: 2, pending: { docs: 'yes', changed: [1, 'b.js'], batch: { number: 0, files: 'x' } }, files: {}, layers: [], docs: [], staleDocs: [] });
    assert.deepStrictEqual(v3.pending, { docs: false, changed: ['b.js'], batch: null });
    assert.strictEqual(v3.batchesDone, 2);
    // Another format version, or a broken file, starts over.
    assert.strictEqual(write({ version: 2, files: { 'a.js': { hash: 'h' } } }).commentLevel, null);
    assert.deepStrictEqual(write('{ not json').files, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fixes from the independent review ---

describe('review fixes', () => {
  const { kindOf } = require('./mock-ollama');
  const modeEnv = (repo, mode) => ({ INPUT_MODE: mode, DOCTURNAL_PLAN: path.join(repo.work, 'p', 'plan.json'), DOCTURNAL_RESULTS: path.join(repo.work, 'r'), GITHUB_OUTPUT: path.join(repo.work, `o-${mode}`) });

  it('a file the model can never summarize is recorded, and the documentation pass still ends', async () => {
    const base = defaultHandler();
    const mock = await startMockOllama((body, n) => {
      if (kindOf(body) === 'summary' && body.messages[1].content.startsWith('File: src/broken.js')) return '{"summary": "cut o';
      return base(body, n);
    });
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/broken.js': fn('broken') }, 'Initial commit');
      const first = await runAction(repo, repo.clone(), mock);
      assert.strictEqual(first.code, 0, first.stderr);
      assert.match(first.log, /src\/broken\.js: skipped, no usable summary/);
      const state = repo.state();
      assert.strictEqual(state.docsComplete, true);
      assert.strictEqual(state.files['src/broken.js'].summaryFailed, true);
      // It can still be commented, in a batch.
      repo.merge();
      assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
      assert.ok(repo.state().pending.batch.files.includes('src/broken.js'));
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('a documentation pass whose missed files were deleted ends without reading anything', async () => {
    const { run } = require('../src/main');
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b'), 'src/c.js': fn('c') }, 'Initial commit');
      let clock = Date.parse('2026-10-24T00:00:00Z');
      const chat = async (request) => {
        clock += 20 * 60000;
        const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
        return (await res.json()).message.content;
      };
      const first = await run({
        cwd: repo.clone(),
        env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '60', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' },
        chat,
        now: () => clock,
        log: () => {},
      });
      assert.ok(first.leftOver.length > 0);
      assert.strictEqual(repo.state().docsComplete, false);
      repo.merge();
      repo.commit(Object.fromEntries(first.leftOver.map((l) => [l.path, null])), 'Delete the files the pass missed');
      mock.requests.length = 0;
      const next = await runAction(repo, repo.clone(), mock);
      assert.strictEqual(next.code, 0, next.stderr);
      assert.strictEqual(summaries(mock).length, 0);
      assert.strictEqual(repo.state().docsComplete, true);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('after a squash merge, the batch is no longer open and the next one starts', async () => {
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      const files = {};
      for (let i = 0; i < 4; i++) files[`src/f${i}.js`] = fn(`f${i}`);
      repo.commit(files, 'Initial commit');
      await runAction(repo, repo.clone(), mock); // Docs.
      const batchRun = await runAction(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '2' });
      assert.strictEqual(batchRun.code, 0, batchRun.stderr);
      assert.strictEqual(repo.state().pending.batch.number, 1);
      // A squash merge: the changes land on main as one new commit.
      repo.git(repo.seed, 'fetch', '-q', 'origin', 'docturnal/update');
      repo.git(repo.seed, 'merge', '-q', '--squash', 'FETCH_HEAD');
      repo.git(repo.seed, 'commit', '-qm', 'Docturnal (squashed)');
      repo.git(repo.seed, 'push', '-q', 'origin', 'main');
      const next = await runAction(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '2' });
      assert.strictEqual(next.code, 0, next.stderr);
      assert.strictEqual(repo.state().pending.batch.number, 2);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('a commit a person adds to docturnal/update during a parallel run is never overwritten', async () => {
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
      await runAction(repo, repo.clone(), mock); // Docs: the pull request is open.
      for (const mode of ['plan', 'work']) assert.strictEqual((await runAction(repo, repo.clone(), mock, modeEnv(repo, mode))).code, 0);
      // A reviewer commits a suggestion to the pull request.
      const reviewer = repo.clone();
      repo.git(reviewer, 'checkout', '-q', 'docturnal/update');
      fs.appendFileSync(path.join(reviewer, 'README.md'), '\nA reviewer note.\n');
      repo.git(reviewer, 'commit', '-qam', 'Reviewer suggestion');
      repo.git(reviewer, 'push', '-q', 'origin', 'docturnal/update');
      const theirs = repo.git(reviewer, 'rev-parse', 'HEAD');
      const finish = await runAction(repo, repo.clone(), mock, modeEnv(repo, 'finish'));
      assert.strictEqual(finish.code, 0, finish.stderr);
      assert.match(finish.log, /::warning::docturnal\/update changed while this run was going/);
      assert.strictEqual(repo.git(repo.remote, 'rev-parse', 'refs/heads/docturnal/update'), theirs);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('a pull request closed during a run, its branch deleted: the run does not bring it back', async () => {
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
      await runAction(repo, repo.clone(), mock); // Docs.
      for (const mode of ['plan', 'work']) assert.strictEqual((await runAction(repo, repo.clone(), mock, modeEnv(repo, mode))).code, 0);
      repo.git(repo.remote, 'update-ref', '-d', 'refs/heads/docturnal/update'); // The app deletes it on close.
      const finish = await runAction(repo, repo.clone(), mock, modeEnv(repo, 'finish'));
      assert.strictEqual(finish.code, 0, finish.stderr);
      assert.match(finish.log, /did not push/);
      assert.strictEqual(repo.hasBranch('docturnal/update'), false);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('a batch that adds no comment does not hold the next batch back', async () => {
    const base = defaultHandler();
    let silent = false;
    const mock = await startMockOllama((body, n) => {
      const reply = base(body, n);
      return silent && kindOf(body) === 'comments' ? { ...reply, comments: [] } : reply;
    });
    const repo = gitRepo();
    try {
      const files = {};
      for (let i = 0; i < 4; i++) files[`src/f${i}.js`] = fn(`f${i}`);
      repo.commit(files, 'Initial commit');
      await runAction(repo, repo.clone(), mock); // Docs.
      repo.merge();
      silent = true;
      assert.strictEqual((await runAction(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '2' })).code, 0);
      assert.strictEqual(repo.state().pending.batch, null);
      silent = false;
      assert.strictEqual((await runAction(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '2' })).code, 0);
      assert.strictEqual(repo.state().pending.batch.files.length, 2);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });

  it('an older state: a changed file Docturnal commented is commented again in the documentation pass, keeping its records', async () => {
    const { hashContent } = require('../src/state');
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      const a = `// Keeps the a logic.\n${fn('a')}`;
      const state = {
        version: 1,
        commentLevel: 'medium',
        files: { 'src/a.js': { hash: hashContent(Buffer.from(a)), summary: 'A.', symbols: [], comments: [{ text: '// Keeps the a logic.', anchor: 'x' }] } },
        layers: [{ slug: 'core', name: 'Core', description: 'All.', files: ['src/a.js'] }],
        docs: [],
        staleDocs: [],
      };
      repo.commit({ 'src/a.js': `${a}\nexport const B = 2;\n`, 'src/new.js': fn('fresh'), '.docturnal/state.json': JSON.stringify(state) }, 'Before the update');
      const result = await runAction(repo, repo.clone(), mock);
      assert.strictEqual(result.code, 0, result.stderr);
      const next = repo.state();
      assert.strictEqual(next.files['src/a.js'].level, 'medium');
      assert.ok((next.files['src/a.js'].comments || []).some((c) => c.text === '// Keeps the a logic.'));
      assert.strictEqual(next.files['src/new.js'].level, null);
    } finally {
      await mock.close();
      repo.cleanup();
    }
  });
});
