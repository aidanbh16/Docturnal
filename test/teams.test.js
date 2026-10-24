'use strict';

// Docturnal for teams: the pull request from the Action (open-pr), an Ollama server of your
// own (ollama-url) with its address check, and the default mode left as it was.

const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it, test } = require('node:test');
const { promisify } = require('node:util');

const { selectModels } = require('../src/models');
const ollama = require('../src/ollama');
const { openOrUpdatePullRequest, pullRequestBody } = require('../src/pulls');
const { checkServer } = require('../src/server');
const { startMockGitHubApi } = require('./mock-github-api');
const { startMockOllama } = require('./mock-ollama');

const ROOT = path.join(__dirname, '..');

// A resolver for tests: names ending in .internal.test are private (127.0.0.1, where the mock
// listens), names ending in .public.test resolve to a public address.
function resolver(lookups = []) {
  return (hostname, options, callback) => {
    lookups.push(hostname);
    if (hostname.endsWith('.internal.test')) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    if (hostname.endsWith('.mixed.test')) return callback(null, [{ address: '10.0.0.5', family: 4 }, { address: '93.184.216.34', family: 4 }]);
    if (hostname.endsWith('.public.test')) return callback(null, [{ address: '93.184.216.34', family: 4 }]);
    return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  };
}

// --- open-pr ---

function lastRunDir(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-pr-'));
  fs.mkdirSync(path.join(dir, '.docturnal'));
  fs.writeFileSync(path.join(dir, '.docturnal/last-run.md'), text);
  return dir;
}

