'use strict';

// Comments on declarations, with excalidraw-shaped targets: a summary of a function, class,
// or component is never dropped for sharing words with its name, only for being inaccurate
// or saying no more than the name; a declaration always gets a comment, asked for once more
// alone when the reply gives none; comments start with what the code does; and the log says,
// per file, which targets got none and why, and what each check dropped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commentFile, missingSummary, planComments, stripOpener } = require('../src/comments');
const { onlyItsName } = require('../src/restates');
const { processItems } = require('../src/process');
const { emptyState } = require('../src/state');
const { proposalSummary } = require('../src/report');
const { writingByCode } = require('./helpers');
const { commentsReply, defaultHandler, kindOf, startMockOllama, targetsOf } = require('./mock-ollama');

// Shaped like packages/excalidraw/clipboard.ts: two exported functions and a block with a
// regular expression, which is complex.
const CLIPBOARD = [
  'import { MIME_TYPES } from "./constants";',
  '',
  'export const copyBlobToClipboardAsPng = async (blob: Blob | Promise<Blob>) => {',
  '  try {',
  '    await navigator.clipboard.write([new window.ClipboardItem({ [MIME_TYPES.png]: blob })]);',
  '  } catch (error) {',
  '    if (isPromiseLike(blob)) {',
  '      const resolved = await blob;',
  '      await navigator.clipboard.write([new window.ClipboardItem({ [MIME_TYPES.png]: resolved })]);',
  '    } else {',
  '      throw error;',
  '    }',
  '  }',
  '};',
  '',
  'const isPromiseLike = (value: unknown): value is Promise<unknown> => {',
  '  if (value === null || value === undefined) {',
  '    return false;',
  '  }',
  '  return !!value && typeof (value as Promise<unknown>).then === "function";',
  '};',
  '',
  'export const parseClipboardText = (text: string) => {',
  '  const trimmed = text.trim();',
  '  const lines = trimmed.split("\\n");',
  '  const first = lines[0] || "";',
  '  const rest = lines.slice(1);',
  '  const blank = rest.every((line) => !line.trim());',
  '  const isUrl = /^https?:\\/\\/[^\\s]+$/.test(first);',
  '  if (isUrl && blank) {',
  '    return { type: "url", value: first };',
  '  }',
  '  const count = lines.length;',
  '  return { type: "text", value: trimmed, count };',
  '};',
  '',
  'export function getValue(element: { value: number }) {',
  '  const value = element.value;',
  '  return value;',
  '}',
  '',
  'const countWords = (text: string) => {',
  '  let count = 0;',
  '  for (const word of text.split(" ")) {',
  '    if (word) {',
  '      count += 1;',
  '    }',
  '  }',
  '  return count;',
  '};',
  '',
].join('\n');

const LINE = {
  copy: 'export const copyBlobToClipboardAsPng = async (blob: Blob | Promise<Blob>) => {',
  parse: 'export const parseClipboardText = (text: string) => {',
  url: 'const isUrl = /^https?:\\/\\/[^\\s]+$/.test(first);',
  value: 'export function getValue(element: { value: number }) {',
};
const COPY = "Copies a Blob to the clipboard as a PNG image. Handles Safari's synchronous ClipboardItem requirement.";
const PARSE = 'Parses pasted clipboard text into a URL or plain text with its line count.';
const BLOCK = 'Checks whether the first line is a URL.';
const EXPORTS = { exportNames: ['copyBlobToClipboardAsPng', 'parseClipboardText', 'getValue'] };

// A check that calls every comment useless, as the docs model did for viewport.ts.
const useless = () => ({ useful: false });

async function run(handler, options = {}) {
  const mock = await startMockOllama(handler);
  try {
    const result = await commentFile({ path: 'packages/excalidraw/clipboard.ts', text: CLIPBOARD, level: 'medium', model: 'm', host: mock.host, ...EXPORTS, ...options });
    return { result, requests: mock.requests };
  } finally {
    await mock.close();
  }
}

