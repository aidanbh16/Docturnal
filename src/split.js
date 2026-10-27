'use strict';

// Divides a large group of files, such as a big flat src/, into 2 to 4 parts with the docs
// model. The model gets every file's path and purpose and answers with each part's name,
// description, and files. The answer is checked in code: no file in two parts, 2 to the most
// parts, at least the minimum files in each, unique names, each name supported by its own
// files, and a description that is not one file's purpose. Files it leaves out, up to a
// quarter of them, are placed in code by their imports and purposes. An answer that breaks a
// rule is asked for once more, with the problems listed; layers.js clusters the group by its
// imports when that one breaks a rule too.

const { terms } = require('./grounding');

// In the prompt, a purpose is never cut shorter than this.
const MIN_PURPOSE_CHARS = 20;
// At most this many problems are listed in the second request, and files in one problem.
const MAX_PROBLEMS = 8;
const MAX_NAMED = 6;
// An answer may leave out at most this share of the files; code places them.
const MAX_MISSING_SHARE = 0.25;

const SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'files'],
      },
    },
  },
  required: ['parts'],
};

const where = (group) => (group.folders || [group.folder]).map((f) => (f === '.' ? 'the top folder' : `${f}/`)).join(', ');

// The request, at most totalChars long, or null when the files do not fit even with their
// purposes cut to MIN_PURPOSE_CHARS. problems: what was wrong with the last answer.
function splitPrompt(group, purposeOf, { maxParts, minSize, totalChars, styleRules = '', problems = [] }) {
  const system = `You document the architecture of software projects, using only what the material shows.${styleRules ? `\n\n${styleRules}` : ''}`;
  const fix = problems.length
    ? `\n\nYour last answer broke these rules. Fix them:\n${problems.slice(0, MAX_PROBLEMS).map((p) => `- ${p}`).join('\n')}`
    : '';
  const instructions = `These ${group.files.length} files are ${where(group)} of a project. They are too many for one architecture layer, so divide them into 2 to ${maxParts} parts, each a layer of its own.

For each part, give:
- name: 2 to 4 words in title case, taken from what its files do, such as "Comment Engine" or "Settings Page".
- description: one sentence that sums up what its files do together. Never one file's purpose.
- files: the paths of its files, exactly as listed.

Put every file in exactly one part, and at least ${minSize} files in each part. Put files together when they work on one job. Give each part a different name.${fix}

Files:
`;
  const room = totalChars - system.length - instructions.length;
  const purpose = (f) => String(purposeOf(f) || '').replace(/\s+/g, ' ').trim();
  const listing = (cut) => group.files.map((f) => {
    const text = purpose(f);
    const short = text.length <= cut ? text : `${text.slice(0, Math.max(0, text.lastIndexOf(' ', cut)) || cut)}...`;
    return `- ${f}${short ? `: ${short}` : ''}`;
  }).join('\n');
  let files = listing(Infinity);
  if (files.length > room) {
    const names = group.files.reduce((n, f) => n + f.length + 5, 0);
    const cut = Math.floor((room - names) / group.files.length) - 3;
    if (cut < MIN_PURPOSE_CHARS) return null;
    files = listing(cut);
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${instructions}${files}` },
  ];
}

// The tokens to allow for the answer: every path once, and a name and description per part.
function splitTokens(group, maxParts) {
  return Math.ceil(group.files.reduce((n, f) => n + f.length + 4, 0) / 3) + 70 * maxParts + 40;
}

const quoted = (files) => {
  const shown = files.slice(0, MAX_NAMED).map((f) => `\`${f}\``).join(', ');
  return files.length > MAX_NAMED ? `${shown}, and ${files.length - MAX_NAMED} more` : shown;
};

