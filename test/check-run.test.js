'use strict';

// The accuracy check inside a real run of src/main.js against a local git remote: the docs
// model is loaded first, a check that fails with it is retried with the comment model, and
// a file whose check fails with both is deferred and says so.

const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { promisify } = require('node:util');

const { defaultHandler, kindOf, startMockOllama } = require('./mock-ollama');

const ROOT = path.join(__dirname, '..');
const PAYROLL = fs.readFileSync(path.join(__dirname, 'fixtures/payroll.js'), 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-check-'));
const remote = path.join(work, 'remote.git');
const seed = path.join(work, 'seed');
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(work, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
let clones = 0;
let mock;
// Set per test: how the mock answers each accuracy check, and proposals it adds to each
// comments request.
let onCheck = () => undefined;
let addComments = () => [];
const fallback = defaultHandler();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function dropConnection() {
  return Object.assign(new Error('dropped'), { dropConnection: true });
}

// Runs src/main.js in a fresh clone, as the workflow would, and returns its log.
async function runMain() {
  const cwd = path.join(work, `clone-${++clones}`);
  git(work, 'clone', '-q', remote, cwd);
  mock.requests.length = 0;
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'src/main.js')], {
    cwd,
    env: {
      ...gitEnv,
      BASE_BRANCH: 'main',
      OLLAMA_HOST: mock.host,
      INPUT_COMMENT_LEVEL: 'medium',
      INPUT_SELECTED_COMMENT_MODEL: 'comment-model',
      INPUT_SELECTED_DOCS_MODEL: 'docs-model',
    },
  });
  return { cwd, log: stdout };
}

