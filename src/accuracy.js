'use strict';

// The accuracy check: requests that show each selected comment with the code it sits above
// and ask whether the comment is true of that code. Comments marked inaccurate are
// dropped. It catches comments written for a neighboring line or another function.

const ACCURACY_PROMPT = `You check code comments against the code they sit above. You never rewrite code or comments.

Each item has an id, a comment, and the code lines directly below the comment, each prefixed with its line number and "| ". For every item, decide whether the comment accurately describes that code:
- accurate: true when everything the comment states is true of the code shown.
- accurate: false when the comment describes different code, such as another function or the next statement, or states something this code does not do.

Return one verdict for every id.`;

const ACCURACY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, accurate: { type: 'boolean' } },
        required: ['id', 'accurate'],
      },
    },
  },
  required: ['verdicts'],
};

// The code a comment is attached to: its target line and up to 4 more, stopping at a blank line.
const CODE_LINES = 5;
const MAX_CODE_LINE_CHARS = 200;

function attachedCode(lines, target) {
  const out = [];
  for (let i = target - 1; i < Math.min(lines.length, target - 1 + CODE_LINES); i++) {
    if (out.length && lines[i].text.trim() === '') break;
    const text = lines[i].text;
    out.push(`${i + 1}| ${text.length > MAX_CODE_LINE_CHARS ? `${text.slice(0, MAX_CODE_LINE_CHARS)}...` : text}`);
  }
  return out;
}

// items: [{ comment, target }], one batch; item i has id i + 1. Only the 1 to 5 code lines
// under each comment are sent, never the whole file.
function buildAccuracyMessages({ path, language, lines, items }) {
  const parts = items.map((item, i) => `Item ${i + 1}\nComment: ${item.comment}\nCode:\n${attachedCode(lines, item.target).join('\n')}`);
  return [
    { role: 'system', content: ACCURACY_PROMPT },
    { role: 'user', content: `File: ${path}\nLanguage: ${language.name}\n\n${parts.join('\n\n')}` },
  ];
}

// Returns a Map from id to true or false. Anything malformed is ignored, so a comment
// without a clear verdict is not dropped.
function parseVerdicts(content, count) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || !Array.isArray(data.verdicts)) throw new Error('response has no verdicts');
  const verdicts = new Map();
  for (const v of data.verdicts) {
    if (!v || !Number.isInteger(v.id) || v.id < 1 || v.id > count || typeof v.accurate !== 'boolean') continue;
    if (!verdicts.has(v.id)) verdicts.set(v.id, v.accurate);
  }
  return verdicts;
}

module.exports = { ACCURACY_SCHEMA, attachedCode, buildAccuracyMessages, parseVerdicts };