test('a declaration summary that shares words with its name is kept; a block that restates is not', async () => {
  const { result } = await run(writingByCode({ [LINE.copy]: COPY, [LINE.parse]: PARSE, [LINE.url]: BLOCK }, useless));
  assert.match(result.text, /\/\/ Copies a Blob to the clipboard as a PNG image\.[^\n]*\n(\/\/[^\n]*\n)?export const copyBlobToClipboardAsPng/);
  assert.match(result.text, /\/\/ Parses pasted clipboard text[^\n]*\nexport const parseClipboardText/);
  // The block's comment is not a summary, so the usefulness answer still drops it.
  assert.doesNotMatch(result.text, /Checks whether the first line/);
  assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code': 1 });
});

test('a summary that says no more than its name is dropped: "Gets the value." for getValue', async () => {
  assert.strictEqual(onlyItsName('Gets the value.', ['getValue']), true);
  assert.strictEqual(onlyItsName('Returns the value.', ['getValue']), true);
  assert.strictEqual(onlyItsName('Returns the element value of the function.', ['getValue', 'element']), true);
  assert.strictEqual(onlyItsName(COPY, ['copyBlobToClipboardAsPng']), false);
  assert.strictEqual(onlyItsName('Returns the stored value, or 0 before the first render.', ['getValue']), false);
  // Every answer from the check says useful, and it is still dropped, before the check.
  const { result, requests } = await run(writingByCode({ [LINE.copy]: COPY, [LINE.value]: 'Gets the value.' }));
  assert.doesNotMatch(result.text, /Gets the value/);
  assert.match(result.text, /\/\/ Copies a Blob/);
  assert.deepStrictEqual(result.stats.dropped.restates, { 'restates the code (only its name)': 1 });
  const checked = requests.filter((r) => kindOf(r) === 'accuracy').map((r) => r.messages[1].content).join('\n');
  assert.doesNotMatch(checked, /Gets the value/);
  assert.match(proposalSummary(result.stats, { reasons: true }), /1 restates the code \(restates the code \(only its name\): 1\)/);
});

test('a declaration always gets a comment: an empty reply is asked again with the target alone, a block is not', async () => {
  const texts = { copyBlobToClipboardAsPng: COPY, parseClipboardText: PARSE, getValue: 'Reads the value an element stores, so callers need not know its shape.' };
  // The first request gets an empty list; each retry alone gets its comment.
  const { result, requests } = await run((body) => {
    if (kindOf(body) === 'accuracy') return writingByCode({})(body);
    const targets = targetsOf(body);
    return targets.length > 1 ? { comments: [] } : commentsReply(body, (t) => texts[t.name]);
  });
  const asked = requests.filter((r) => kindOf(r) === 'comments').map(targetsOf);
  assert.ok(asked[0].length > 1 && asked[0].some((t) => t.kind === 'block'), 'the first request holds a block and declarations');
  const retries = asked.slice(1);
  assert.deepStrictEqual(retries.map((ts) => ts.length), retries.map(() => 1));
  // Every declaration of the first request is asked for once more, and the block is not.
  assert.deepStrictEqual(retries.map((ts) => ts[0].name).sort(), asked[0].filter((t) => t.kind !== 'block').map((t) => t.name).sort());
  for (const name of retries.map((ts) => ts[0].name)) assert.ok(result.text.includes(`// ${texts[name].slice(0, 40)}`), name);
  // The prompt offers no way out for a declaration.
  assert.match(requests[0].messages[0].content, /Write a comment for every target/);
  assert.match(requests[0].messages[0].content, /Only a block may be left out/);
});

