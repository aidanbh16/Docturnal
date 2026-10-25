'use strict';

// How Docturnal covers a project: documentation first, then new and changed code, then
// existing code in small batches ordered by importance; progress in every pull request;
// parallel jobs for big passes; and never losing work to the job's timeout.

const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it, test } = require('node:test');
const { promisify } = require('node:util');

const { checkCoverage } = require('../src/finish');
const { rankFiles, selectBatch } = require('../src/importance');
const { jobCount, planWork, repositoryIsPrivate, splitShards } = require('../src/plan');
const { progressLines, pullRequestTitle } = require('../src/report');
const { emptyPending, emptyState } = require('../src/state');
const { startMockOllama } = require('./mock-ollama');

const ROOT = path.join(__dirname, '..');
const CONFIG = { existingCode: 'gradual', backlogBatchSize: 15, commentLevel: 'medium' };

// A findChanges result for paths, with sizes, and the state's view of them.
function changesFor({ code = [], changed = [], backlog = [] }) {
  const entry = (p) => ({ path: p, action: 'comment', hash: `h-${p}`, buffer: Buffer.alloc(100) });
  const entries = code.map(entry);
  return {
    entries,
    current: new Map(entries.map((e) => [e.path, e])),
    toComment: changed.map(entry),
    backlog: backlog.map(entry),
    changedDocsOnly: [],
    deleted: [],
    docsMissing: false,
    readmeChanged: false,
    legacyReadme: false,
    ignoreChanged: false,
  };
}

const BRANCH = { base: 'main', baseSha: 'b', updateSha: null, mode: 'new', unmerged: 0 };
const OPEN = { base: 'main', baseSha: 'b', updateSha: 'u', mode: 'existing', unmerged: 2 };
const rankByName = (layers = []) => (paths) => selectBatch(paths.sort().map((p) => ({ path: p })), layers, 15);
const documented = (files = {}) => ({ ...emptyState(), commentLevel: 'medium', docsComplete: true, files });

// --- Planning ---

test('the first run reads every file for the documentation and comments nothing', () => {
  const code = ['src/a.js', 'src/b.js', 'src/c.js'];
  const plan = planWork({ config: CONFIG, previous: emptyState(), changes: changesFor({ code, changed: code }), branch: BRANCH, rank: rankByName() });
  assert.strictEqual(plan.phase, 'docs');
  assert.deepStrictEqual(plan.items.map((i) => [i.path, i.kind]), code.map((p) => [p, 'summary']));
  assert.strictEqual(plan.batch, null);
});

test('new and changed files come before the backlog, and the batch keeps to its size', () => {
  const backlog = Array.from({ length: 40 }, (_, i) => `src/old${String(i).padStart(2, '0')}.js`);
  const files = Object.fromEntries([...backlog, 'src/edited.js'].map((p) => [p, { hash: 'x', summary: 's', symbols: [], level: null }]));
  const plan = planWork({
    config: CONFIG,
    previous: { ...documented(files), batchesDone: 2 },
    changes: changesFor({ code: [...backlog, 'src/edited.js', 'src/new.js'], changed: ['src/edited.js', 'src/new.js'], backlog }),
    branch: BRANCH,
    rank: rankByName(),
  });
  assert.strictEqual(plan.phase, 'normal');
  assert.deepStrictEqual(plan.items.slice(0, 2).map((i) => [i.path, i.reason]), [['src/edited.js', 'changed'], ['src/new.js', 'new']]);
  assert.strictEqual(plan.items.filter((i) => i.reason === 'backlog').length, 15);
  assert.deepStrictEqual(plan.batch.number, 3);
  assert.strictEqual(plan.batch.files.length, 15);

  // A smaller batch size is respected too.
  const small = planWork({ config: { ...CONFIG, backlogBatchSize: 4 }, previous: documented(files), changes: changesFor({ code: backlog, backlog }), branch: BRANCH,
    rank: (paths) => selectBatch(paths.map((p) => ({ path: p })), [], 4) });
  assert.strictEqual(small.batch.files.length, 4);
});