test('open-pr opens the pull request the first time and updates it the second time, with no settings link', async () => {
  const api = await startMockGitHubApi();
  const root = lastRunDir('# Docturnal update\n\nThis pull request adds 3 comments to 1 file.\n');
  const env = { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'acme/payroll' };
  try {
    const first = await openOrUpdatePullRequest({ root, base: 'main', token: 'test-token', env });
    assert.deepStrictEqual(first, { number: 1, action: 'opened' });
    assert.deepStrictEqual(api.state.pulls[0], {
      repo: 'acme/payroll', number: 1, state: 'open', title: 'Docturnal: comments and documentation', head: 'docturnal/update', base: 'main',
      body: '# Docturnal update\n\nThis pull request adds 3 comments to 1 file.\n',
    });
    assert.doesNotMatch(api.state.pulls[0].body, /Change Docturnal settings|setup\?installation_id/);

    fs.writeFileSync(path.join(root, '.docturnal/last-run.md'), '# Docturnal update\n\nThis pull request adds 5 comments to 2 files.\n');
    const second = await openOrUpdatePullRequest({ root, base: 'main', token: 'test-token', env });
    assert.deepStrictEqual(second, { number: 1, action: 'updated' });
    assert.strictEqual(api.state.pulls.length, 1);
    assert.match(api.state.pulls[0].body, /5 comments to 2 files/);
    assert.deepStrictEqual(api.state.requests.map((r) => `${r.method} ${r.path}${r.query}`), [
      'GET /repos/acme/payroll/pulls?state=open&head=acme%3Adocturnal%2Fupdate',
      'POST /repos/acme/payroll/pulls',
      'GET /repos/acme/payroll/pulls?state=open&head=acme%3Adocturnal%2Fupdate',
      'PATCH /repos/acme/payroll/pulls/1',
    ]);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the 403 for pull requests from GitHub Actions names the setting to turn on', async () => {
  for (const [refuse, expected] of [
    ['actions', /^Docturnal pushed docturnal\/update, but GitHub Actions is not allowed to create pull requests in acme\/payroll\. Turn on "Allow GitHub Actions to create and approve pull requests" in the repository's Settings > Actions > General > Workflow permissions; if it is greyed out, turn it on first in the acme organization's Settings > Actions > General\.$/],
    ['permissions', /^Docturnal pushed docturnal\/update, but the token cannot open pull requests in acme\/payroll\. Add "pull-requests: write" to the permissions in the workflow file\.$/],
  ]) {
    const api = await startMockGitHubApi({ refuse });
    const root = lastRunDir('# Docturnal update\n');
    try {
      await assert.rejects(
        openOrUpdatePullRequest({ root, base: 'main', token: 'test-token', env: { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'acme/payroll' } }),
        (err) => {
          assert.match(err.message, expected);
          assert.ok(!err.message.includes('\n'));
          return true;
        }
      );
    } finally {
      await api.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('GITHUB_API_URL is respected, as on GitHub Enterprise Server, and only GitHub.com gets the API version header', async () => {
  const api = await startMockGitHubApi({ prefix: '/api/v3' });
  const root = lastRunDir('# Docturnal update\n');
  try {
    await openOrUpdatePullRequest({ root, base: 'develop', token: 'test-token', env: { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'corp/billing' } });
    assert.ok(api.state.requests.every((r) => r.path.startsWith('/api/v3/repos/corp/billing/pulls')));
    assert.strictEqual(api.state.pulls[0].base, 'develop');
    assert.ok(api.state.requests.every((r) => !('x-github-api-version' in r.headers)));
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // GitHub.com: the same version header the app sends.
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, version: init.headers['x-github-api-version'] });
    return { ok: true, status: 200, text: async () => (init.method === 'GET' ? '[]' : '{"number":9}') };
  };
  const root2 = lastRunDir('x');
  await openOrUpdatePullRequest({ root: root2, base: 'main', token: 't', env: { GITHUB_REPOSITORY: 'a/b' }, fetchFn });
  fs.rmSync(root2, { recursive: true, force: true });
  assert.deepStrictEqual(seen.map((s) => s.url.split('?')[0]), ['https://api.github.com/repos/a/b/pulls', 'https://api.github.com/repos/a/b/pulls']);
  assert.ok(seen.every((s) => s.version === '2026-03-10'));
});

test('a long last-run.md is shortened to fit a pull request body', () => {
  const root = lastRunDir('x'.repeat(70000));
  try {
    const body = pullRequestBody(root);
    assert.ok(body.length < 65536);
    assert.match(body, /The rest of this description is in `\.docturnal\/last-run\.md`\.$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- ollama-url ---

test('model selection with ollama-url skips the runner memory and uses the model inputs', () => {
  const external = selectModels({ totalMemoryBytes: 2 * 1024 ** 3, model: 'qwen2.5-coder:14b', docsModel: 'qwen2.5-coder:32b', ollamaUrl: 'http://ollama.internal:11434' });
  assert.deepStrictEqual(external, { ramGib: null, commentModel: 'qwen2.5-coder:14b', docsModel: 'qwen2.5-coder:32b', docsMayFallback: false, fallbackDocsModel: 'qwen2.5-coder:3b' });
  // With "auto", the usual models, and no fallback for a small runner, since the server runs them.
  const auto = selectModels({ totalMemoryBytes: 2 * 1024 ** 3, model: 'auto', docsModel: 'auto', ollamaUrl: 'http://ollama.internal:11434' });
  assert.strictEqual(auto.docsMayFallback, false);
  assert.strictEqual(auto.docsModel, 'qwen2.5-coder:7b');
  // The default mode still reads the memory.
  assert.strictEqual(selectModels({ totalMemoryBytes: 8 * 1024 ** 3, model: 'auto', docsModel: 'auto' }).docsMayFallback, true);

  const out = path.join(os.tmpdir(), `docturnal-models-${process.pid}`);
  fs.writeFileSync(out, '');
  const log = execFileSync(process.execPath, [path.join(ROOT, 'src/models.js')], {
    env: { ...process.env, GITHUB_OUTPUT: out, INPUT_OLLAMA_URL: 'http://ollama.internal:11434', INPUT_MODEL: 'llama3.1:70b', INPUT_DOCS_MODEL: 'auto' },
    encoding: 'utf8',
  });
  assert.strictEqual(log.trim(), 'Docturnal: Ollama server from ollama-url, comment model llama3.1:70b, docs model qwen2.5-coder:7b');
  assert.match(fs.readFileSync(out, 'utf8'), /^comment-model=llama3\.1:70b\ndocs-model=qwen2\.5-coder:7b\ndocs-may-fallback=false\nfallback-docs-model=qwen2\.5-coder:3b\nram-gib=\n$/);
  fs.rmSync(out);
});

test('private and loopback addresses are allowed; public ones are not', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.4.20', '100.64.0.1', '100.127.255.254', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.ok(ollama.isPrivateAddress(a), a);
  }
  for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '11.0.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '0.0.0.0', 'not-an-ip']) {
    assert.ok(!ollama.isPrivateAddress(a), a);
  }
});

test('the default mode still refuses any Ollama host that is not loopback', () => {
  assert.throws(() => ollama.baseUrl('10.0.0.5:11434', {}), /Refusing to use Ollama at 10\.0\.0\.5/);
  assert.throws(() => ollama.baseUrl('ollama.internal.test:11434', {}), /Refusing/);
  assert.strictEqual(ollama.baseUrl('127.0.0.1:11434', {}), 'http://127.0.0.1:11434');
  // With ollama-url, only that one server is added.
  const env = { INPUT_OLLAMA_URL: 'https://ai.internal.test/ollama/' };
  assert.strictEqual(ollama.baseUrl('https://ai.internal.test/ollama/', env), 'https://ai.internal.test/ollama');
  assert.throws(() => ollama.baseUrl('https://other.internal.test', env), /Refusing/);
});

describe('the Ollama server in ollama-url', () => {
  let mock;
  before(async () => {
    mock = await startMockOllama(undefined, { models: ['qwen2.5-coder:3b', 'qwen2.5-coder:7b'] });
  });
  after(() => mock.close());

  const envFor = (host, extra = {}) => ({ INPUT_OLLAMA_URL: `http://${host}:${mock.port}`, ...extra });

  it('is checked, logged with its address, and used when it resolves to a private address', async () => {
    const logs = [];
    const lookups = [];
    const env = envFor('gpu.internal.test');
    const result = await checkServer({ env, models: ['qwen2.5-coder:3b', 'qwen2.5-coder:7b'], log: (l) => logs.push(l), resolve: resolver(lookups) });
    assert.deepStrictEqual(result.pulled, []);
    assert.deepStrictEqual(logs, ['Docturnal: Ollama server gpu.internal.test at 127.0.0.1']);

    // Every connection resolves and checks the name again.
    const before = lookups.length;
    const reply = await ollama.chat({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'File: a.js\n1| const a = 1;' }],
      format: { type: 'object', properties: { comments: {} } },
      host: env.INPUT_OLLAMA_URL,
      env,
      resolve: resolver(lookups),
    });
    assert.ok(reply.length > 0);
    assert.ok(lookups.length > before);
  });

  it('refuses a host that resolves to a public address, even partly, unless allow-public-ollama is "true"', async () => {
    for (const host of ['gpu.public.test', 'gpu.mixed.test']) {
      await assert.rejects(checkServer({ env: envFor(host), models: [], log: () => {}, resolve: resolver() }),
        /resolves to the public address 93\.184\.216\.34\. Docturnal sends your source code to this server, so it only uses servers on loopback or private addresses\. Point ollama-url at a server inside your network, or set allow-public-ollama to "true"/);
    }
    // A public IP address is refused before any connection.
    await assert.rejects(ollama.chat({ model: 'm', messages: [], host: 'http://93.184.216.34:9', env: { INPUT_OLLAMA_URL: 'http://93.184.216.34:9' } }), /public address 93\.184\.216\.34/);
    // Allowed on purpose: the address check passes, and the log says allow-public-ollama is on.
    const allowed = await ollama.checkHost('gpu.public.test', { allowPublic: true, resolve: resolver() });
    assert.deepStrictEqual(allowed.map((a) => a.address), ['93.184.216.34']);
    // (The server check itself runs against the local mock, so the test never leaves this machine.)
    const logs = [];
    await checkServer({ env: envFor('gpu.internal.test', { INPUT_ALLOW_PUBLIC_OLLAMA: 'true' }), models: [], log: (l) => logs.push(l), resolve: resolver() });
    assert.deepStrictEqual(logs, ['Docturnal: Ollama server gpu.internal.test at 127.0.0.1 (allow-public-ollama is on)']);
  });

  it('a public answer at connection time is refused, even after an earlier check passed', async () => {
    let calls = 0;
    // The first answer is private; the next ones are public, as with DNS rebinding.
    const flipping = (hostname, options, callback) => callback(null, [{ address: calls++ === 0 ? '127.0.0.1' : '93.184.216.34', family: 4 }]);
    const env = envFor('flip.internal.test');
    await ollama.checkHost('flip.internal.test', { resolve: flipping });
    await assert.rejects(ollama.chat({ model: 'm', messages: [{ role: 'user', content: 'CODE' }], host: env.INPUT_OLLAMA_URL, env, resolve: flipping }), /public address 93\.184\.216\.34/);
  });

  it('an unreachable server fails with one clear line', async () => {
    const closed = await startMockOllama();
    const port = closed.port;
    await closed.close();
    await assert.rejects(checkServer({ env: { INPUT_OLLAMA_URL: `http://127.0.0.1:${port}` }, models: ['m'], log: () => {} }), (err) => {
      assert.match(err.message, new RegExp(`^Docturnal cannot reach the Ollama server at http://127\\.0\\.0\\.1:${port} \\(.*ECONNREFUSED.*\\)\\. Check ollama-url, and that the server is running and reachable from this runner\\.$`));
      return true;
    });
    await assert.rejects(checkServer({ env: { INPUT_OLLAMA_URL: 'http://nowhere.example.test:11434' }, models: [], log: () => {}, resolve: resolver() }),
      /^Error: Docturnal cannot resolve the Ollama server nowhere\.example\.test from ollama-url\. Check the address and this runner's DNS\.$/);
  });

  it('pull-models "false" with a missing model fails and names it; "true" has the server pull it', async () => {
    await assert.rejects(checkServer({ env: envFor('gpu.internal.test', { INPUT_PULL_MODELS: 'false' }), models: ['qwen2.5-coder:3b', 'qwen2.5-coder:32b'], log: () => {}, resolve: resolver() }),
      new RegExp(`The Ollama server at http://gpu\\.internal\\.test:${mock.port} does not have the model qwen2\\.5-coder:32b, and pull-models is "false"\\. Run "ollama pull qwen2\\.5-coder:32b" on the server, or set pull-models to "true"\\.`));
    assert.deepStrictEqual(mock.pulls, []);

    const logs = [];
    const result = await checkServer({ env: envFor('gpu.internal.test'), models: ['qwen2.5-coder:3b', 'qwen2.5-coder:32b'], log: (l) => logs.push(l), resolve: resolver() });
    assert.deepStrictEqual(result.pulled, ['qwen2.5-coder:32b']);
    assert.deepStrictEqual(mock.pulls, ['qwen2.5-coder:32b']);
    assert.ok(logs.includes('Docturnal: qwen2.5-coder:32b: success'));
    // Progress updates are not logged one by one.
    assert.strictEqual(logs.filter((l) => l.includes('downloading')).length, 0);

    await assert.rejects(checkServer({ env: envFor('gpu.internal.test'), models: ['missing-on-registry:1b'], log: () => {}, resolve: resolver() }),
      /could not pull missing-on-registry:1b \(Ollama \/api\/pull failed: pull model manifest: file does not exist\)/);
  });

  it('a model listed as name:latest counts for its bare name', async () => {
    mock.models.push('llama3:latest');
    const result = await checkServer({ env: envFor('gpu.internal.test', { INPUT_PULL_MODELS: 'false' }), models: ['llama3'], log: () => {}, resolve: resolver() });
    assert.deepStrictEqual(result.pulled, []);
  });
});

// --- Whole runs of main.js against a local git remote ---

describe('open-pr in a run', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-teams-'));
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
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let mock;
  let api;
  let clones = 0;

  async function runMain(extra) {
    const cwd = path.join(work, `clone-${++clones}`);
    git(work, 'clone', '-q', remote, cwd);
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'src/main.js')], {
        cwd,
        env: {
          ...gitEnv,
          BASE_BRANCH: 'main',
          OLLAMA_HOST: mock.host,
          INPUT_COMMENT_LEVEL: 'medium',
          INPUT_SELECTED_COMMENT_MODEL: 'comment-model',
          INPUT_SELECTED_DOCS_MODEL: 'docs-model',
          GITHUB_API_URL: api.url,
          GITHUB_REPOSITORY: 'acme/payroll',
          INPUT_GITHUB_TOKEN: 'test-token',
          ...extra,
        },
      });
      return { log: stdout, code: 0 };
    } catch (err) {
      return { log: err.stdout, stderr: err.stderr, code: err.code };
    }
  }

  function commit(file, text) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', `Change ${file}`);
    git(seed, 'push', '-q', 'origin', 'main');
  }

  before(async () => {
    mock = await startMockOllama();
    api = await startMockGitHubApi();
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
    git(work, 'init', '-q', '--bare', '-b', 'main', remote);
    git(work, 'clone', '-q', remote, seed);
    commit('src/pay.js', 'export function pay(hours, rate) {\n  return hours * rate;\n}\n');
  });

  after(async () => {
    await mock?.close();
    await api?.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('the default mode never calls the pull request API', async () => {
    const { log, code } = await runMain({});
    assert.strictEqual(code, 0);
    assert.match(log, /pushed docturnal\/update/);
    assert.doesNotMatch(log, /pull request #/);
    assert.deepStrictEqual(api.state.requests, []);
    const explicit = await runMain({ INPUT_OPEN_PR: 'false' });
    assert.strictEqual(explicit.code, 0);
    assert.deepStrictEqual(api.state.requests, []);
  });

  it('open-pr "true" opens the pull request with last-run.md as its body, then updates it', async () => {
    commit('src/tax.js', 'export function tax(gross) {\n  return gross * 0.2;\n}\n');
    const first = await runMain({ INPUT_OPEN_PR: 'true' });
    assert.strictEqual(first.code, 0, first.stderr);
    assert.match(first.log, /^Docturnal: opened pull request #1$/m);
    const lastRun = git(remote, 'show', 'docturnal/update:.docturnal/last-run.md');
    assert.strictEqual(api.state.pulls[0].body.trim(), lastRun.trim());
    assert.strictEqual(api.state.pulls[0].base, 'main');

    commit('src/net.js', 'export function net(gross, tax) {\n  return gross - tax;\n}\n');
    const second = await runMain({ INPUT_OPEN_PR: 'true' });
    assert.strictEqual(second.code, 0, second.stderr);
    assert.match(second.log, /^Docturnal: updated pull request #1$/m);
    assert.strictEqual(api.state.pulls.length, 1);
    assert.match(api.state.pulls[0].body, /src\/net\.js/);
  });

  it('a refused pull request fails the run with one clear line, and the pushed branch stays', async () => {
    const refusing = await startMockGitHubApi({ refuse: 'actions' });
    try {
      commit('src/bonus.js', 'export function bonus(pay) {\n  return pay * 0.1;\n}\n');
      api.state.pulls.forEach((p) => {
        p.state = 'closed';
      });
      const result = await runMain({ INPUT_OPEN_PR: 'true', GITHUB_API_URL: refusing.url });
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /^::error::Docturnal pushed docturnal\/update, but GitHub Actions is not allowed to create pull requests in acme\/payroll\. Turn on "Allow GitHub Actions to create and approve pull requests"/m);
      assert.strictEqual(result.stderr.trim().split('\n').length, 1);
      assert.match(git(remote, 'show', 'docturnal/update:src/bonus.js'), /export function bonus/);
    } finally {
      await refusing.close();
    }
  });
});
