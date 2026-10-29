'use strict';

// An unexpected error while working on one file, or on one document, skips only that file or
// document for this run. The log names the error, never code or comment text; the file keeps
// its old state, so the next run works on it again; the others are commented and committed,
// and last-run.md lists what was skipped.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const comments = require('../src/comments');
const docs = require('../src/docs');
const readme = require('../src/readme');
const ollama = require('../src/ollama');
const { describeInternal } = require('../src/internal-error');
const { startMockOllama } = require('./mock-ollama');
const { gitRepo } = require('./git-repo');
const { simulatedChat } = require('./speed-model');

// A module of exported functions with a magic number each, so every file gets targets.
function moduleText(name, extra = 0) {
  const out = [`// Handles the ${name} records.`, "'use strict';", ''];
  const names = [];
  for (let f = 0; f < 4 + extra; f++) {
    const fn = `${name}Step${f}`;
    names.push(fn);
    out.push(`function ${fn}(items, limit) {`, '  const kept = [];', '  for (const item of items) {', `    if (item.size > limit * ${f + 2}) continue;`, '    kept.push(item);', '  }', '  return kept;', '}', '');
  }
  out.push(`module.exports = { ${names.join(', ')} };`, '');
  return out.join('\n');
}
const FILES = ['src/a.js', 'src/b.js', 'src/c.js', 'lib/d.js', 'lib/e.js'];
const project = (extra = 0) => Object.fromEntries([
  ['package.json', JSON.stringify({ name: 'resilient', scripts: { test: 'node --test' } })],
  ...FILES.map((f) => [f, moduleText(path.posix.basename(f, '.js'), extra)]),
]);

// The run, loaded after `patches` replace module exports, as the modules that use them read
// them when they load. Each patch is [module, name, replacement(original)].
async function night(repo, mock, patches = []) {
  const restore = patches.map(([mod, name, replace]) => {
    const original = mod[name];
    mod[name] = replace(original);
    return () => { mod[name] = original; };
  });
  const fresh = ['../src/process', '../src/apply', '../src/main'].map((m) => require.resolve(m));
  for (const m of fresh) delete require.cache[m];
  try {
    const { run } = require('../src/main');
    const cwd = repo.clone();
    const sim = simulatedChat(mock);
    const logs = [];
    const result = await run({
      cwd,
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '90', INPUT_CONTEXT_TOKENS: '8192', INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' },
      chat: sim.chat,
      now: sim.now,
      log: (l) => logs.push(l),
    });
    const lastRun = fs.readFileSync(path.join(cwd, '.docturnal/last-run.md'), 'utf8');
    return { result, logs, lastRun };
  } finally {
    restore.forEach((r) => r());
    for (const m of fresh) delete require.cache[m];
  }
}

// Throws for one file's plan, from the given step on.
const throwingFor = (file, error) => (original) => (plan, ...rest) => {
  if (plan && plan.path === file) throw error;
  return original(plan, ...rest);
};

test('the log names an unexpected error without the text it read', () => {
  assert.strictEqual(describeInternal(new TypeError('function is not iterable (cannot read property Symbol(Symbol.iterator))')), 'TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))');
  assert.strictEqual(describeInternal(new SyntaxError('Unexpected token \'x\', "const secret = 1" is not valid JSON')), 'SyntaxError: Unexpected token ..., ... is not valid JSON');
  assert.strictEqual(describeInternal(new Error('first line\nsecond line with code')), 'Error: first line');
  assert.strictEqual(describeInternal('a string'), 'Error: a string');
});

