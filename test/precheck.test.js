'use strict';

// The pre-check against a real git remote: a full run with the mock Ollama server creates
// docturnal/update and the state, then each case changes the repo and runs the pre-check in
// a fresh clone, the way the nightly workflow would.

const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { promisify } = require('node:util');

const { startMockOllama } = require('./mock-ollama');

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-precheck-'));
const remote = path.join(work, 'remote.git');
const seed = path.join(work, 'seed');
// Keep the user's git config (signing, hooks, default branch) out of the test.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(work, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
let mock;
let clones = 0;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function clone() {
  const dir = path.join(work, `clone-${++clones}`);
  git(work, 'clone', '-q', remote, dir);
  return dir;
}

function pushSeed(message) {
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', message);
  git(seed, 'push', '-q', 'origin', 'main');
}

// Runs src/precheck.js in a fresh clone and returns its log and $GITHUB_OUTPUT values.
function precheck() {
  const cwd = clone();
  const output = path.join(work, `output-${clones}`);
  fs.writeFileSync(output, '');
  const log = execFileSync(process.execPath, [path.join(ROOT, 'src/precheck.js')], {
    cwd,
    // These cases cover new and changed code; the backlog of existing code has its own tests.
    env: { ...gitEnv, GITHUB_OUTPUT: output, INPUT_COMMENT_LEVEL: 'medium', INPUT_EXISTING_CODE: 'none' },
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
  return { cwd, log, outputs };
}

// Runs src/main.js the way action.yml does after the pre-check: same checkout, BASE_BRANCH set.
async function runMain(cwd, base) {
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'src/main.js')], {
    cwd,
    env: {
      ...gitEnv,
      BASE_BRANCH: base,
      OLLAMA_HOST: mock.host,
      INPUT_COMMENT_LEVEL: 'medium',
      INPUT_EXISTING_CODE: 'none',
      INPUT_SELECTED_COMMENT_MODEL: 'comment-model',
      INPUT_SELECTED_DOCS_MODEL: 'docs-model',
    },
  });
}

