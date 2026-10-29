'use strict';

// Nightly runs after the documentation pass, with model time simulated at the speeds
// calibrated from a real runner (see speed-model.js). A night with many changed files spends
// its budget on comments first: proposals and their checks, then the docs the changes touch,
// and the files and docs it does not reach wait for the next run. A night with only a batch
// of existing code rewrites no doc, since those files change only by their comments. Every
// comment request leaves room in the context for its whole answer, and the log gives each
// file's time.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { startMockOllama } = require('./mock-ollama');
const { gitRepo } = require('./git-repo');
const { simulatedChat } = require('./speed-model');

const CONTEXT_TOKENS = 8192;
const FOLDERS = ['src/core', 'src/jobs', 'lib', 'app'];

// A module of about 200 lines: 18 short functions, as a real file has.
function moduleText(name, extra = 0) {
  const out = [`// Handles the ${name} records of the nightly job.`, "'use strict';", ''];
  const names = [];
  for (let f = 0; f < 18 + extra; f++) {
    const fn = `${name}Step${f}`;
    names.push(fn);
    out.push(
      `function ${fn}(items, limit) {`,
      '  const kept = [];',
      '  for (const item of items) {',
      `    if (item.size > limit * ${f + 2}) continue;`,
      `    kept.push({ ...item, step: ${f} });`,
      '  }',
      '  const total = kept.reduce((sum, item) => sum + item.size, 0);',
      '  return { kept, total };',
      '}',
      '',
    );
  }
  out.push(`module.exports = { ${names.join(', ')} };`, '');
  return out.join('\n');
}

function project(extra = 0) {
  const files = { 'package.json': JSON.stringify({ name: 'nightly-project', scripts: { test: 'node --test' } }) };
  FOLDERS.forEach((dir, d) => {
    for (let i = 0; i < 10; i++) files[`${dir}/mod${d}${i}.js`] = moduleText(`mod${d}${i}`, extra);
  });
  return files;
}

async function night(repo, mock, budget = 90) {
  const { run } = require('../src/main');
  const cwd = repo.clone();
  const sim = simulatedChat(mock);
  const requests = [];
  const chat = (request) => {
    requests.push({ label: request.label, model: request.model, options: request.options || {}, at: sim.minutes(), chars: (request.messages || []).map((m) => m.content).join('\n').length });
    return sim.chat(request);
  };
  const logs = [];
  const result = await run({
    cwd,
    env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: String(budget), INPUT_CONTEXT_TOKENS: String(CONTEXT_TOKENS), INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' },
    chat,
    now: sim.now,
    log: (l) => logs.push(l),
  });
  const lastRun = fs.readFileSync(path.join(cwd, '.docturnal/last-run.md'), 'utf8');
  return { result, sim, requests, logs, lastRun, minutes: sim.minutes() };
}

test('a night with 40 changed files: comments first, every reply fits the context, docs after, the rest next night', { timeout: 900000 }, async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(project(), 'A project');
    const first = await night(repo, mock);
    assert.strictEqual(first.result.changed, true);
    repo.merge();
    // Every file changes: one more function in each.
    repo.commit(project(1), 'Change every file');
    const second = await night(repo, mock);
    const { requests, logs, minutes } = second;

    assert.ok(minutes <= 90, `${minutes.toFixed(1)} minutes`);
    const commented = second.result.processed.length;
    const left = second.result.leftOver.filter((l) => l.reason === 'time budget').length;
    assert.ok(commented >= 15, `${commented} files commented`);
    assert.strictEqual(commented + left, 40);
    assert.ok(second.result.processed.every((f) => f.added > 0));

    // Each reply has room for its whole answer, so Ollama never drops the start of the prompt.
    const proposals = requests.filter((r) => /^comments for /.test(r.label));
    for (const r of proposals) {
      assert.ok(r.options.num_predict > 0 && r.options.num_predict <= 2000, `${r.label}: num_predict ${r.options.num_predict}`);
      assert.ok(r.chars / 3 + r.options.num_predict <= CONTEXT_TOKENS, `${r.label}: ${r.chars} characters`);
    }
    // The docs start after the last proposal and the last check.
    const lastComment = Math.max(...requests.filter((r) => /^(comments for|accuracy check)/.test(r.label)).map((r) => r.at));
    const firstDoc = Math.min(...requests.filter((r) => /^(docs\/|layer|README)/.test(r.label)).map((r) => r.at));
    assert.ok(firstDoc >= lastComment, `docs at ${firstDoc}, comments until ${lastComment}`);
    // The log gives each file's time, and why a file was left.
    const timings = logs.filter((l) => /: proposals in [\d.]+ s \(\d+ requests?\), (accuracy check in [\d.]+ s \(\d+ requests?\)|no accuracy check needed)$/.test(l));
    assert.strictEqual(timings.length, commented);
    // What a night does not reach waits: files the time left, and the targets past each file's
    // cap for one run.
    assert.ok(logs.some((l) => /: deferred to the next run, time budget$|: \d+ more targets wait for a later batch, at most 8 new comments a file each run at the medium level$/.test(l)));
    // Kept for the report: files a night comments at this size.
    console.log(`nightly: ${commented} of 40 changed files of about 200 lines commented in ${minutes.toFixed(1)} minutes`);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});

test('a night with only a batch of existing code rewrites no doc and asks for comments the level can take', { timeout: 900000 }, async () => {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(project(), 'A project');
    await night(repo, mock);
    repo.merge();
    const second = await night(repo, mock);
    assert.match(second.lastRun, /batch 1 of existing code, 15 files/);
    // No layer doc or README request: the batch's files change only by their comments.
    const docs = second.requests.filter((r) => r.model === 'docs-model' && !/^(accuracy check|loading)/.test(r.label));
    assert.deepStrictEqual(docs.map((r) => r.label), []);
    assert.ok(second.minutes <= 90);
    // Each file got at most 8 new comments; with more room left, it waits for a later batch
    // rather than counting as commented at the level.
    const state = JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    for (const f of second.result.processed) assert.ok(f.added <= 8, f.path);
    for (const file of state.pending.batch.files) {
      const f = second.result.processed.find((p) => p.path === file);
      if (f) assert.strictEqual(state.files[file].level, f.added === 8 ? null : 'medium', file);
    }
    console.log(`batch night: ${second.result.processed.length} files in ${second.minutes.toFixed(1)} minutes`);
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