test('a declaration whose retry gives none too is retried only once, and the log says why', async () => {
  const plan = await planComments({
    path: 'packages/excalidraw/clipboard.ts',
    text: CLIPBOARD,
    level: 'medium',
    model: 'm',
    ...EXPORTS,
    chat: async () => JSON.stringify({ comments: [] }),
  });
  const declarations = plan.targets.filter((t) => t.what !== 'block').length;
  const blocks = plan.targets.length - declarations;
  assert.ok(declarations >= 2 && blocks >= 1);
  assert.strictEqual(plan.requests, plan.planned.length);
  assert.strictEqual(plan.retries, declarations);
  assert.strictEqual(missingSummary(plan), `${plan.targets.length} targets got no comment (${blocks} ${blocks === 1 ? 'block or constant' : 'blocks or constants'}, ${declarations} declarations, ${declarations} after a retry alone): the model wrote none: ${plan.targets.length}`);
});

test('comments start with what the code does: openers that name the kind of code are taken off', async () => {
  for (const [from, to] of [
    ['Exports a function to copy a Blob to the clipboard as a PNG image.', 'Copies a Blob to the clipboard as a PNG image.'],
    ['This function parses pasted text.', 'Parses pasted text.'],
    ['A function that returns the stored value.', 'Returns the stored value.'],
    ['A React component that renders the hint for the active tool.', 'Renders the hint for the active tool.'],
    ['It tracks the pointer between frames.', 'Tracks the pointer between frames.'],
    ['Helper function that will flush the queue.', 'Flushes the queue.'],
    ['Class used to batch scene updates.', 'Batches scene updates.'],
    // Left alone: no verb follows, or the comment already starts with one.
    ['The type of the element.', 'The type of the element.'],
    ['Exports a function.', 'Exports a function.'],
    ['It is called on resize.', 'It is called on resize.'],
    [COPY, COPY],
  ]) assert.strictEqual(stripOpener(from), to, from);
  const { result } = await run(writingByCode({ [LINE.copy]: 'Exports a function to copy a Blob to the clipboard as a PNG image, falling back for Safari.', [LINE.parse]: 'This function parses pasted text into a URL or text.' }));
  assert.match(result.text, /\/\/ Copies a Blob to the clipboard as a PNG image, falling back for Safari\.\nexport const copyBlobToClipboardAsPng/);
  assert.match(result.text, /\/\/ Parses pasted text into a URL or text\.\nexport const parseClipboardText/);
});

test('the log gives, per file, the targets that got no comment and why, and what each check dropped', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-declarations-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src/clipboard.ts'), CLIPBOARD);
    const write = writingByCode({ [LINE.copy]: COPY, [LINE.value]: 'Gets the value.' });
    const others = defaultHandler();
    const handler = (request) => (['comments', 'accuracy'].includes(kindOf(request)) ? write(request) : others(request));
    const logs = [];
    await processItems({
      cwd,
      items: [{ path: 'src/clipboard.ts', kind: 'comment', reason: 'changed' }],
      previous: emptyState(),
      config: { commentLevel: 'medium', contextTokens: 8192, timeBudgetMinutes: 90 },
      models: { comment: 'comment-model', docs: 'docs-model' },
      chat: async (request) => {
        const reply = handler(request);
        return typeof reply === 'string' ? reply : JSON.stringify(reply);
      },
      log: (line) => logs.push(line),
    });
    // parseClipboardText is a declaration, so it was asked for again alone, and got none; the
    // block was left out of the first reply and not asked for again.
    assert.ok(logs.some((l) => /^src\/clipboard\.ts: replies: lines [\d, ]+: the reply left out some targets, 2 of 4; retry of lines \d+: the model wrote none$/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /^src\/clipboard\.ts: 2 targets got no comment \(1 block or constant, 1 declaration, 1 after a retry alone\): the model wrote none: 1, the reply left out some targets: 1$/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /^src\/clipboard\.ts: \d+ targets, proposed 2, 1 restates the code \(restates the code \(only its name\): 1\), 1 added$/.test(l)), logs.join('\n'));
    assert.ok(!logs.some((l) => l.includes(COPY) || l.includes('Gets the value')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