test('no second batch while the open pull request holds one; changed files still go in', () => {
  const previous = { ...documented({ 'src/a.js': { hash: 'x', level: null }, 'src/edited.js': { hash: 'x', level: 'medium' } }), batchesDone: 1,
    pending: { ...emptyPending(), batch: { number: 1, layers: [], files: ['src/z.js'] } } };
  const changes = changesFor({ code: ['src/a.js', 'src/edited.js'], changed: ['src/edited.js'], backlog: ['src/a.js'] });
  const open = planWork({ config: CONFIG, previous, changes, branch: OPEN, rank: rankByName() });
  assert.strictEqual(open.batch, null);
  assert.deepStrictEqual(open.items.map((i) => i.path), ['src/edited.js']);
  assert.strictEqual(open.pendingOpen, true);
  // Once that pull request is merged or closed, the branch has no unmerged commits: the next batch comes.
  const merged = planWork({ config: CONFIG, previous, changes, branch: { ...OPEN, unmerged: 0 }, rank: rankByName() });
  assert.deepStrictEqual(merged.batch.files, ['src/a.js']);
  assert.strictEqual(merged.batch.number, 2);
});

test('"Only new and changed code" skips the backlog', () => {
  const previous = documented({ 'src/a.js': { hash: 'x', level: null } });
  const plan = planWork({ config: { ...CONFIG, existingCode: 'none' }, previous, changes: changesFor({ code: ['src/a.js', 'src/b.js'], changed: ['src/b.js'], backlog: ['src/a.js'] }), branch: BRANCH, rank: rankByName() });
  assert.strictEqual(plan.batch, null);
  assert.deepStrictEqual(plan.items.map((i) => i.path), ['src/b.js']);
});

test('importance: entry points, then files many others import, complexity, and recent changes', () => {
  const texts = {
    'src/index.js': "import './util/format.js';\nexport function main() {}\n",
    'src/routes/users.js': "import { format } from '../util/format.js';\nexport function list() {}\n",
    'src/util/format.js': 'export function format(x) {\n  return x;\n}\n',
    'src/util/money.js': "import { format } from './format';\nexport function money(x) {\n  if (x < 0) {\n    return format(-x);\n  }\n  return x > 0 && x < 10 ? format(x) : String(x);\n}\n",
    'src/util/legacy.js': 'export const A = 1;\n',
    'src/util/busy.js': 'export const B = 2;\n',
    'lib/cli.js': "require('../src/util/format.js');\n",
    'app/models.py': 'from .helpers import tidy\n',
    'app/helpers.py': 'def tidy(x):\n    return x\n',
    'app/views.py': 'from app.helpers import tidy\n',
  };
  const files = Object.keys(texts);
  const ranked = rankFiles({
    files,
    allFiles: files,
    readText: (f) => texts[f],
    packageJson: { main: './lib/cli.js' },
    activity: new Map([['src/util/busy.js', 4]]),
  });
  const order = ranked.map((r) => r.path);
  // Entry points first: package.json's main, an index file, and a route file.
  assert.deepStrictEqual(order.slice(0, 3).sort(), ['lib/cli.js', 'src/index.js', 'src/routes/users.js']);
  // Then the file imported by four others (JavaScript and CommonJS), then the Python module two others import.
  assert.strictEqual(order[3], 'src/util/format.js');
  assert.strictEqual(ranked.find((r) => r.path === 'src/util/format.js').fanIn, 4);
  assert.strictEqual(ranked.find((r) => r.path === 'app/helpers.py').fanIn, 2);
  // Recent activity lifts an otherwise plain file above one nobody touched.
  assert.ok(order.indexOf('src/util/busy.js') < order.indexOf('src/util/legacy.js'));
  // Complexity counts functions and branches.
  assert.ok(ranked.find((r) => r.path === 'src/util/money.js').complexity > ranked.find((r) => r.path === 'src/util/legacy.js').complexity);
});

test('a batch stays within the most important file\'s layer, and fills from the next layers only when that one is small', () => {
  const layers = [
    { name: 'API', files: ['api/1.js', 'api/2.js', 'api/3.js'] },
    { name: 'Data', files: ['db/1.js', 'db/2.js', 'db/3.js', 'db/4.js'] },
  ];
  const ranked = ['db/1.js', 'api/1.js', 'db/2.js', 'api/2.js', 'db/3.js', 'db/4.js', 'api/3.js'].map((p) => ({ path: p }));
  assert.deepStrictEqual(selectBatch(ranked, layers, 3), { files: ['db/1.js', 'db/2.js', 'db/3.js'], layers: ['Data'] });
  assert.deepStrictEqual(selectBatch(ranked, layers, 6), { files: ['db/1.js', 'db/2.js', 'db/3.js', 'db/4.js', 'api/1.js', 'api/2.js'], layers: ['Data', 'API'] });
});

