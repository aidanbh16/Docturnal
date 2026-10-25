'use strict';

// The documentation pass, one folder at a time: one call to the comment model gets a compact
// digest of a folder (file names, exports, imports between its files, and each file's leading
// comment or first line of code) and returns a short summary of the folder and a one-line
// purpose for each file. A call holds only as many files as its prompt and its answer fit the
// context with room to spare, at most MAX_FILES_PER_CALL; a larger folder is split into parts.
// A call whose answer cannot be used is split and tried again (see process.js), and a file no
// answer describes gets a purpose built from its structure, so no file is left out.

const path = require('path');

const ollama = require('./ollama');
const { commentPurpose, fileStructure, structuralSummary, symbolsOf } = require('./structure');

// The instructions, in tokens, and how many characters a token is, counted cautiously.
const PROMPT_TOKENS = 300;
const CHARS_PER_TOKEN = 3;
// What one file may add to a digest.
const MAX_LINE_CHARS = 180;
// The answer: each file's entry ({"name": ..., "purpose": ...}, a purpose of up to 12 words)
// is about 30 tokens, and the folder's summary about 100. Both are counted generously, so an
// answer is never cut off by num_predict.
const TOKENS_PER_FILE_ANSWER = 45;
const SUMMARY_TOKENS = 160;
// The share of the context a call may use, prompt and answer together.
const CONTEXT_SHARE = 0.5;
// At most this many files that need a purpose from the model in one call: a short answer is
// fast, and one the small model gets right. Files whose leading comment gives their purpose
// (commentPurpose) need none, so a call may hold up to MAX_DIGEST_FILES of them for context.
const MAX_FILES_PER_CALL = 10;
const MAX_DIGEST_FILES = 40;

const FOLDER_PROMPT = `You describe one folder of a software project for its documentation, from a digest of each file: its exports, imports, and leading comment or first line of code.

Return:
- summary: one or two sentences on what this folder does in the project, in plain present tense.
- files: for each file marked with *, its name exactly as given and its purpose in at most 10 words, such as "Parses invoice files into records." An empty list when no file is marked. Don't mention yourself or AI.`;

const FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' } }, required: ['name', 'purpose'] } },
  },
  required: ['summary', 'files'],
};

const dirOf = (file) => path.posix.dirname(file);

// needsPurpose: whether the model writes this file's purpose; such a line starts with "*".
function digestLine(file, structure, siblings, needsPurpose = true) {
  const name = path.posix.basename(file);
  const parts = [];
  const names = structure.exports.length ? structure.exports : symbolsOf(structure);
  if (names.length) parts.push(`${structure.exports.length ? 'exports' : 'defines'} ${names.slice(0, 8).join(', ')}`);
  // Imports between files of this folder show how they work together; others by count.
  const local = structure.imports.filter((s) => s.startsWith('.')).map((s) => path.posix.basename(s).replace(/\.\w+$/, ''));
  const inFolder = local.filter((n) => siblings.has(n));
  if (inFolder.length) parts.push(`uses ${[...new Set(inFolder)].slice(0, 6).join(', ')}`);
  const outside = structure.imports.filter((s) => !s.startsWith('.')).slice(0, 5);
  if (outside.length) parts.push(`imports ${outside.join(', ')}`);
  const note = structure.leading || structure.firstLine;
  if (note) parts.push(`"${note.replace(/"/g, "'")}"`);
  return `${needsPurpose ? '*' : '-'} ${name}: ${parts.join('; ') || 'no exports'}`.slice(0, MAX_LINE_CHARS);
}

// The tokens a call with these digest lines needs, prompt and answer together: only the lines
// marked "*" need a purpose in the answer.
function callTokens(lines) {
  const chars = lines.reduce((n, line) => n + line.length + 1, 0);
  const answers = lines.filter((line) => line.startsWith('*')).length;
  return PROMPT_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN) + SUMMARY_TOKENS + answers * TOKENS_PER_FILE_ANSWER;
}

