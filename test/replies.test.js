'use strict';

// The comment requests and their replies: each request leaves room in the context for its
// whole answer and asks for no more comments than the level can take; a reply cut off keeps
// its complete comments; a request that gives no proposals says why, by category; and only
// the comments the level can take are sent to the accuracy check.

const test = require('node:test');
const assert = require('node:assert');

const { MAX_PROPOSALS, REPLY_CAUSES: CAUSE, buildWindows, checkComments, finishComments, planComments, readReply, replySummary, salvageReply } = require('../src/comments');
const { splitLines } = require('../src/analyze');

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

// A chat function that records each request and answers with reply(request).
function recorder(reply) {
  const requests = [];
  const chat = async (request) => {
    requests.push(request);
    return reply(request);
  };
  return { chat, requests };
}

const proposalsFor = (request) => {
  const prompt = request.messages.map((m) => m.content).join('\n');
  return [...prompt.matchAll(/^(\d+)\| (function \w+\(items\) \{)$/gm)].map(([, line, code]) => ({ line: Number(line), anchor: code, text: 'Weights each item by its step, so later steps count more.', kind: 'line' }));
};

test('a reply cut off at its length limit keeps its finished summary and complete comments', () => {
  const content = '{"summary": "Adds the steps.", "symbols": ["step0", "step1"], "comments": [{"line": 1, "anchor": "function step0(items) {", "text": "One \\"quoted\\" word, and a brace }.", "kind": "line"}, {"line": 7, "anchor": "function step1(it';
  const salvaged = salvageReply(content);
  assert.deepStrictEqual(salvaged, {
    summary: 'Adds the steps.',
    symbols: ['step0', 'step1'],
    comments: [{ line: 1, anchor: 'function step0(items) {', text: 'One "quoted" word, and a brace }.', kind: 'line' }],
  });
  const read = readReply({ content, doneReason: 'length', promptTokens: 5000, replyTokens: 2000 }, { contextTokens: CONTEXT, cap: 10 });
  assert.strictEqual(read.cause, CAUSE.length);
  assert.strictEqual(read.comments.length, 1);
  assert.strictEqual(read.salvaged, true);
});

test('each reply that gives no proposals says why, by category', () => {
  const opts = { contextTokens: CONTEXT, cap: 5 };
  assert.strictEqual(readReply('{"summary": "x", "symbols": [], "comments": []}', opts).cause, CAUSE.none);
  assert.strictEqual(readReply('{"summary": "x", "symbols": [], "comments": []}', { ...opts, cap: 0 }).cause, CAUSE.capped);
  assert.strictEqual(readReply('{"summary": "x", "symbols": []}', opts).cause, CAUSE.noList);
  assert.strictEqual(readReply({ content: '{"summary": "x", "symbols": [], "comments": []}', promptTokens: 7000, replyTokens: 1190 }, opts).cause, CAUSE.context);
  assert.throws(() => readReply('not json at all', opts), { message: CAUSE.json });
  assert.throws(() => readReply({ content: '{"summ', doneReason: 'length' }, opts), { message: CAUSE.length });
  assert.throws(() => readReply({ content: '{"summ', promptTokens: 6000, replyTokens: 2192 }, opts), { message: CAUSE.context });
  assert.strictEqual(readReply('{"summary": "x", "symbols": [], "comments": [{"line": 1}]}', opts).cause, null);
});

test('every comment request fits its prompt and its whole answer in the context', async () => {
  // Long lines with five-digit line numbers: the prefixes count as tokens too.
  const text = `${Array.from({ length: 12000 }, (_, i) => `const value${i} = compute(${i}, 'a label of some length for the line');`).join('\n')}\n`;
  const lines = splitLines(text);
  for (const w of buildWindows(lines, CONTEXT)) {
    let tokens = 0;
    for (let i = w.start; i < w.end; i++) tokens += Math.ceil((lines[i].text.length + 1) / 3) + String(i + 1).length + 2;
    assert.ok(tokens <= CONTEXT - 1000 - 2000, `lines ${w.start + 1}-${w.end}: ${tokens} tokens`);
  }
  const { chat, requests } = recorder((request) => JSON.stringify({ summary: 'Steps.', symbols: [], comments: proposalsFor(request) }));
  await planComments({ path: 'src/steps.js', text: functions(120), level: 'medium', model: 'm', contextTokens: CONTEXT, chat });
  assert.ok(requests.length >= 1);
  for (const r of requests) {
    assert.ok(r.options.num_predict > 0 && r.options.num_predict <= 2000);
    assert.strictEqual(r.options.num_ctx, CONTEXT);
    assert.strictEqual(r.withReason, true);
  }
});

test('a request asks for no more comments than the level can take, and none when it is full', async () => {
  const { chat, requests } = recorder((request) => JSON.stringify({ summary: 'Steps.', symbols: [], comments: proposalsFor(request) }));
  // 24 functions of 5 code lines: 120 code lines, room for 10 at medium; half again is 15.
  await planComments({ path: 'src/steps.js', text: functions(24), level: 'medium', model: 'm', contextTokens: CONTEXT, chat });
  assert.match(requests[0].messages[1].content, /^Propose at most 15 comments\.$/m);
  assert.strictEqual(requests[0].options.num_predict, 300 + 15 * 70);
  // Every function already commented: the level is full.
  const full = recorder(() => JSON.stringify({ summary: 'Steps.', symbols: [], comments: [] }));
  const plan = await planComments({ path: 'src/steps.js', text: functions(24, { commented: true }), level: 'medium', model: 'm', contextTokens: CONTEXT, chat: full.chat });
  assert.match(full.requests[0].messages[1].content, /so return an empty comments list\.$/m);
  assert.strictEqual(full.requests[0].options.num_predict, 300);
  assert.match(replySummary(plan), /^replies: lines 1-\d+: the code already has as many comments as the level allows$/);
  // At heavy level, every declaration may take a block comment.
  const heavy = recorder(() => JSON.stringify({ summary: 'Steps.', symbols: [], comments: [] }));
  await planComments({ path: 'src/steps.js', text: functions(24, { commented: true }), level: 'heavy', model: 'm', contextTokens: CONTEXT, chat: heavy.chat });
  assert.match(heavy.requests[0].messages[1].content, new RegExp(`^Propose at most ${Math.min(MAX_PROPOSALS, 24)} comments\\.$`, 'm'));
});

test('a file in a batch whose comments already fill the level needs no request', async () => {
  const { chat, requests } = recorder(() => { throw new Error('no request expected'); });
  const plan = await planComments({
    path: 'src/steps.js', text: functions(24, { commented: true }), level: 'medium', model: 'm', contextTokens: CONTEXT, chat,
    known: { summary: 'Computes weighted totals per step.', symbols: ['step0'] },
  });
  assert.strictEqual(requests.length, 0);
  assert.strictEqual(plan.summary, 'Computes weighted totals per step.');
  assert.deepStrictEqual(plan.symbols, ['step0']);
  assert.strictEqual(plan.requests, 0);
  assert.match(replySummary(plan), /no request made$/);
  assert.strictEqual(finishComments(plan).added, 0);
});

test('only the comments the level can take go to the accuracy check', async () => {
  // 24 proposals; medium allows 10, at least 5 lines apart.
  const { chat } = recorder((request) => JSON.stringify({ summary: 'Steps.', symbols: [], comments: proposalsFor(request).concat(proposalsFor(request).map((p) => ({ ...p, line: p.line + 2, anchor: `for (const item of items) total += item.size * ${(p.line + 5) / 6 + 1};` }))) }));
  let clock = 0;
  const plan = await planComments({ path: 'src/steps.js', text: functions(24), level: 'medium', model: 'm', contextTokens: CONTEXT, chat, now: () => clock });
  assert.ok(plan.built.candidates.length <= 10, `${plan.built.candidates.length} to check`);
  const dropped = plan.built.rejections.filter((r) => r.category === 'density').length;
  assert.ok(dropped >= plan.built.proposed - 10 - plan.built.rejections.filter((r) => r.category !== 'density').length);
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
  assert.strictEqual(checked.length, plan.built.candidates.length);
  assert.ok(plan.checkMs > 0 && plan.checkRequests === Math.ceil(checked.length / 8));
  const result = finishComments(plan);
  assert.strictEqual(result.added, plan.built.candidates.length);
  assert.strictEqual(result.stats.proposed, 48);
});