// --- Shards and worker counts ---

test('shards hold every file exactly once and are about equal in size', () => {
  const items = Array.from({ length: 97 }, (_, i) => ({ path: `f${i}.js`, size: (i * 37) % 5000 }));
  for (const jobs of [1, 3, 8]) {
    const shards = splitShards(items, jobs);
    assert.strictEqual(shards.length, jobs);
    const all = shards.flat().map((i) => i.path);
    assert.strictEqual(all.length, items.length);
    assert.strictEqual(new Set(all).size, items.length);
    const loads = shards.map((s) => s.reduce((sum, i) => sum + i.size + 1000, 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 6000, `${jobs}: ${loads}`);
    // Each shard keeps the plan's order, so new and changed files stay first.
    for (const shard of shards) {
      const indexes = shard.map((i) => items.indexOf(i));
      assert.deepStrictEqual(indexes, [...indexes].sort((a, b) => a - b));
    }
  }
});

test('one job below 40 files; then up to 8 for a public repository, 2 for a private one, or max-jobs', () => {
  assert.strictEqual(jobCount(0), 0);
  assert.strictEqual(jobCount(39, { isPrivate: false }), 1);
  assert.strictEqual(jobCount(40, { isPrivate: false }), 2);
  assert.strictEqual(jobCount(500, { isPrivate: false }), 8);
  assert.strictEqual(jobCount(500, { isPrivate: true }), 2);
  assert.strictEqual(jobCount(500, { isPrivate: true, maxJobs: 5 }), 5);
  assert.strictEqual(jobCount(45, { isPrivate: false, maxJobs: 3 }), 3);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-event-'));
  try {
    const event = (repository) => {
      fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ repository }));
      return { GITHUB_EVENT_PATH: path.join(dir, 'event.json') };
    };
    assert.strictEqual(repositoryIsPrivate(event({ private: true })), true);
    assert.strictEqual(repositoryIsPrivate(event({ private: false })), false);
    // Unknown counts as private, so a run never spends more minutes than it should.
    assert.strictEqual(repositoryIsPrivate(event({})), true);
    assert.strictEqual(repositoryIsPrivate({}), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the finish refuses results that lose or duplicate a file', () => {
  const plan = { items: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] };
  const r = (p) => ({ path: p, outcome: 'commented' });
  assert.doesNotThrow(() => checkCoverage(plan, [r('a.js'), r('b.js'), r('c.js')]));
  assert.throws(() => checkCoverage(plan, [r('a.js'), r('b.js')]), /1 missing \(c\.js\)\. Nothing was committed\./);
  assert.throws(() => checkCoverage(plan, [r('a.js'), r('b.js'), r('c.js'), r('b.js')]), /1 duplicated \(b\.js\)/);
  assert.throws(() => checkCoverage(plan, [r('a.js'), r('b.js'), r('c.js'), r('d.js')]), /1 not in the plan \(d\.js\)/);
});

// --- Progress ---

test('the progress section says how far the docs and comments are, what the pull request holds, and what comes next', () => {
  const base = { docsComplete: true, summarized: 40, documentable: 40, layers: 4, level: 'medium', commented: 12, commentable: 40, existingCode: 'gradual', backlogLeft: 13, nextBatch: 3, batchSize: 15 };
  assert.deepStrictEqual(progressLines({ ...base, pending: { docs: false, changed: ['a.js', 'b.js'], batch: { number: 2, layers: ['API'], files: Array(15).fill('x') } } }), [
    '## Progress',
    '',
    '- **Documentation:** complete, with 4 layer documents and the README.',
    '- **Comments:** 12 of 40 files commented at the medium level.',
    '- **This pull request:** comments on 2 new or changed files and batch 2 of existing code, 15 files in the API layer.',
    '- **Next:** batch 3 of existing code, after you merge or close this pull request. 13 existing files are left.',
  ]);
  const first = progressLines({ ...base, commented: 0, backlogLeft: 40, nextBatch: 1, pending: { docs: true, changed: [], batch: null } });
  assert.strictEqual(first[4], '- **This pull request:** documentation for the whole project.');
  assert.strictEqual(first[5], '- **Next:** comments on existing code in batches of up to 15 files, starting with batch 1 and the most important files. 40 existing files are left.');
  assert.strictEqual(progressLines({ ...base, docsComplete: false, summarized: 30, pending: emptyPending() })[2], '- **Documentation:** in progress, 30 of 40 files read. The rest follow on the next run.');
  assert.strictEqual(progressLines({ ...base, existingCode: 'none', pending: emptyPending() })[5], '- **Next:** comments on new and changed code only. Existing code is not commented; the "Existing code" setting changes that.');
  assert.strictEqual(progressLines({ ...base, backlogLeft: 0, pending: emptyPending() })[5], '- **Next:** comments on new and changed code. Every existing file is commented.');
  assert.strictEqual(pullRequestTitle({ docs: true, changed: [], batch: null }), 'Docturnal: documentation');
  assert.strictEqual(pullRequestTitle({ docs: true, changed: ['a.js'], batch: null }), 'Docturnal: comments and documentation');
});