function editPayroll(line) {
  fs.appendFileSync(path.join(seed, 'src/payroll.js'), `\n${line}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'Edit payroll');
  git(seed, 'push', '-q', 'origin', 'main');
}

describe('the accuracy check in a run', () => {
  before(async () => {
    mock = await startMockOllama((body, index) => {
      if (kindOf(body) === 'accuracy') {
        const answer = onCheck(body);
        if (answer instanceof Error) throw answer;
      }
      const reply = fallback(body, index);
      if (kindOf(body) === 'comments') reply.comments.push(...addComments(body));
      return reply;
    });
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
    git(work, 'init', '-q', '--bare', '-b', 'main', remote);
    git(work, 'clone', '-q', remote, seed);
    fs.mkdirSync(path.join(seed, 'src'));
    fs.writeFileSync(path.join(seed, 'src/payroll.js'), PAYROLL);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Initial commit');
    git(seed, 'push', '-q', 'origin', 'main');
  });

  after(async () => {
    await mock?.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('loads the docs model before the check, then checks with it', async () => {
    onCheck = () => undefined;
    // The first run documents the project and comments nothing.
    const first = await runMain();
    assert.deepStrictEqual([...new Set(mock.requests.map(kindOf))].filter((k) => k === 'comments' || k === 'accuracy'), []);
    assert.match(first.log, /^Ollama: summary of src, 1 file with comment-model, \d+\.\d s$/m);
    // The next run comments the first batch of existing code, and checks it.
    const { log } = await runMain();
    const kinds = mock.requests.map((r) => `${kindOf(r)} ${r.model}`);
    const load = kinds.indexOf('load docs-model');
    assert.ok(load > kinds.lastIndexOf('comments comment-model'), kinds.join(', '));
    assert.ok(load < kinds.indexOf('accuracy docs-model'), kinds.join(', '));
    const loadRequest = mock.requests[load];
    assert.strictEqual(loadRequest.keep_alive, '30m');
    assert.strictEqual(loadRequest.options.num_ctx, mock.requests.find((r) => kindOf(r) === 'accuracy').options.num_ctx);
    // Each call is logged with its model and duration, and never with code.
    assert.match(log, /^Ollama: comments for src\/payroll\.js, lines 1 to \d+ with comment-model, \d+\.\d s$/m);
    assert.match(log, /^Ollama: loading docs-model with docs-model, \d+\.\d s$/m);
    assert.match(log, /^Ollama: accuracy check for src\/payroll\.js with docs-model, \d+\.\d s$/m);
    assert.ok(!log.includes('OVERTIME_MULTIPLIER'));
  });

  it('retries a check that fails with the docs model once with the comment model', async () => {
    editPayroll('const BONUS_RATE = 0.05;');
    onCheck = (body) => (body.model === 'docs-model' ? dropConnection() : undefined);
    const { log } = await runMain();
    // The docs model fails on the first batch; the comment model then checks every batch.
    const checks = mock.requests.filter((r) => kindOf(r) === 'accuracy').map((r) => r.model);
    assert.strictEqual(checks[0], 'docs-model');
    assert.ok(checks.length >= 2 && checks.slice(1).every((model) => model === 'comment-model'), checks.join(', '));
    assert.match(log, /^src\/payroll\.js: the accuracy check with docs-model failed \(socket hang up; code ECONNRESET\)$/m);
    assert.match(log, /^Ollama: accuracy check for src\/payroll\.js(?: \(1 of \d+\))? with docs-model failed after \d+\.\d s: socket hang up; code ECONNRESET$/m);
    assert.doesNotMatch(log, /deferred/);
    assert.match(log, /committed [0-9a-f]{7} and pushed docturnal\/update/);
  });

  it('defers a file whose check fails with both models, and says so', async () => {
    // Merge the open pull request, so the next run starts from a clean base.
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    git(seed, 'push', '-q', 'origin', 'main');
    editPayroll('const HOLIDAY_RATE = 2;');
    const before = git(remote, 'rev-parse', 'refs/heads/docturnal/update');
    onCheck = () => dropConnection();
    const { cwd, log } = await runMain();
    assert.deepStrictEqual(mock.requests.filter((r) => kindOf(r) === 'accuracy').map((r) => r.model), ['docs-model', 'comment-model']);
    assert.match(log, /^src\/payroll\.js: deferred to the next run, accuracy check failed$/m);
    assert.doesNotMatch(log, /nothing changed since the last run/);
    assert.match(log, /^Docturnal: nothing to commit this run; 1 file was deferred to the next run\.$/m);
    assert.strictEqual(git(remote, 'rev-parse', 'refs/heads/docturnal/update'), before);
    assert.match(fs.readFileSync(path.join(cwd, 'src/payroll.js'), 'utf8'), /const HOLIDAY_RATE = 2;\n$/);
  });

  it('logs the coverage score of each comment dropped as a restatement, never its text', async () => {
    onCheck = () => undefined;
    const sumHours = '  for (const day of days) total += day.hours;';
    fs.appendFileSync(path.join(seed, 'src/payroll.js'), `\nfunction sumHours(days) {\n  let total = 0;\n${sumHours}\n  return total;\n}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Add sumHours');
    git(seed, 'push', '-q', 'origin', 'main');
    let line;
    addComments = (body) => {
      const match = body.messages[1].content.match(/^(\d+)\|   for \(const day of days\) total \+= day\.hours;$/m);
      if (!match) return [];
      line = Number(match[1]);
      return [{ line, anchor: sumHours.trim(), text: "Adds each day's hours to the total.", kind: 'line' }];
    };
    try {
      const { log } = await runMain();
      assert.ok(line > 0);
      assert.match(log, new RegExp(`^src/payroll\\.js: line ${line} dropped as restating the code \\(coverage 1\\.00\\)$`, 'm'));
      assert.ok(!log.includes("Adds each day's hours"));
      assert.match(log, /restates the code \(restates the code \(word match\): 1\)/);
    } finally {
      addComments = () => [];
    }
  });

  it('skips a file with syntax errors and says so in the log and in last-run.md', async () => {
    onCheck = () => undefined;
    const broken = 'export function payStub(entry) {\n  return grossPay(entry.hours, entry.rate;\n}\n';
    fs.writeFileSync(path.join(seed, 'src/stub.js'), broken);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Add a broken file');
    git(seed, 'push', '-q', 'origin', 'main');
    const { log } = await runMain();
    assert.match(log, /^src\/stub\.js: skipped, the file has syntax errors$/m);
    assert.ok(!mock.requests.some((r) => (r.messages || []).some((m) => m.content.includes('File: src/stub.js'))));
    const lastRun = git(remote, 'show', 'docturnal/update:.docturnal/last-run.md');
    assert.match(lastRun, /## Files skipped\n\n- `src\/stub\.js`: skipped, the file has syntax errors\n/);
    assert.strictEqual(git(remote, 'show', 'docturnal/update:src/stub.js') + '\n', broken);
  });
});