test('a file that throws while it is worked on is skipped this run; the others are commented and committed', { timeout: 900000 }, async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(project(), 'A project');
    await night(repo, mock);
    repo.merge();
    repo.commit(project(1), 'Change every file');
    const before = JSON.parse(repo.text('main', '.docturnal/state.json'));
    // e.js throws while its targets are chosen, d.js in its request, b.js after its
    // requests, and c.js when it is finished.
    const { result, logs, lastRun } = await night(repo, mock, [
      [comments, 'planTargets', throwingFor('lib/e.js', new TypeError('Cannot convert undefined or null to object'))],
      [comments, 'settleProposals', throwingFor('src/b.js', new TypeError('function is not iterable'))],
      [comments, 'finishComments', throwingFor('src/c.js', new RangeError('Invalid array length'))],
      [comments, 'proposeNext', throwingFor('lib/d.js', new TypeError('Cannot read properties of undefined (reading \'line\')'))],
    ]);
    assert.strictEqual(result.changed, true);
    assert.ok(logs.includes('src/b.js: skipped this run, internal error (TypeError: function is not iterable)'), logs.join('\n'));
    assert.ok(logs.includes('src/c.js: skipped this run, internal error (RangeError: Invalid array length)'), logs.join('\n'));
    assert.ok(logs.includes('lib/d.js: skipped this run, internal error (TypeError: Cannot read properties of undefined (reading ...))'), logs.join('\n'));
    assert.ok(logs.includes('lib/e.js: skipped this run, internal error (TypeError: Cannot convert undefined or null to object)'), logs.join('\n'));
    // a.js is commented and committed; the others are as they were, with their old state.
    assert.deepStrictEqual(result.processed.map((p) => p.path), ['src/a.js']);
    assert.ok(result.processed[0].added > 0);
    assert.notStrictEqual(repo.text('docturnal/update', 'src/a.js'), project(1)['src/a.js']);
    const state = JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    for (const file of ['src/b.js', 'src/c.js', 'lib/d.js', 'lib/e.js']) {
      assert.strictEqual(repo.text('docturnal/update', file), project(1)[file], file);
      assert.strictEqual(state.files[file].hash, before.files[file].hash, file);
      assert.ok(lastRun.includes(`- \`${file}\`: skipped this run, internal error`), file);
    }
    assert.match(lastRun, /## Left for the next run/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('a file that throws after its result was recorded has only its skip as a result', async () => {
  const report = require('../src/report');
  const { emptyState } = require('../src/state');
  const { defaultHandler } = require('./mock-ollama');
  const os = require('node:os');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-internal-'));
  // The second file finished throws while its counts are logged, after its result is in.
  const original = report.proposalSummary;
  let finished = 0;
  report.proposalSummary = (stats, options) => {
    if (options && options.reasons && ++finished === 2) throw new TypeError('Cannot read properties of null');
    return original(stats, options);
  };
  const processPath = require.resolve('../src/process');
  delete require.cache[processPath];
  try {
    const { processItems } = require('../src/process');
    for (const file of ['x.js', 'y.js']) fs.writeFileSync(path.join(cwd, file), moduleText(file.slice(0, 1)));
    const handler = defaultHandler();
    const logs = [];
    const { results } = await processItems({
      cwd,
      items: ['x.js', 'y.js'].map((file) => ({ path: file, kind: 'comment', reason: 'changed' })),
      previous: emptyState(),
      config: { commentLevel: 'medium', contextTokens: 8192, timeBudgetMinutes: 90 },
      models: { comment: 'comment-model', docs: 'docs-model' },
      chat: async (request) => {
        const reply = handler(request);
        return typeof reply === 'string' ? reply : JSON.stringify(reply);
      },
      log: (line) => logs.push(line),
    });
    assert.deepStrictEqual(results.map((r) => [r.path, r.outcome]), [['x.js', 'commented'], ['y.js', 'left']]);
    assert.strictEqual(results[1].why, 'skipped this run, internal error');
    assert.ok(logs.includes('y.js: skipped this run, internal error (TypeError: Cannot read properties of null)'), logs.join('\n'));
  } finally {
    report.proposalSummary = original;
    delete require.cache[processPath];
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a document that throws while it is built is skipped this run; the other documents are written', async () => {
  const mock = await startMockOllama();
  try {
    const store = {
      'package.json': JSON.stringify({ name: 'shop' }),
      'src/api/orders.js': 'module.exports = { list() {} };\n',
      'src/api/users.js': 'module.exports = { find() {} };\n',
      'src/db/client.js': 'module.exports = { query() {} };\n',
      'src/db/pool.js': 'module.exports = { take() {} };\n',
    };
    let writing = false;
    // Reading a db file fails once the layer docs are being written.
    const readFile = (file) => {
      if (writing && file.startsWith('src/db/')) throw new Error('EIO: i/o error, read');
      return Object.hasOwn(store, file) ? store[file] : null;
    };
    const chat = (request) => {
      if (/^docs\//.test(request.label || '')) writing = true;
      return ollama.chat(request);
    };
    const files = Object.keys(store).filter((f) => f.startsWith('src/')).map((p) => ({ path: p, summary: `Handles ${path.posix.basename(p, '.js')}.`, symbols: [] }));
    const result = await docs.generateDocs({ files, allFiles: Object.keys(store), readFile, model: 'docs', host: mock.host, chat });
    const db = result.layers.find((l) => l.files.includes('src/db/client.js'));
    const dbPath = `docs/${docs.docName(db)}.md`;
    assert.ok(result.layers.length >= 2);
    assert.ok(!result.docs.some((d) => d.path === dbPath));
    assert.ok(result.docs.length >= 1);
    assert.deepStrictEqual(result.pending.filter((p) => p.path === dbPath).map((p) => p.reason), ['skipped this run, internal error']);
    assert.deepStrictEqual(result.internalErrors, [`${dbPath}: skipped this run, internal error (Error: EIO: i/o error, read)`]);
  } finally {
    await mock.close();
  }
});

test('when the docs or the README throw, the comments are still committed and the docs wait', { timeout: 900000 }, async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(project(), 'A project');
    await night(repo, mock);
    repo.merge();
    repo.commit(project(1), 'Change every file');
    const { result, logs, lastRun } = await night(repo, mock, [
      [docs, 'generateDocs', () => async () => { throw new TypeError('layers is not iterable'); }],
    ]);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.processed.length, FILES.length);
    assert.ok(logs.includes('Docturnal: the layer docs: skipped this run, internal error (TypeError: layers is not iterable)'), logs.join('\n'));
    assert.match(lastRun, /- `README\.md`: skipped this run, internal error/);
    // The layers stay as they were, and the docs the changes touch wait for the next run.
    const state = JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    const main = JSON.parse(repo.text('main', '.docturnal/state.json'));
    assert.deepStrictEqual(state.layers, main.layers);
    assert.ok(state.staleDocs.includes('README') && state.staleDocs.length > 1);

    // Only the README throws: the layer docs are written.
    repo.merge();
    repo.commit(project(2), 'Change every file again');
    const third = await night(repo, mock, [
      [readme, 'updateReadme', () => async () => { throw new RangeError('Maximum call stack size exceeded'); }],
    ]);
    assert.strictEqual(third.result.changed, true);
    assert.ok(third.logs.includes('README.md: skipped this run, internal error (RangeError: Maximum call stack size exceeded)'), third.logs.join('\n'));
    assert.ok(third.result.docs.updated.length > 0);
    assert.match(third.lastRun, /- `README\.md`: skipped this run, internal error/);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
