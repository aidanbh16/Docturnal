'use strict';

// The summary pass of a first run: one short call per file, with the comment model, for a
// summary and the main symbols only. No comments are proposed. The summaries feed the layer
// documents and the README, so the first pull request documents the whole project.

const { languageForPath } = require('./languages');
const ollama = require('./ollama');

const SUMMARY_PROMPT = `You read one source file and describe it for the project's documentation. You never rewrite code.

Return:
- summary: 1 to 3 sentences on what this code does and its role in the project. Plain, precise language in the present tense. Don't mention yourself or AI.
- symbols: the names of the main functions, classes, components, routes, and exports, at most 20.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, symbols: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'symbols'],
};

// What one call may show: the file's start, cut at a line, within the context budget.
const PROMPT_RESERVE_TOKENS = 1000;
const OUTPUT_RESERVE_TOKENS = 500;
const CHARS_PER_TOKEN = 3;

function excerpt(text, contextTokens) {
  const budget = Math.max(2000, (contextTokens - PROMPT_RESERVE_TOKENS - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN);
  if (text.length <= budget) return { code: text, cut: false };
  const end = text.lastIndexOf('\n', budget);
  return { code: text.slice(0, end > 0 ? end : budget), cut: true };
}

// Returns { summary, symbols }, { skipped } for a file Docturnal does not read, or { failed }
// when the model's answer is unusable: with a fixed seed it would be the same next time.
// Throws when the model does not answer at all, so the file is left for the next run.
async function summarizeFile({ path, text, model, contextTokens = 8192, chat = ollama.chat, host }) {
  const language = languageForPath(path);
  if (!language) return { skipped: 'unsupported language' };
  const { code, cut } = excerpt(text, contextTokens);
  const content = await chat({
    label: `summary of ${path}`,
    model,
    host,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `File: ${path}\nLanguage: ${language.name}\n${cut ? 'The file is longer; this is its start.\n' : ''}\n${code}` },
    ],
    format: SUMMARY_SCHEMA,
    // The same context size as every other call, so Ollama does not reload the model.
    options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: 500 },
  });
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { failed: 'no usable summary' };
  }
  const summary = data && typeof data.summary === 'string' ? data.summary.trim().slice(0, 1000) : '';
  if (!summary) return { failed: 'no usable summary' };
  const symbols = Array.isArray(data.symbols)
    ? data.symbols.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 100)).filter(Boolean).slice(0, 50)
    : [];
  return { summary, symbols };
}

module.exports = { SUMMARY_SCHEMA, summarizeFile };