// files: [{ path, text, language }]. Returns the calls to make, in order:
// [{ dir, part, parts, files: [{ path, structure, line }] }].
function planFolderCalls(files, contextTokens) {
  const limit = Math.floor(contextTokens * CONTEXT_SHARE);
  const byDir = new Map();
  for (const file of files) {
    if (!byDir.has(dirOf(file.path))) byDir.set(dirOf(file.path), []);
    byDir.get(dirOf(file.path)).push(file);
  }
  const calls = [];
  for (const [dir, group] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const siblings = new Set(group.map((f) => path.posix.basename(f.path).replace(/\.\w+$/, '')));
    const described = group.map((f) => {
      const structure = fileStructure(f.path, f.text, f.language);
      const purpose = commentPurpose(structure);
      return { path: f.path, structure, purpose, line: digestLine(f.path, structure, siblings, !purpose) };
    });
    const parts = [];
    let current = [];
    for (const file of described) {
      const lines = [...current, file].map((f) => f.line);
      const needing = [...current, file].filter((x) => !x.purpose).length;
      if (current.length && (callTokens(lines) > limit || needing > MAX_FILES_PER_CALL || current.length >= MAX_DIGEST_FILES)) {
        parts.push(current);
        current = [];
      }
      current.push(file);
    }
    if (current.length) parts.push(current);
    parts.forEach((part, i) => calls.push({ dir, part: i + 1, parts: parts.length, files: part }));
  }
  return calls;
}

// The halves of a call whose answer could not be used, to try again.
function splitCall(call) {
  const middle = Math.ceil(call.files.length / 2);
  return [call.files.slice(0, middle), call.files.slice(middle)].map((files) => ({ ...call, files, retry: true }));
}

function callLabel(call) {
  const part = call.parts > 1 && !call.retry ? ` (part ${call.part} of ${call.parts})` : call.retry ? ' (again)' : '';
  return `summary of ${call.dir}${part}, ${call.files.length} ${call.files.length === 1 ? 'file' : 'files'}`;
}

function folderMessages(call) {
  const where = call.dir === '.' ? 'the top level of the project' : `the folder ${call.dir}`;
  const partNote = call.parts > 1 || call.retry ? ' These are some of the folder\'s files.' : '';
  return [
    { role: 'system', content: FOLDER_PROMPT },
    { role: 'user', content: `Files in ${where}.${partNote}\n\n${call.files.map((f) => f.line).join('\n')}` },
  ];
}

// One line of plain text, or null.
function cleanLine(text, max) {
  if (typeof text !== 'string') return null;
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, max) : null;
}

// Why an answer could not be parsed: cut off before its end, or not JSON.
function parseProblem(content) {
  const text = String(content || '').trim();
  if (!text) return 'empty answer';
  return text.startsWith('{') && !text.endsWith('}') ? 'answer cut off before its end' : 'invalid JSON';
}

// The one-line purpose of a file no answer describes, from its structure: its leading comment,
// or its main names, or where it is.
function fallbackPurpose(file, structure) {
  const dir = dirOf(file);
  return structuralSummary(file, structure) || (dir === '.' ? 'A file at the top level of the project.' : `A file in the \`${dir}\` folder.`);
}

// Returns { summary, files: [{ path, summary, symbols }], missing: [path] } for an answer that
// can be used, where missing lists the files it does not describe, or { failed } with the
// reason it cannot be used. Throws when the model does not answer, so the files are left for
// the next run.
async function summarizeFolder({ call, model, contextTokens = 8192, chat = ollama.chat, host }) {
  const content = await chat({
    label: callLabel(call),
    model,
    host,
    messages: folderMessages(call),
    format: FOLDER_SCHEMA,
    // The same context size as every other call, so Ollama does not reload the model.
    options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: SUMMARY_TOKENS + call.files.length * TOKENS_PER_FILE_ANSWER },
  });
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { failed: parseProblem(content) };
  }
  const summary = cleanLine(data && data.summary, 400);
  if (!summary) return { failed: 'no folder summary in the answer' };
  const purposes = new Map();
  for (const entry of Array.isArray(data.files) ? data.files : []) {
    const name = cleanLine(entry && entry.name, 200);
    const purpose = cleanLine(entry && entry.purpose, 200);
    if (name && purpose && !purposes.has(path.posix.basename(name))) purposes.set(path.posix.basename(name), purpose);
  }
  const files = [];
  const missing = [];
  for (const f of call.files) {
    const purpose = f.purpose || purposes.get(path.posix.basename(f.path));
    if (purpose) files.push({ path: f.path, summary: purpose, symbols: symbolsOf(f.structure) });
    else missing.push(f.path);
  }
  if (!files.some((x) => !call.files.find((c) => c.path === x.path).purpose) && call.files.some((c) => !c.purpose)) {
    return { failed: 'no file described in the answer' };
  }
  return { summary, files, missing };
}

module.exports = { FOLDER_SCHEMA, MAX_FILES_PER_CALL, callLabel, callTokens, dirOf, digestLine, fallbackPurpose, folderMessages, planFolderCalls, splitCall, summarizeFolder };
