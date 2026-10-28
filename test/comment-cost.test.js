'use strict';

// What a night of comments costs, with model time simulated at the speeds calibrated from a
// real runner (see speed-model.js), on the batch of existing code from an excalidraw fork
// (see excalidraw-files.js). The real run of the earlier engine took 79 minutes for 14 of
// these files and added 32 comments, about 2.5 minutes a comment. Code now chooses every
// spot, so no comment is lost to an anchor, the level, or the gap, and each request is short.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { startMockOllama } = require('./mock-ollama');
const { gitRepo } = require('./git-repo');
const { simulatedChat } = require('./speed-model');
const { excalidrawFiles } = require('./excalidraw-files');
const { PER_RUN } = require('../src/comments');

const CONTEXT_TOKENS = 8192;
const REAL_RUN = { minutes: 79, comments: 32 };

async function night(repo, mock, { budget, level = 'medium' }) {
  const { run } = require('../src/main');
  const cwd = repo.clone();
  const sim = simulatedChat(mock);
  const requests = [];
  const chat = (request) => {
    requests.push({ label: request.label, model: request.model, options: request.options || {}, chars: (request.messages || []).map((m) => m.content).join('\n').length, prompt: (request.messages || []).map((m) => m.content).join('\n') });
    return sim.chat(request);
  };
  const logs = [];
  const result = await run({
    cwd,
    env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: level, INPUT_TIME_BUDGET_MINUTES: String(budget), INPUT_CONTEXT_TOKENS: String(CONTEXT_TOKENS), INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model' },
    chat,
    now: sim.now,
    log: (l) => logs.push(l),
  });
  const lastRun = fs.readFileSync(path.join(cwd, '.docturnal/last-run.md'), 'utf8');
  return { result, requests, logs, lastRun, minutes: sim.minutes() };
}

// The batch night after the documentation pass: the 15 files are the first batch.
async function batchNight(budget) {
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit({ 'package.json': JSON.stringify({ name: 'excalidraw-fork', private: true }), ...excalidrawFiles() }, 'The fork');
    await night(repo, mock, { budget: 90 });
    repo.merge();
    const second = await night(repo, mock, { budget });
    return { ...second, state: JSON.parse(repo.text('docturnal/update', '.docturnal/state.json')) };
  } finally {
    await mock.close();
    repo.cleanup();
  }
}

const added = (result) => result.processed.reduce((sum, f) => sum + f.added, 0);

test('the excalidraw batch at medium: minutes, comments added, and minutes per comment, with no budget in the way', { timeout: 900000 }, async () => {
  const { result, requests, logs, minutes, lastRun } = await batchNight(90);
  assert.match(lastRun, /batch 1 of existing code/);
  const left = result.leftOver.filter((l) => l.reason === 'time budget').length;
  assert.strictEqual(result.processed.length + left, 15);
  const comments = added(result);
  const perComment = minutes / comments;
  // Every request stays under the size limits: at most 40 lines of code a target, and the
  // prompt and the whole answer within the context.
  const asks = requests.filter((r) => /^comments for /.test(r.label));
  for (const r of asks) {
    const targets = (r.prompt.match(/^Target \d+, line \d+:/gm) || []).length;
    assert.ok(targets >= 1 && targets <= 4, r.label);
    assert.ok((r.prompt.match(/^\d+\| /gm) || []).length <= 40 * targets, r.label);
    assert.ok(r.chars / 3 + r.options.num_predict <= CONTEXT_TOKENS, r.label);
    assert.ok(r.options.num_predict <= 16 + 4 * (25 * 2 + 24), r.label);
  }
  // No comment is lost to an anchor or to the level: every drop is the check's or a filter's.
  for (const f of result.processed) {
    assert.deepStrictEqual(f.stats.dropped.placement, {}, f.path);
    assert.deepStrictEqual(f.stats.dropped.density, {}, f.path);
    assert.strictEqual(f.stats.dropped.anchor, undefined, f.path);
  }
  // The accuracy check runs with the docs model.
  const checks = requests.filter((r) => /^accuracy check/.test(r.label));
  assert.ok(checks.length > 0 && checks.every((r) => r.model === 'docs-model'));
  assert.ok(comments > REAL_RUN.comments, `${comments} comments`);
  assert.ok(perComment < (REAL_RUN.minutes / REAL_RUN.comments) / 2, `${perComment.toFixed(2)} minutes a comment`);
  assert.ok(logs.some((l) => / targets, proposed \d+/.test(l)));
  // No file gets more than the level's cap for one run.
  for (const f of result.processed) assert.ok(f.added <= PER_RUN.medium, `${f.path}: ${f.added}`);
  const touched = result.processed.filter((f) => f.added > 0).length;
  console.log(`excalidraw batch, medium, 90-minute budget: ${touched} of 15 files touched, ${asks.length} comment requests, ${checks.length} checks, ${comments} comments in ${minutes.toFixed(1)} minutes, ${perComment.toFixed(2)} minutes a comment (the real run: ${REAL_RUN.minutes} minutes, ${REAL_RUN.comments} comments, ${(REAL_RUN.minutes / REAL_RUN.comments).toFixed(2)} minutes a comment)`);
});

test('the excalidraw batch with the private-repository cap of 30 minutes spreads over every file and stops in time', { timeout: 900000 }, async () => {
  const { result, minutes, logs, state } = await batchNight(30);
  assert.ok(minutes <= 30, `${minutes.toFixed(1)} minutes`);
  const comments = added(result);
  const touched = result.processed.filter((f) => f.added > 0);
  // Every file gets its best targets first, so the time goes to the whole batch, not to
  // snapping.ts alone.
  assert.strictEqual(touched.length, 15, `${touched.length} files touched`);
  for (const f of result.processed) assert.ok(f.added <= PER_RUN.medium, `${f.path}: ${f.added}`);
  // A file with targets left keeps what it got, is not yet commented at the level, and says
  // why: the time, or the cap for one run.
  const waiting = result.processed.filter((f) => state.files[f.path].level === null);
  assert.ok(waiting.length > 0);
  for (const f of waiting) {
    assert.ok(logs.some((l) => l.startsWith(`${f.path}: `) && /requests made before the time budget|more targets? waits? for a later batch/.test(l)), f.path);
  }
  console.log(`excalidraw batch, medium, 30-minute cap: ${touched.length} of 15 files touched, ${comments} comments in ${minutes.toFixed(1)} minutes, ${(minutes / comments).toFixed(2)} minutes a comment, ${waiting.length} files with more for a later batch`);
});
