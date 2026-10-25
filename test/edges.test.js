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
const { readState } = require('../src/state');
const { defaultHandler, startMockOllama } = require('./mock-ollama');
const { fn, gitRepo, runAction } = require('./git-repo');

// Runs Docturnal in a fresh clone, in this process, and calls event() just before its first
// model call: something that happens while a run is going.
async function runDuring(repo, mock, event, extra = {}) {
  const { run } = require('../src/main');
  const logs = [];
  let first = true;
  const chat = async (request) => {
    if (first) {
      first = false;
      event();
    }
    const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
    return (await res.json()).message.content;
  };
  await run({
    cwd: repo.clone(),
    env: { ...repo.gitEnv, BASE_BRANCH: repo.branch, INPUT_COMMENT_LEVEL: 'medium', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model', ...extra },
    chat,
    log: (l) => logs.push(l),
  });
  return logs.join('\n');
}

const summaries = (mock) => mock.requests.filter((r) => r.messages && r.messages[0] && r.messages[0].content.startsWith('You describe one folder'));
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

describe('changes while a run is going', () => {
  let mock;
  before(async () => {
    mock = await startMockOllama();
  });
  after(() => mock.close());

  it('a person changes, deletes, and renames files on main during the run: the run finishes on the tree it started from', async () => {
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b'), 'src/c.js': fn('c') }, 'Initial commit');
      await runDuring(repo, mock, () => {
        repo.commit({ 'src/a.js': `${fn('a')}\nexport const EDITED = 1;\n`, 'src/b.js': null, 'src/c.js': null, 'src/renamed.js': fn('c') }, 'Edit, delete, and rename');
      });
      // The pull request holds the tree the run started from: the person's push is not in it yet.
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
      // The person merges the docs pull request while batch 1 runs.
      const log = await runDuring(repo, mock, () => repo.merge());
      assert.match(log, /the open pull request was merged during the run; this run starts a new one/);
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

test('the docs model cannot load: the comment model writes the docs, and the pull request says so', async () => {
  const mock = await startMockOllama(defaultHandler({ oomModels: ['oom-docs-model'] }));
  const repo = gitRepo();
  try {
    const files = {};
    for (let i = 0; i < 4; i++) files[`src/m${i}.js`] = fn(`m${i}`);
    repo.commit(files, 'Initial commit');
    const result = await runAction(repo, repo.clone(), mock, { INPUT_SELECTED_DOCS_MODEL: 'oom-docs-model' });
    assert.strictEqual(result.code, 0, result.stderr);
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
    for (let i = 0; i < 6; i++) files[`src/m${i}/f${i}.js`] = fn(`f${i}`);
    repo.commit(files, 'Initial commit');
    // The first run stops reading after three folders: each call takes 10 simulated minutes,
    // and summaries stop at 20 of the 60, so the docs always get written.
    let clock = Date.parse('2026-10-24T00:00:00Z');
    const chat = async (request) => {
      clock += (request.model === "comment-model" ? 10 : 2) * 60000;
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
    assert.strictEqual(first.leftOver.length, 3);
    assert.strictEqual(repo.state().docsComplete, false);
    // The README says which folders are not described yet.
    assert.match(repo.text('docturnal/update', 'README.md'), /Not described yet: `src\/m3`, `src\/m4`, `src\/m5`\. The next update adds them\./);
    // The next night reads the three folders it missed, and still comments nothing.
    mock.requests.length = 0;
    assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
    assert.strictEqual(summaries(mock).length, 3);
    assert.doesNotMatch(repo.text('docturnal/update', 'README.md'), /Not described yet/);
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

  it('a file the model can never summarize is described from its structure, and the documentation pass still ends', async () => {
    const base = defaultHandler();
    const mock = await startMockOllama((body, n) => {
      if (kindOf(body) === 'folder' && body.messages[1].content.startsWith('Files in the folder src/odd.')) return '{"summary": "cut o';
      return base(body, n);
    });
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/odd/broken.js': fn('broken') }, 'Initial commit');
      const first = await runAction(repo, repo.clone(), mock);
      assert.strictEqual(first.code, 0, first.stderr);
      assert.match(first.log, /^src\/odd\/broken\.js: described from its structure, the answer could not be used \(answer cut off before its end\)$/m);
      const state = repo.state();
      assert.strictEqual(state.docsComplete, true);
      assert.strictEqual(state.files['src/odd/broken.js'].summary, 'Defines `broken`.');
      assert.strictEqual(state.files['src/odd/broken.js'].summaryFailed, undefined);
      // It can still be commented, in a batch.
      repo.merge();
      assert.strictEqual((await runAction(repo, repo.clone(), mock)).code, 0);
      assert.ok(repo.state().pending.batch.files.includes('src/odd/broken.js'));
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
      repo.commit({ 'src/a/a.js': fn('a'), 'src/b/b.js': fn('b'), 'src/c/c.js': fn('c') }, 'Initial commit');
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

  it('a commit a person adds to docturnal/update during a run is never overwritten', async () => {
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      repo.commit({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, 'Initial commit');
      await runAction(repo, repo.clone(), mock); // Docs: the pull request is open.
      // A reviewer commits a suggestion to the pull request while the next run is going.
      let theirs = null;
      const log = await runDuring(repo, mock, () => {
        const reviewer = repo.clone();
        repo.git(reviewer, 'checkout', '-q', 'docturnal/update');
        fs.appendFileSync(path.join(reviewer, 'README.md'), '\nA reviewer note.\n');
        repo.git(reviewer, 'commit', '-qam', 'Reviewer suggestion');
        repo.git(reviewer, 'push', '-q', 'origin', 'docturnal/update');
        theirs = repo.git(reviewer, 'rev-parse', 'HEAD');
      });
      assert.match(log, /::warning::docturnal\/update changed while this run was going/);
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
      // The app deletes the branch when its pull request is closed, while the next run is going.
      const log = await runDuring(repo, mock, () => repo.git(repo.remote, 'update-ref', '-d', 'refs/heads/docturnal/update'));
      assert.match(log, /did not push/);
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

// --- Symbolic links to Docturnal's paths ---

describe('symbolic links in place of the files Docturnal reads and writes', () => {
  const linksWork = (() => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-link-'));
    try {
      fs.symlinkSync('target', path.join(dir, 'link'));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  const skip = linksWork ? false : 'this system cannot create symbolic links';
  const { isPlainPath } = require('../src/safe-path');

  // A repository whose README.md, docs/core.md, and package.json are links to files outside it.
  function linkedRepo(outside) {
    const repo = gitRepo();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the repository\n');
    fs.mkdirSync(path.join(repo.seed, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.seed, 'src', 'a.js'), fn('a'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo.seed, 'README.md'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo.seed, 'package.json'));
    repo.git(repo.seed, 'add', '-A');
    repo.git(repo.seed, 'commit', '-qm', 'Links');
    repo.git(repo.seed, 'push', '-q', 'origin', 'main');
    return repo;
  }

  it('a linked README.md and package.json are never read or written, and the file they point to is unchanged', { skip }, async () => {
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-outside-'));
    const mock = await startMockOllama();
    const repo = linkedRepo(outside);
    try {
      const cwd = repo.clone();
      assert.strictEqual(isPlainPath(cwd, 'README.md'), false);
      const result = await runAction(repo, cwd, mock);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.log, /^README\.md is a symbolic link, so Docturnal leaves it alone\.$/m);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside the repository\n');
      // Nothing from outside the repository reaches the model or the commit.
      assert.ok(!mock.requests.some((r) => JSON.stringify(r).includes('outside the repository')));
      assert.doesNotMatch(repo.text('docturnal/update', '.docturnal/state.json'), /outside the repository/);
    } finally {
      await mock.close();
      repo.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a linked .docturnal folder stops the run with a clear message, and nothing is pushed', { skip }, async () => {
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-outside-'));
    const mock = await startMockOllama();
    const repo = gitRepo();
    try {
      fs.mkdirSync(path.join(repo.seed, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo.seed, 'src', 'a.js'), fn('a'));
      fs.symlinkSync(outside, path.join(repo.seed, '.docturnal'));
      repo.git(repo.seed, 'add', '-A');
      repo.git(repo.seed, 'commit', '-qm', 'A linked state folder');
      repo.git(repo.seed, 'push', '-q', 'origin', 'main');
      const result = await runAction(repo, repo.clone(), mock);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /\.docturnal\/state\.json is a symbolic link, or is inside one\./);
      assert.deepStrictEqual(fs.readdirSync(outside), []);
      assert.strictEqual(repo.hasBranch('docturnal/update'), false);
    } finally {
      await mock.close();
      repo.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a linked doc in docs/ counts as a person\'s and is never overwritten', { skip }, () => {
    const { writeDocs, MARKER } = require('../src/docs');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-docs-'));
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-outside-'));
    try {
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(outside, 'target.md'), `${MARKER}\n\nOutside.\n`);
      fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'docs', 'core.md'));
      const result = writeDocs({ root, docs: [{ path: 'docs/core.md', content: `${MARKER}\n\nNew.\n` }], removed: ['docs/core.md'] });
      assert.deepStrictEqual(result.written, []);
      assert.deepStrictEqual(result.deleted, []);
      assert.deepStrictEqual(result.skipped, [{ path: 'docs/core.md', reason: 'a symbolic link' }]);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), `${MARKER}\n\nOutside.\n`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('paths with .. are never plain', () => {
    assert.strictEqual(isPlainPath(process.cwd(), '../x'), false);
    assert.strictEqual(isPlainPath(process.cwd(), 'docs/../../x'), false);
    assert.strictEqual(isPlainPath(process.cwd(), 'no/such/file.md'), true);
  });
});

test('file names, headings, and layer names cannot inject Markdown, mentions, or links into the pull request', () => {
  const { buildReport } = require('../src/report');
  const evil = 'src/x` [Re-authorize](https://evil.example) @acme/everyone `.js';
  const report = buildReport({
    processed: [{ path: evil, added: 1, verifier: 'typescript', stats: null, rejections: [{ line: 2, reason: 'contains */', category: 'safety' }] }],
    docs: { updated: [{ path: 'docs/a|b.md' }], removed: [], pending: [], readme: { updated: ['Setup @acme/everyone [click](https://evil.example)'], polished: [], kept: [], notReadded: [] } },
    leftOver: [{ path: 'src/new\nline.js', reason: 'time budget' }],
    skipped: [{ path: evil, reason: 'not UTF-8' }],
    models: { comment: 'c', docs: 'd', level: 'medium' },
    progress: null,
  });
  // Every file name stays inside a code span its own backticks cannot end.
  assert.ok(report.includes('``src/x` [Re-authorize](https://evil.example) @acme/everyone `.js``'));
  // Headings: no live link, mention, or autolink.
  assert.ok(report.includes('"Setup &#64;acme/everyone \\[click\\](https:&#47;&#47;evil.example)"'));
  // A newline in a file name cannot start a new line of Markdown.
  assert.ok(report.includes('`src/new line.js`'));
  assert.doesNotMatch(report, /^line\.js/m);
});

test('a run started on a branch other than the default one stops before doing anything', async () => {
  const repo = gitRepo();
  try {
    repo.commit({ 'src/a.js': fn('a') }, 'Initial commit');
    repo.git(repo.seed, 'checkout', '-q', '-b', 'feature');
    repo.git(repo.seed, 'push', '-q', 'origin', 'feature');
    const event = path.join(repo.work, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main', private: false } }));
    const extra = { BASE_BRANCH: 'feature', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: path.join(repo.work, 'out') };
    for (const script of ['src/precheck.js', 'src/main.js']) {
      const result = await runAction(repo, repo.clone(), null, extra, script);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /::error::Docturnal runs only on the default branch, main\. This run started on feature, so it stopped\./);
    }
    assert.strictEqual(repo.hasBranch('docturnal/update'), false);
    // On the default branch, the same event is fine.
    const ok = await runAction(repo, repo.clone(), null, { ...extra, BASE_BRANCH: 'main' }, 'src/precheck.js');
    assert.strictEqual(ok.code, 0, ok.stderr);
  } finally {
    repo.cleanup();
  }
});

test('a state file with a layer slug or doc name that is a path drops it, so no file outside docs/ is ever touched', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'docturnal-slugs-'));
  try {
    fs.mkdirSync(path.join(dir, '.docturnal'));
    fs.writeFileSync(path.join(dir, '.docturnal/state.json'), JSON.stringify({
      version: 1,
      commentLevel: 'medium',
      files: {},
      layers: [
        { slug: '../../x', name: 'Escape', files: ['a.js'] },
        { slug: 'core', name: 'Core', files: ['b.js'] },
      ],
      docs: ['../README', 'core'],
      staleDocs: ['../../x', 'README', 'core'],
    }));
    const state = readState(dir);
    assert.deepStrictEqual(state.layers.map((l) => l.slug), ['core']);
    assert.deepStrictEqual(state.docs, ['core']);
    assert.deepStrictEqual(state.staleDocs, ['README', 'core']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('layer docs stop starting early enough that the README is always written', async () => {
  const { run } = require('../src/main');
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    const files = {};
    // Three files in each area, so each stays a layer of its own.
    for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) files[`src/area${i}/file${j}.js`] = fn(`area${i}x${j}`);
    repo.commit(files, 'Seven areas');
    // Summaries are instant; every docs-model call takes 6 simulated minutes of the 40.
    let clock = Date.parse('2026-10-24T00:00:00Z');
    const chat = async (request) => {
      if (request.model === 'docs-model') clock += 6 * 60000;
      const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
      return (await res.json()).message.content;
    };
    const cwd = repo.clone();
    const logs = [];
    await run({
      cwd,
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '40', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model', PUSH: 'false' },
      chat,
      now: () => clock,
      log: (l) => logs.push(l),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.docturnal/state.json'), 'utf8'));
    // Some layer docs wait for the next run, but the README was written.
    assert.ok(state.staleDocs.length > 0 && !state.staleDocs.includes('README'), state.staleDocs.join(', '));
    assert.match(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), /## Architecture/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