describe('pre-check', () => {
  before(async () => {
    mock = await startMockOllama();
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
    git(work, 'init', '-q', '--bare', '-b', 'main', remote);
    git(work, 'clone', '-q', remote, seed);
    fs.mkdirSync(path.join(seed, 'src/api'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'src/db'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'src/api/users.js'), 'export function getUser(db, id) {\n  return db.find(id);\n}\n');
    fs.writeFileSync(path.join(seed, 'src/api/orders.js'), 'export function listOrders(db) {\n  return db.all();\n}\n');
    fs.writeFileSync(path.join(seed, 'src/db/client.js'), 'export function connect(url) {\n  return { url };\n}\n');
    pushSeed('Initial commit');

    // The first run processes everything and pushes docturnal/update.
    const first = precheck();
    assert.strictEqual(first.outputs.changed, 'true');
    assert.match(first.log, /first run/);
    await runMain(first.cwd, first.outputs.base);
    assert.ok(git(remote, 'rev-parse', '--verify', 'refs/heads/docturnal/update'));
  });

  after(async () => {
    await mock?.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('skips an unchanged repo', () => {
    const result = precheck();
    assert.deepStrictEqual(result.outputs, { changed: 'false', base: 'main' });
    assert.strictEqual(result.log.trim(), 'No changes since the last run');
  });

  it('runs when a file is edited, and is quiet again after that run', async () => {
    fs.appendFileSync(path.join(seed, 'src/api/orders.js'), '\nexport function countOrders(db) {\n  return db.all().length;\n}\n');
    pushSeed('Add countOrders');
    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /1 file new or changed/);

    // main.js runs on the checkout the pre-check prepared.
    await runMain(result.cwd, result.outputs.base);
    assert.strictEqual(precheck().outputs.changed, 'false');
  });

  it('runs when a file is deleted', async () => {
    // Merge the Docturnal pull request first. Deleting a file that the open pull request
    // commented would conflict, and the run would start fresh from the base instead.
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    git(seed, 'push', '-q', 'origin', 'main');
    assert.strictEqual(precheck().outputs.changed, 'false');
    fs.rmSync(path.join(seed, 'src/db/client.js'));
    pushSeed('Remove the db client');
    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /1 file deleted/);
    await runMain(result.cwd, result.outputs.base);
    assert.strictEqual(precheck().outputs.changed, 'false');
  });

  it('runs when a person edits README.md, so their section gets polished', async () => {
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    git(seed, 'push', '-q', 'origin', 'main');
    assert.strictEqual(precheck().outputs.changed, 'false');
    fs.appendFileSync(path.join(seed, 'README.md'), '\n## Support\n\nOpen an issue on GitHub and we answer within two days.\n');
    pushSeed('Add a support section');
    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /README\.md changed/);
    await runMain(result.cwd, result.outputs.base);
    assert.strictEqual(precheck().outputs.changed, 'false');
  });

  it('starts fresh from the base when the app deleted docturnal/update after its pull request merged', async () => {
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    git(seed, 'push', '-q', 'origin', 'main');
    git(seed, 'push', '-q', 'origin', '--delete', 'docturnal/update');
    assert.throws(() => git(remote, 'rev-parse', '--verify', 'refs/heads/docturnal/update'));
    // The merged state on the base means nothing is left to do.
    assert.strictEqual(precheck().outputs.changed, 'false');

    fs.appendFileSync(path.join(seed, 'src/api/users.js'), '\nexport function renameUser(db, id, name) {\n  return db.update(id, { name });\n}\n');
    pushSeed('Add renameUser');
    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /1 file new or changed/);
    await runMain(result.cwd, result.outputs.base);
    // The branch is created again from the base, with only the new change on top.
    const commits = git(remote, 'rev-list', '--count', 'main..docturnal/update');
    assert.strictEqual(commits, '1');
    assert.strictEqual(git(remote, 'merge-base', 'main', 'docturnal/update'), git(remote, 'rev-parse', 'main'));
    assert.strictEqual(precheck().outputs.changed, 'false');
  });

  it('does not add to docturnal/update while it has a commit from someone else', () => {
    const cwd = clone();
    git(cwd, 'checkout', '-q', 'docturnal/update');
    fs.appendFileSync(path.join(cwd, 'README.md'), '\nA reviewer note.\n');
    git(cwd, 'commit', '-qam', 'A reviewer edits the pull request');
    git(cwd, 'push', '-q', 'origin', 'docturnal/update');
    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'false');
    assert.match(result.log, /^docturnal\/update has commits from someone other than Docturnal, so Docturnal does not add to it until its pull request is merged or closed\.$/m);
  });

  it('runs when a generated doc is missing', () => {
    // The pull request, with the reviewer's commit, is merged; then someone deletes a doc.
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    const docs = fs.readdirSync(path.join(seed, 'docs')).filter((name) => name !== 'README.md');
    assert.ok(docs.length > 0);
    git(seed, 'rm', '-q', `docs/${docs[0]}`);
    pushSeed('Remove a generated doc');

    const result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /a generated doc is missing/);
  });

  it('reads .docturnalignore: a change to it runs, and ignored files are left alone after that', async () => {
    // Settle the doc removed by the previous case first.
    let result = precheck();
    if (result.outputs.changed === 'true') await runMain(result.cwd, result.outputs.base);
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    git(seed, 'push', '-q', 'origin', 'main');
    assert.strictEqual(precheck().outputs.changed, 'false');

    fs.writeFileSync(path.join(seed, '.docturnalignore'), 'src/api/orders.js\n');
    pushSeed('Ignore orders.js');
    result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /1 file deleted/);
    assert.match(result.log, /\.docturnalignore changed/);
    await runMain(result.cwd, result.outputs.base);
    const state = JSON.parse(git(remote, 'show', 'docturnal/update:.docturnal/state.json'));
    assert.ok(!('src/api/orders.js' in state.files));
    assert.match(state.ignoreHash, /^sha256-/);
    assert.strictEqual(precheck().outputs.changed, 'false');

    // An edit to an ignored file is not a change.
    git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
    fs.appendFileSync(path.join(seed, 'src/api/orders.js'), '\nexport const LIMIT = 10;\n');
    pushSeed('Edit an ignored file');
    assert.strictEqual(precheck().outputs.changed, 'false');

    // A comment added to .docturnalignore is.
    fs.writeFileSync(path.join(seed, '.docturnalignore'), '# Orders are generated.\nsrc/api/orders.js\n');
    pushSeed('Explain the ignore');
    result = precheck();
    assert.strictEqual(result.outputs.changed, 'true');
    assert.match(result.log, /^Docturnal: \.docturnalignore changed \(/);
    await runMain(result.cwd, result.outputs.base);
    assert.strictEqual(precheck().outputs.changed, 'false');
  });

  it('loads nothing from node_modules, so it can run before npm install', () => {
    const loaded = execFileSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(ROOT, 'src/precheck.js'))});
      console.log(Object.keys(require.cache).filter((file) => file.includes('node_modules')).length);
    `], { encoding: 'utf8' });
    assert.strictEqual(loaded.trim(), '0');
  });
});
