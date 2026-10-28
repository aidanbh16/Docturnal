'use strict';

// The comment requests and their replies: each request shows only its targets' code and
// leaves room in the context for its whole answer; it asks for exactly the targets the
// level has room for; a reply cut off keeps its complete comments; a request that gives
// fewer comments than it asked for says why, by category; and every comment written goes to
// the accuracy check, since none is over the level.

const test = require('node:test');
const assert = require('node:assert');

const { MAX_EXCERPT_LINES, MAX_TARGETS_PER_REQUEST, REPLY_CAUSES: CAUSE, checkComments, finishComments, planComments, planTargets, readReply, replySummary, salvageReply } = require('../src/comments');

const CONTEXT = 8192;

// A file of n short functions, each with a comment above it or not.
function functions(n, { commented = false } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (commented) out.push(`// Step ${i} keeps its own total, so callers can compare them.`);
    out.push(`function step${i}(items) {`, '  let total = 0;', `  for (const item of items) total += item.size * ${i + 2};`, '  return total;', '}', '');
  }
  return `${out.join('\n')}\n`;
}
const names = (n) => Array.from({ length: n }, (_, i) => `step${i}`);

// A chat function that records each request and answers with reply(request).
function recorder(reply) {
  const requests = [];
  const chat = async (request) => {
    requests.push(request);
    return reply(request);
  };
  return { chat, requests };
}

// The model's answer: one comment for every target the request lists.
const answer = (request) => JSON.stringify({
  comments: [...request.messages[1].content.matchAll(/^Target (\d+), line/gm)].map(([, id]) => ({ id: Number(id), text: 'Weights each item by its step, so later steps count more.' })),
});

test('a reply cut off at its length limit keeps its complete comments', () => {
  const content = '{"comments": [{"id": 1, "text": "One \\"quoted\\" word, and a brace }."}, {"id": 2, "text": "Cut of';
  assert.deepStrictEqual(salvageReply(content), { comments: [{ id: 1, text: 'One "quoted" word, and a brace }.' }] });
  const read = readReply({ content, doneReason: 'length', promptTokens: 900, replyTokens: 120 }, { contextTokens: CONTEXT, count: 2 });
  assert.strictEqual(read.cause, CAUSE.length);
  assert.deepStrictEqual([...read.texts], [[1, 'One "quoted" word, and a brace }.']]);
  assert.strictEqual(read.salvaged, true);
});

test('each reply that gives fewer comments than asked says why, by category', () => {
  const opts = { contextTokens: CONTEXT, count: 2 };
  assert.strictEqual(readReply('{"comments": []}', opts).cause, CAUSE.none);
  assert.strictEqual(readReply('{"comments": [{"id": 2, "text": "Only the second."}]}', opts).cause, CAUSE.missing);
  // An id not asked for, a repeated id, and an empty text count as missing.
  assert.strictEqual(readReply('{"comments": [{"id": 1, "text": "First."}, {"id": 1, "text": "Again."}, {"id": 3, "text": "Extra."}, {"id": 2, "text": " "}]}', opts).cause, CAUSE.missing);
  assert.strictEqual(readReply({ content: '{"comments": []}', promptTokens: 7000, replyTokens: 1190 }, opts).cause, CAUSE.context);
  assert.throws(() => readReply('{"summary": "x"}', opts), { message: CAUSE.noList });
  assert.throws(() => readReply('not json at all', opts), { message: CAUSE.json });
  assert.throws(() => readReply({ content: '{"comm', doneReason: 'length' }, opts), { message: CAUSE.length });
  assert.throws(() => readReply({ content: '{"comm', promptTokens: 6000, replyTokens: 2192 }, opts), { message: CAUSE.context });
  const full = readReply('{"comments": [{"id": 1, "text": "First."}, {"id": 2, "text": "Second."}]}', opts);
  assert.strictEqual(full.cause, null);
  assert.deepStrictEqual([...full.texts.keys()], [1, 2]);
});