// --- Whole runs against a local git remote ---

function gitRepo() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-coverage-'));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(work, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(work, 'remote.git');
  const seed = path.join(work, 'seed');
  git(work, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'clone', '-q', remote, seed);
  let clones = 0;
  return {
    work,
    git,
    remote,
    seed,
    gitEnv,
    commit(files, message = 'Change code') {
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
        fs.writeFileSync(path.join(seed, file), text);
      }
      git(seed, 'add', '-A');
      git(seed, 'commit', '-qm', message);
      git(seed, 'push', '-q', 'origin', 'main');
    },
    merge() {
      git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
      git(seed, 'push', '-q', 'origin', 'main');
    },
    clone() {
      const dir = path.join(work, `clone-${++clones}`);
      git(work, 'clone', '-q', remote, dir);
      return dir;
    },
    file(ref, file) {
      return git(remote, 'show', `${ref}:${file}`);
    },
  };
}

async function runMain(repo, cwd, mock, extra = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'src/main.js')], {
      cwd,
      env: {
        ...repo.gitEnv,
        BASE_BRANCH: 'main',
        OLLAMA_HOST: mock.host,
        INPUT_COMMENT_LEVEL: 'medium',
        INPUT_SELECTED_COMMENT_MODEL: 'comment-model',
        INPUT_SELECTED_DOCS_MODEL: 'docs-model',
        ...extra,
      },
    });
    return { code: 0, log: stdout, stderr };
  } catch (err) {
    return { code: err.code, log: err.stdout, stderr: err.stderr };
  }
}

const fn = (name) => `export function ${name}(x) {\n  return x;\n}\n`;