// Checks the model's answer: { parts: [{ name, description, files }], problems: [], placed }.
// parts is null when there are problems. rules: maxParts and minSize; supported(files, name),
// whether the name is supported by those files; copies(description), whether it repeats one
// file's purpose; taken, the lowercase names other layers already have. An answer that breaks
// no other rule and leaves out at most MAX_MISSING_SHARE of the files is kept, with each file
// it left out placed by importsOf(file) and purposeOf(file) (see placeMissing); placed counts
// them. The other rules are checked on the parts as the model gave them.
function checkSplit(answer, group, { maxParts, minSize, supported, copies, taken = new Set(), importsOf, purposeOf }) {
  const raw = answer && typeof answer === 'object' && Array.isArray(answer.parts) ? answer.parts : null;
  if (!raw) return { parts: null, problems: ['the answer is not JSON with a list of parts'], placed: 0 };
  const problems = [];
  if (raw.length < 2 || raw.length > maxParts) problems.push(`it has ${raw.length} ${raw.length === 1 ? 'part' : 'parts'}; give 2 to ${maxParts}`);
  // A path as listed, or one only one listed file ends with, such as comments.js for
  // src/comments.js.
  const known = new Set(group.files);
  const resolve = (given) => {
    const p = String(given).trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
    if (known.has(p)) return p;
    const ends = group.files.filter((f) => f.endsWith(`/${p}`));
    return ends.length === 1 ? ends[0] : null;
  };
  const owner = new Map();
  const unknown = [];
  const twice = new Set();
  const names = new Set();
  const parts = raw.map((entry, i) => {
    const e = entry && typeof entry === 'object' ? entry : {};
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 60) : '';
    const description = typeof e.description === 'string' ? e.description.trim() : '';
    const files = [];
    for (const given of Array.isArray(e.files) ? e.files : []) {
      const file = resolve(given);
      if (!file) unknown.push(String(given).slice(0, 80));
      else if (owner.has(file) && owner.get(file) !== i) twice.add(file);
      else if (!owner.has(file)) {
        owner.set(file, i);
        files.push(file);
      }
    }
    const label = name ? `"${name}"` : `part ${i + 1}`;
    if (!name) problems.push(`part ${i + 1} has no name`);
    else if (names.has(name.toLowerCase())) problems.push(`the name "${name}" is given to two parts`);
    else if (taken.has(name.toLowerCase())) problems.push(`the name "${name}" is already another layer's`);
    else if (!supported(files, name)) problems.push(`the name "${name}" does not say what its files do`);
    if (name) names.add(name.toLowerCase());
    if (files.length < minSize) problems.push(`${label} has ${files.length} ${files.length === 1 ? 'file' : 'files'}; each part needs at least ${minSize}`);
    if (!description) problems.push(`${label} has no description`);
    else if (copies(description)) problems.push(`the description of ${label} only repeats one file's purpose`);
    return { name, description, files: files.sort() };
  });
  if (unknown.length) problems.push(`${quoted(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not in the list`);
  if (twice.size) problems.push(`${quoted([...twice].sort())} ${twice.size === 1 ? 'is' : 'are'} in more than one part`);
  // A few files left out are placed in code; more than MAX_MISSING_SHARE of them is a problem.
  const missing = group.files.filter((f) => !owner.has(f));
  if (missing.length > MAX_MISSING_SHARE * group.files.length) problems.push(`${quoted(missing)} ${missing.length === 1 ? 'is' : 'are'} in no part`);
  if (problems.length) return { parts: null, problems, placed: 0 };
  placeMissing(missing, parts, { importsOf, purposeOf });
  return { parts, problems, placed: missing.length };
}

// Puts each file an answer left out in the part it shares the most with: the share of the
// files it imports that are in the part, plus, for the terms of its purpose and file name, how
// much of the part is about them (for each term, the share of the part's files whose purpose or
// name has it, averaged over its terms). Files that import it only break a tie: a client many
// files import, such as ollama.js, says where it is used, not what it is about. A tie after
// that goes to the earlier part. Each file is placed by the parts as the model gave them, so
// the order of the missing files does not matter.
function placeMissing(missing, parts, { importsOf = () => [], purposeOf = () => '' } = {}) {
  const termsOf = (f) => new Set(terms(`${purposeOf(f)} ${f.split('/').pop().replace(/\.\w+$/, '').replace(/[-_.]/g, ' ')}`));
  const given = parts.map((part) => ({ files: [...part.files], terms: part.files.map(termsOf) }));
  for (const file of missing) {
    const imports = new Set(importsOf(file).filter((f) => f !== file));
    const own = termsOf(file);
    let best = 0;
    let bestScore = [-1, -1];
    given.forEach((part, i) => {
      const outgoing = imports.size ? part.files.filter((f) => imports.has(f)).length / imports.size : 0;
      let about = 0;
      for (const term of own) about += part.terms.filter((set) => set.has(term)).length / Math.max(1, part.files.length);
      const score = [outgoing + (own.size ? about / own.size : 0), part.files.filter((f) => importsOf(f).includes(file)).length];
      if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
        best = i;
        bestScore = score;
      }
    });
    parts[best].files.push(file);
  }
  for (const part of parts) part.files.sort();
}

// Asks the model to split the group, and once more with the problems when its answer breaks a
// rule: { parts, attempts, reason }. parts is null when neither answer can be used, and reason
// says why. call(label, request) sends one request to the docs model.
async function splitWithModel(group, { call, purposeOf, importsOf, maxParts, minSize, supported, copies, taken, contextTokens, promptChars, styleRules, errors = [] }) {
  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = splitPrompt(group, purposeOf, { maxParts, minSize, totalChars: promptChars, styleRules, problems });
    if (!messages) return { parts: null, attempts: attempt - 1, reason: 'its files do not fit in one request' };
    let content;
    try {
      content = await call(`split ${group.folder}`, {
        messages,
        format: SPLIT_SCHEMA,
        options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: splitTokens(group, maxParts) },
      });
    } catch (err) {
      errors.push(`layers: the request to split ${where(group)} failed (${String(err.message).slice(0, 200)})`);
      return { parts: null, attempts: attempt, reason: 'the request failed' };
    }
    let answer = null;
    try {
      answer = JSON.parse(content);
    } catch {
      // Checked below as an answer with no parts.
    }
    const checked = checkSplit(answer, group, { maxParts, minSize, supported, copies, taken, importsOf, purposeOf });
    if (checked.parts) return { parts: checked.parts, attempts: attempt, placed: checked.placed, reason: '' };
    problems = checked.problems;
    errors.push(`layers: answer ${attempt} for splitting ${where(group)} broke ${problems.length} ${problems.length === 1 ? 'rule' : 'rules'}: ${problems.slice(0, MAX_PROBLEMS).join('; ')}`);
  }
  return { parts: null, attempts: 2, reason: 'both answers broke the rules' };
}

module.exports = { MAX_MISSING_SHARE, SPLIT_SCHEMA, checkSplit, placeMissing, splitPrompt, splitWithModel, where };
