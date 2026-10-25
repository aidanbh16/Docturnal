'use strict';

// The documentation pass, one folder at a time: one call to the comment model gets a compact
// digest of a folder (file names, exports, imports between its files, and each file's leading
// comment or first line of code) and returns a short summary of the folder and a one-line
// purpose for each file. A folder too large for one call is split into parts.

const path = require('path');

const ollama = require('./ollama');
const { fileStructure, structuralSummary, symbolsOf } = require('./structure');

const PROMPT_RESERVE_TOKENS = 700;
const CHARS_PER_TOKEN = 3;
// What one file may add to a digest.
const MAX_LINE_CHARS = 240;
// The answer: about 20 tokens for each file's purpose, plus the folder's summary.
const TOKENS_PER_PURPOSE = 20;
const SUMMARY_TOKENS = 120;
// At most this many files in one call, so the answer stays short and fast.
const MAX_FILES_PER_CALL = 40;

const FOLDER_PROMPT = `You describe one folder of a software project for its documentation. You get a digest of each file: its exports, its imports, and its leading comment or first line of code. You never see or rewrite the code itself.

Return:
- summary: one or two sentences on what this folder does in the project. Plain, precise language in the present tense.
- files: for each file, its name exactly as given and its purpose: one line of at most 12 words, such as "Parses invoice files into records." Don't mention yourself or AI.`;

const FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' } }, required: ['name', 'purpose'] } },
  },
  required: ['summary', 'files'],
};

const dirOf = (file) => path.posix.dirname(file);

function digestLine(file, structure, siblings) {
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
  return `- ${name}: ${parts.join('; ') || 'no exports'}`.slice(0, MAX_LINE_CHARS);
}

// files: [{ path, text, language }]. Returns the calls to make, in order:
// [{ dir, part, parts, files: [{ path, structure, line }] }].
function planFolderCalls(files, contextTokens) {
  const budget = Math.max(2000, (contextTokens - PROMPT_RESERVE_TOKENS - MAX_FILES_PER_CALL * TOKENS_PER_PURPOSE - SUMMARY_TOKENS) * CHARS_PER_TOKEN);
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
      return { path: f.path, structure, line: digestLine(f.path, structure, siblings) };
    });
    const parts = [];
    let current = [];
    let size = 0;
    for (const file of described) {
      if (current.length && (size + file.line.length + 1 > budget || current.length >= MAX_FILES_PER_CALL)) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(file);
      size += file.line.length + 1;
    }
    if (current.length) parts.push(current);
    parts.forEach((part, i) => calls.push({ dir, part: i + 1, parts: parts.length, files: part }));
  }
  return calls;
}

function folderMessages(call) {
  const where = call.dir === '.' ? 'the top level of the project' : `the folder ${call.dir}`;
  const partNote = call.parts > 1 ? ` This is part ${call.part} of ${call.parts} of the folder's files.` : '';
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

// Returns { summary, files: [{ path, summary, symbols, from: 'model' | 'structure' | null }] }
// or { failed } when the reply is unusable. Throws when the model does not answer, so the
// folder is left for the next run.
async function summarizeFolder({ call, model, contextTokens = 8192, chat = ollama.chat, host }) {
  const content = await chat({
    label: `summary of ${call.dir}${call.parts > 1 ? ` (part ${call.part} of ${call.parts})` : ''}, ${call.files.length} ${call.files.length === 1 ? 'file' : 'files'}`,
    model,
    host,
    messages: folderMessages(call),
    format: FOLDER_SCHEMA,
    // The same context size as every other call, so Ollama does not reload the model.
    options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: SUMMARY_TOKENS + call.files.length * TOKENS_PER_PURPOSE },
  });
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { failed: 'no usable summary' };
  }
  const summary = cleanLine(data && data.summary, 400);
  if (!summary) return { failed: 'no usable summary' };
  const purposes = new Map();
  for (const entry of Array.isArray(data.files) ? data.files : []) {
    const name = cleanLine(entry && entry.name, 200);
    const purpose = cleanLine(entry && entry.purpose, 200);
    if (name && purpose && !purposes.has(name)) purposes.set(path.posix.basename(name), purpose);
  }
  return {
    summary,
    files: call.files.map((f) => {
      const purpose = purposes.get(path.posix.basename(f.path));
      const fallback = purpose ? null : structuralSummary(f.path, f.structure);
      return { path: f.path, summary: purpose || fallback, symbols: symbolsOf(f.structure), from: purpose ? 'model' : fallback ? 'structure' : null };
    }),
  };
}

module.exports = { FOLDER_SCHEMA, MAX_FILES_PER_CALL, dirOf, digestLine, folderMessages, planFolderCalls, summarizeFolder };