describe('coverage over several runs', () => {
  const repo = gitRepo();
  let mock;
  before(async () => {
    mock = await startMockOllama();
    const files = {};
    for (let i = 0; i < 20; i++) files[`src/api/handler${String(i).padStart(2, '0')}.js`] = fn(`handler${i}`);
    files['src/index.js'] = "import { handler00 } from './api/handler00.js';\nexport function main() {\n  return handler00(1);\n}\n";
    repo.commit(files, 'Initial commit');
  });
  after(async () => {
    await mock.close();
    fs.rmSync(repo.work, { recursive: true, force: true });
  });

  it('the first run documents the whole project and comments nothing', async () => {
    mock.requests.length = 0;
    const result = await runMain(repo, repo.clone(), mock);
    assert.strictEqual(result.code, 0, result.stderr);
    const kinds = mock.requests.map((r) => r.format && r.format.properties ? Object.keys(r.format.properties).join(',') : 'text');
    assert.ok(!kinds.some((k) => k.includes('comments') || k.includes('verdicts')), kinds.join(' | '));
    // One summary call per folder, not per file.
    const folderCalls = mock.requests.filter((r) => r.messages[0].content.startsWith('You describe one folder'));
    const docState = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    const dirs = new Set(Object.keys(docState.files).filter((f) => f.endsWith('.js')).map((f) => path.posix.dirname(f)));
    assert.strictEqual(folderCalls.length, dirs.size);
    assert.ok(dirs.size < 21);
    assert.strictEqual(Object.values(docState.files).filter((e) => typeof e.summary === 'string').length, 21);
    // Docs only: the code is unchanged, and the layer docs and the README are written.
    for (let i = 0; i < 21; i++) {
      const file = i === 20 ? 'src/index.js' : `src/api/handler${String(i).padStart(2, '0')}.js`;
      assert.strictEqual(repo.file('docturnal/update', file), repo.file('main', file));
    }
    assert.match(repo.file('docturnal/update', 'README.md'), /This README is maintained by Docturnal/);
    const lastRun = repo.file('docturnal/update', '.docturnal/last-run.md');
    assert.match(lastRun, /^# Docturnal: documentation\n/);
    assert.match(lastRun, /- \*\*Documentation:\*\* complete, with \d+ layer documents? and the README\./);
    assert.match(lastRun, /- \*\*Comments:\*\* 0 of 21 files commented at the medium level\./);
    assert.match(lastRun, /- \*\*This pull request:\*\* documentation for the whole project\./);
    assert.match(lastRun, /- \*\*Next:\*\* comments on existing code in batches of up to 15 files, starting with batch 1 and the most important files\. 21 existing files are left\./);
    const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(state.docsComplete, true);
    assert.ok(Object.values(state.files).every((e) => typeof e.summary === 'string' && e.level === null));
  });

  it('the next run adds batch 1, the most important files first, to the same pull request; then no second batch until it is merged', async () => {
    const second = await runMain(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '5' });
    assert.strictEqual(second.code, 0, second.stderr);
    let state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(state.pending.batch.number, 1);
    assert.strictEqual(state.pending.batch.files.length, 5);
    // The entry point, and the file it imports, come first.
    assert.deepStrictEqual(state.pending.batch.files.slice(0, 2), ['src/index.js', 'src/api/handler00.js']);
    assert.strictEqual(state.pending.docs, true);
    const lastRun = repo.file('docturnal/update', '.docturnal/last-run.md');
    assert.match(lastRun, /^# Docturnal: comments and documentation\n/);
    assert.match(lastRun, /- \*\*Comments:\*\* 5 of 21 files commented at the medium level\./);
    assert.match(lastRun, /- \*\*This pull request:\*\* documentation for the whole project and batch 1 of existing code, 5 files/);
    assert.match(lastRun, /- \*\*Next:\*\* batch 2 of existing code, after you merge or close this pull request\. 16 existing files are left\./);

    // The pull request still holds batch 1: a quiet night adds no second batch.
    const third = await runMain(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '5' });
    assert.match(third.log, /^Docturnal: nothing changed since the last run\.$/m);
    assert.doesNotMatch(third.log, /batch 2/);
    state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(state.pending.batch.number, 1);

    // After the merge, batch 2 follows, in a new pull request that holds only that batch.
    repo.merge();
    await runMain(repo, repo.clone(), mock, { INPUT_BACKLOG_BATCH_SIZE: '5' });
    state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(state.pending.batch.number, 2);
    assert.strictEqual(state.pending.docs, false);
    assert.strictEqual(Object.values(state.files).filter((e) => e.level === 'medium').length, 10);
  });

  it('with "Only new and changed code", a changed file is commented and no batch starts', async () => {
    repo.merge();
    repo.commit({ 'src/api/handler19.js': `${fn('handler19')}\nexport const LIMIT = 3;\n` });
    const result = await runMain(repo, repo.clone(), mock, { INPUT_EXISTING_CODE: 'none' });
    assert.strictEqual(result.code, 0, result.stderr);
    const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.deepStrictEqual(state.pending.changed, ['src/api/handler19.js']);
    assert.strictEqual(state.pending.batch, null);
    assert.match(repo.file('docturnal/update', '.docturnal/last-run.md'), /- \*\*Next:\*\* comments on new and changed code only\./);
  });
});