test('every comment request shows at most 40 lines a target and fits its whole answer in the context', async () => {
  // Long functions of long lines, with five-digit line numbers.
  const out = Array.from({ length: 11000 }, (_, i) => `// filler line ${i}`);
  for (let f = 0; f < 30; f++) {
    out.push(`export function big${f}(input) {`);
    for (let i = 0; i < 120; i++) out.push(`  const value${i} = compute(input, ${i + 2}, 'a label of some length for the line, repeated: ${'x'.repeat(150)}');`);
    out.push('  return input;', '}', '');
  }
  const text = `${out.join('\n')}\n`;
  for (const level of ['low', 'medium', 'heavy']) {
    for (const contextTokens of [CONTEXT, 4096]) {
      const plan = planTargets({ path: 'src/big.js', text, level, contextTokens, exportNames: Array.from({ length: 30 }, (_, f) => `big${f}`) });
      assert.ok(plan.planned.length > 0, level);
      for (const r of plan.planned) {
        const prompt = r.messages.map((m) => m.content).join('\n');
        assert.ok(r.targets.length >= 1 && r.targets.length <= MAX_TARGETS_PER_REQUEST);
        const shown = prompt.match(/^\d+\| /gm).length;
        assert.ok(shown <= MAX_EXCERPT_LINES * r.targets.length, `${shown} lines for ${r.targets.length} targets`);
        assert.ok(r.numPredict > 0 && r.numPredict <= 16 + MAX_TARGETS_PER_REQUEST * (50 * 2 + 24), `num_predict ${r.numPredict}`);
        assert.ok(prompt.length / 3 + r.numPredict <= contextTokens, `${level}, ${contextTokens}: ${prompt.length} characters and ${r.numPredict} tokens`);
      }
    }
  }
  const { chat, requests } = recorder(answer);
  await planComments({ path: 'src/steps.js', text: functions(120), level: 'medium', model: 'm', contextTokens: CONTEXT, chat, exportNames: names(120) });
  assert.ok(requests.length >= 1);
  for (const r of requests) {
    assert.ok(r.options.num_predict > 0 && r.options.num_predict <= 16 + 4 * (25 * 2 + 24));
    assert.strictEqual(r.options.num_ctx, CONTEXT);
    assert.strictEqual(r.withReason, true);
  }
});

test('the targets are the comments the level has room for, and a file that is full gets no request', async () => {
  const { chat, requests } = recorder(answer);
  // 24 exported functions of 5 code lines: 120 code lines, room for 10 at medium, 5 lines apart;
  // one run takes the 8 best of them, and the other 2 wait for a later batch.
  const plan = await planComments({ path: 'src/steps.js', text: functions(24), level: 'medium', model: 'm', contextTokens: CONTEXT, chat, exportNames: names(24) });
  assert.strictEqual(plan.targets.length, 8);
  assert.strictEqual(plan.more, 2);
  const asked = requests.flatMap((r) => [...r.messages[1].content.matchAll(/^Target \d+, line (\d+)/gm)].map((m) => Number(m[1])));
  assert.deepStrictEqual(asked.sort((a, b) => a - b), plan.targets.map((t) => t.line));
  // Small functions go four to a request.
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].options.num_predict, 16 + 4 * (25 * 2 + 24));
  // Every function already commented: the level is full, so no request at all.
  const full = recorder(() => { throw new Error('no request expected'); });
  const done = await planComments({ path: 'src/steps.js', text: functions(24, { commented: true }), level: 'medium', model: 'm', contextTokens: CONTEXT, chat: full.chat, exportNames: names(24) });
  assert.strictEqual(full.requests.length, 0);
  assert.strictEqual(done.requests, 0);
  assert.strictEqual(replySummary(done), '');
  assert.strictEqual(finishComments(done).added, 0);
  // At heavy level, a commented function needs nothing either, and the magic number in each
  // loop is in a statement that shares the loop's line, where no comment can go.
  const heavy = recorder(answer);
  const blocks = await planComments({ path: 'src/steps.js', text: functions(24, { commented: true }), level: 'heavy', model: 'm', contextTokens: CONTEXT, chat: heavy.chat, exportNames: names(24) });
  assert.deepStrictEqual(blocks.targets, []);
  assert.strictEqual(heavy.requests.length, 0);
});

test('a reply that leaves out a target says so in the log, with counts only', async () => {
  const { chat } = recorder((request) => {
    const all = JSON.parse(answer(request)).comments;
    return JSON.stringify({ comments: all.slice(1) });
  });
  const plan = await planComments({ path: 'src/steps.js', text: functions(8), level: 'medium', model: 'm', contextTokens: CONTEXT, chat, exportNames: names(8) });
  assert.match(replySummary(plan), /^replies: lines [\d, ]+: the reply left out some targets, \d of \d$/);
  assert.doesNotMatch(replySummary(plan), /Weights/);
});

test('every comment written goes to the accuracy check: none is over the level', async () => {
  const { chat } = recorder(answer);
  let clock = 0;
  const plan = await planComments({ path: 'src/steps.js', text: functions(24), level: 'medium', model: 'm', contextTokens: CONTEXT, chat, now: () => clock, exportNames: names(24) });
  assert.strictEqual(plan.built.candidates.length, 8);
  assert.deepStrictEqual(plan.built.rejections, []);
  const checked = [];
  await checkComments(plan, {
    model: 'm',
    contextTokens: CONTEXT,
    now: () => (clock += 1000),
    chat: async (request) => {
      const items = [...request.messages[1].content.matchAll(/^Item (\d+)$/gm)].map((m) => Number(m[1]));
      checked.push(...items);
      return JSON.stringify({ verdicts: items.map((id) => ({ id, accurate: true, useful: true, repeats: false })) });
    },
  });
  assert.strictEqual(checked.length, 8);
  assert.ok(plan.checkMs > 0 && plan.checkRequests === 1);
  const result = finishComments(plan);
  assert.strictEqual(result.added, 8);
  assert.strictEqual(result.stats.proposed, 8);
  assert.deepStrictEqual(result.rejections, []);
});