describe('a parallel run: plan, three workers, and finish', () => {
  const repo = gitRepo();
  let mock;
  const plan = () => path.join(repo.work, 'plan', 'plan.json');
  before(async () => {
    mock = await startMockOllama();
    const files = {};
    for (let i = 0; i < 45; i++) files[`src/m${String(i).padStart(2, '0')}.js`] = fn(`m${i}`);
    repo.commit(files, 'Initial commit');
  });
  after(async () => {
    await mock.close();
    fs.rmSync(repo.work, { recursive: true, force: true });
  });

  const modeEnv = (mode, extra = {}) => ({
    INPUT_MODE: mode,
    DOCTURNAL_PLAN: plan(),
    DOCTURNAL_RESULTS: path.join(repo.work, 'results'),
    INPUT_MAX_JOBS: '3',
    ...extra,
  });

  it('a failed worker: finish commits what the others did, and its files wait for the next run', async () => {
    const planned = await runMain(repo, repo.clone(), mock, { ...modeEnv('plan'), GITHUB_OUTPUT: path.join(repo.work, 'out-1') });
    assert.strictEqual(planned.code, 0, planned.stderr);
    assert.match(fs.readFileSync(path.join(repo.work, 'out-1'), 'utf8'), /^has-work=true\nshards=\[0,1,2\]\nmax-parallel=3\nbase=main\n$/);
    // Workers 0 and 1 finish; worker 2 fails before writing its results.
    for (const shard of [0, 1]) {
      const work = await runMain(repo, repo.clone(), mock, modeEnv('work', { INPUT_SHARD: String(shard) }));
      assert.strictEqual(work.code, 0, work.stderr);
    }
    const lost = JSON.parse(fs.readFileSync(plan(), 'utf8')).shards[2];
    const finish = await runMain(repo, repo.clone(), mock, modeEnv('finish'));
    assert.strictEqual(finish.code, 0, finish.stderr);
    assert.match(finish.log, new RegExp(`::warning::The work job for shard 2 did not finish, so its ${lost.length} files wait for the next run\\.`));
    const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(state.docsComplete, false);
    for (const file of lost) assert.strictEqual(state.files[file], undefined);
    assert.strictEqual(Object.keys(state.files).length, 45 - lost.length);
    assert.match(repo.file('docturnal/update', '.docturnal/last-run.md'), /its work job did not finish/);
    // The next tests start from a first run again.
    repo.git(repo.remote, 'update-ref', '-d', 'refs/heads/docturnal/update');
    fs.rmSync(path.join(repo.work, 'results'), { recursive: true, force: true });
  });

  it('results that lose one file or repeat another stop the finish from committing anything', async () => {
    await runMain(repo, repo.clone(), mock, { ...modeEnv('plan'), GITHUB_OUTPUT: path.join(repo.work, 'out-t') });
    for (const shard of [0, 1, 2]) await runMain(repo, repo.clone(), mock, modeEnv('work', { INPUT_SHARD: String(shard) }));
    // Shard 2 loses its first result, and shard 0 gets a copy of one of shard 1's.
    const file = (n) => path.join(repo.work, 'results', `shard-${n}.json`);
    const read = (n) => JSON.parse(fs.readFileSync(file(n), 'utf8'));
    const two = read(2);
    const lost = two.results.shift().path;
    fs.writeFileSync(file(2), JSON.stringify(two));
    const zero = read(0);
    const repeated = read(1).results[0];
    zero.results.push(repeated);
    fs.writeFileSync(file(0), JSON.stringify(zero));
    const finish = await runMain(repo, repo.clone(), mock, modeEnv('finish'));
    assert.notStrictEqual(finish.code, 0);
    assert.match(finish.stderr, new RegExp(`::error::The work results do not match the plan: 1 missing \\(${lost.replace('.', '\\.')}\\); 1 duplicated \\(${repeated.path.replace('.', '\\.')}\\)\\. Nothing was committed\\.`));
    assert.throws(() => repo.git(repo.remote, 'rev-parse', '--verify', 'refs/heads/docturnal/update'));
    fs.rmSync(path.join(repo.work, 'results'), { recursive: true, force: true });
  });

  it('three workers each read a third of the files, and the finish merges them with none lost or repeated', async () => {
    const planned = await runMain(repo, repo.clone(), mock, { ...modeEnv('plan'), GITHUB_OUTPUT: path.join(repo.work, 'out-2') });
    assert.strictEqual(planned.code, 0, planned.stderr);
    const shards = JSON.parse(fs.readFileSync(plan(), 'utf8')).shards;
    assert.deepStrictEqual(shards.map((s) => s.length), [15, 15, 15]);
    for (const shard of [0, 1, 2]) {
      const work = await runMain(repo, repo.clone(), mock, modeEnv('work', { INPUT_SHARD: String(shard) }));
      assert.strictEqual(work.code, 0, work.stderr);
      assert.match(work.log, new RegExp(`shard ${shard} of 3, 15 files`));
      // Workers never commit or push.
      assert.doesNotMatch(work.log, /committed|pushed/);
    }
    const finish = await runMain(repo, repo.clone(), mock, modeEnv('finish'));
    assert.strictEqual(finish.code, 0, finish.stderr);
    assert.match(finish.log, /pushed docturnal\/update/);
    const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
    assert.strictEqual(Object.keys(state.files).length, 45);
    assert.ok(Object.values(state.files).every((e) => typeof e.summary === 'string'));
    assert.strictEqual(state.docsComplete, true);
  });
});

describe('the time budget', () => {
  const repo = gitRepo();
  let mock;
  before(async () => {
    mock = await startMockOllama();
    const files = {};
    // One file in each folder, so each summary is one call.
    for (let i = 0; i < 6; i++) files[`src/m${i}/f${i}.js`] = fn(`f${i}`);
    repo.commit(files, 'Initial commit');
  });
  after(async () => {
    await mock.close();
    fs.rmSync(repo.work, { recursive: true, force: true });
  });

  it('stops starting work when the budget is nearly used, and commits what is finished', async () => {
    const { run } = require('../src/main');
    const cwd = repo.clone();
    // Each model call takes 10 simulated minutes; the budget is 60 minutes, and in the
    // documentation pass new summaries stop at 20, leaving 40 for the docs.
    let clock = Date.parse('2026-10-24T00:00:00Z');
    const chat = async (request) => {
      clock += 10 * 60000;
      const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
      return (await res.json()).message.content;
    };
    const logs = [];
    const result = await run({
      cwd,
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '60', INPUT_JOB_TIMEOUT_MINUTES: '70',
        INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model', PUSH: 'false' },
      chat,
      now: () => clock,
      log: (l) => logs.push(l),
    });
    // The budget's margin before the job's timeout is too small, and the log says so.
    assert.ok(logs.some((l) => /^::warning::time-budget-minutes \(60\) leaves less than 20 minutes before the job's timeout-minutes \(70\)/.test(l)));
    // Three folders were read before new work stopped; the other three wait for the next run.
    assert.strictEqual(result.leftOver.length, 3);
    assert.ok(result.leftOver.every((l) => l.reason === 'time budget'));
    assert.strictEqual(result.changed, true);
    const state = JSON.parse(execFileSync('git', ['show', 'HEAD:.docturnal/state.json'], { cwd, env: repo.gitEnv, encoding: 'utf8' }));
    assert.strictEqual(Object.values(state.files).filter((e) => typeof e.summary === 'string').length, 3);
    assert.strictEqual(state.docsComplete, false);
    assert.match(fs.readFileSync(path.join(cwd, '.docturnal/last-run.md'), 'utf8'), /- \*\*Documentation:\*\* in progress, 3 of 6 files read\. The rest follow on the next run\./);
  });
});

// --- Artifacts ---

test('the finish deletes the run\'s Docturnal artifacts, and only warns when it cannot', async () => {
  const { deleteRunArtifacts } = require('../src/artifacts');
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (!init.method) {
      return { ok: true, status: 200, json: async () => ({ artifacts: [{ id: 1, name: 'docturnal-plan' }, { id: 2, name: 'docturnal-shard-0' }, { id: 3, name: 'coverage-report' }] }) };
    }
    return { ok: true, status: 204 };
  };
  const logs = [];
  const env = { GITHUB_API_URL: 'https://ghe.example/api/v3', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42' };
  assert.strictEqual(await deleteRunArtifacts({ env, token: 't', fetchFn, log: (l) => logs.push(l) }), 2);
  assert.deepStrictEqual(calls, [
    'GET https://ghe.example/api/v3/repos/acme/app/actions/runs/42/artifacts?per_page=100',
    'DELETE https://ghe.example/api/v3/repos/acme/app/actions/artifacts/1',
    'DELETE https://ghe.example/api/v3/repos/acme/app/actions/artifacts/2',
  ]);
  assert.deepStrictEqual(logs, ['Docturnal: deleted 2 artifacts of this run']);

  // Without actions: write, GitHub refuses; the run is not failed for it.
  const refused = async () => ({ ok: false, status: 403 });
  const warnings = [];
  assert.strictEqual(await deleteRunArtifacts({ env, token: 't', fetchFn: refused, log: (l) => warnings.push(l) }), 0);
  assert.match(warnings[0], /^::warning::Docturnal could not delete this run's artifacts \(listing them returned 403\)\. They expire after one day\. Give the workflow "actions: write" permission/);
});

// --- States from before gradual coverage ---

describe('a state from before gradual coverage', () => {
  const { docsDone } = require('../src/plan');
  const { hashContent, readState } = require('../src/state');

  function legacyRepo(files, stateFiles) {
    const repo = gitRepo();
    const state = {
      version: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
      commentLevel: 'medium',
      files: Object.fromEntries(Object.entries(stateFiles).map(([p, text]) => [p, { hash: hashContent(Buffer.from(text)), summary: `About ${p}.`, symbols: [] }])),
      layers: [{ slug: 'core', name: 'Core', description: 'Everything.', files: Object.keys(stateFiles) }],
      docs: [],
      staleDocs: [],
    };
    repo.commit({ ...files, '.docturnal/state.json': `${JSON.stringify(state, null, 2)}\n` }, 'Earlier Docturnal runs');
    return repo;
  }

  it('reads its summarized files as commented at the level then, and its documentation as unknown', () => {
    const repo = legacyRepo({ 'src/a.js': fn('a') }, { 'src/a.js': fn('a') });
    try {
      const state = readState(repo.seed);
      assert.strictEqual(state.docsComplete, null);
      assert.strictEqual(state.files['src/a.js'].level, 'medium');
      assert.strictEqual(docsDone(state, [{ path: 'src/a.js', action: 'comment' }]), true);
      // A first run cut short left files without an entry: the documentation is not done.
      assert.strictEqual(docsDone(state, [{ path: 'src/a.js', action: 'comment' }, { path: 'src/b.js', action: 'comment' }]), false);
    } finally {
      fs.rmSync(repo.work, { recursive: true, force: true });
    }
  });

  it('a fully covered repository reads and comments nothing again, and then stays quiet', async () => {
    const mock = await startMockOllama();
    const repo = legacyRepo({ 'src/a.js': fn('a'), 'src/b.js': fn('b') }, { 'src/a.js': fn('a'), 'src/b.js': fn('b') });
    try {
      // The first run after the update sets up the README once, as for any state from before
      // README.md was shared; it reads no file and comments none.
      const first = await runMain(repo, repo.clone(), mock);
      assert.strictEqual(first.code, 0, first.stderr);
      assert.match(first.log, /^Docturnal: 0 new or changed files$/m);
      assert.ok(!mock.requests.some((r) => r.format && r.format.properties && (r.format.properties.comments || r.format.properties.summary)));
      const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
      assert.strictEqual(state.docsComplete, true);
      assert.strictEqual(state.pending.batch, null);
      repo.merge();
      mock.requests.length = 0;
      const second = await runMain(repo, repo.clone(), mock);
      assert.match(second.log, /^Docturnal: nothing changed since the last run\.$/m);
      assert.deepStrictEqual(mock.requests, []);
    } finally {
      await mock.close();
      fs.rmSync(repo.work, { recursive: true, force: true });
    }
  });

  it('a first run cut short finishes its documentation for the files it missed, without commenting them', async () => {
    const mock = await startMockOllama();
    const files = { 'src/a.js': fn('a') };
    for (let i = 0; i < 6; i++) files[`src/missed${i}.js`] = fn(`missed${i}`);
    const repo = legacyRepo(files, { 'src/a.js': fn('a') });
    try {
      const result = await runMain(repo, repo.clone(), mock);
      assert.strictEqual(result.code, 0, result.stderr);
      // The six missed files share a folder: one call reads them all.
      const summaries = mock.requests.filter((r) => r.messages[0].content.startsWith('You describe one folder'));
      assert.strictEqual(summaries.length, 1);
      assert.match(summaries[0].messages[1].content, /^Files in the folder src\./);
      assert.strictEqual((summaries[0].messages[1].content.match(/^- missed/gm) || []).length, 6);
      assert.ok(!mock.requests.some((r) => r.format && r.format.properties && r.format.properties.comments));
      const state = JSON.parse(repo.file('docturnal/update', '.docturnal/state.json'));
      assert.strictEqual(state.docsComplete, true);
      assert.strictEqual(state.files['src/a.js'].level, 'medium');
      assert.strictEqual(state.files['src/missed0.js'].level, null);
      for (let i = 0; i < 6; i++) assert.strictEqual(repo.file('docturnal/update', `src/missed${i}.js`), fn(`missed${i}`).trimEnd());
    } finally {
      await mock.close();
      fs.rmSync(repo.work, { recursive: true, force: true });
    }
  });
});
