'use strict';

// Picks the Ollama models for this run. Runs as the first action step and
// writes its choice to GITHUB_OUTPUT so later steps can cache and pull them.

const fs = require('fs');
const os = require('os');

const COMMENT_MODEL = 'qwen2.5-coder:3b';
const DOCS_MODEL = 'qwen2.5-coder:7b';
const FALLBACK_DOCS_MODEL = 'qwen2.5-coder:3b';

// Public-repo runners (16 GB) report about 15.6 GiB; private-repo runners (8 GB) about 7.8 GiB.
// Below this, the docs model is still tried, but it may not load.
const DOCS_MODEL_MIN_GIB = 14;

const GIB = 1024 ** 3;

function parseMemTotal(meminfo) {
  const match = /^MemTotal:\s+(\d+)\s+kB\s*$/m.exec(meminfo);
  if (!match) {
    throw new Error('MemTotal not found in /proc/meminfo');
  }
  return Number(match[1]) * 1024;
}

// Falls back to os.totalmem() where /proc/meminfo does not exist, such as local runs on macOS or Windows.
function readTotalMemory(readFile = fs.readFileSync) {
  try {
    return parseMemTotal(readFile('/proc/meminfo', 'utf8'));
  } catch {
    return os.totalmem();
  }
}

function isAuto(value) {
  const trimmed = (value || '').trim();
  return trimmed === '' || trimmed.toLowerCase() === 'auto';
}

// `model` and `docsModel` are the escape-hatch inputs; anything other than "auto" wins.
// With an Ollama server of your own (ollamaUrl), the runner's memory says nothing about the
// server, so it is not read: the inputs are the settings, with the usual models for "auto".
function selectModels({ totalMemoryBytes, model, docsModel, ollamaUrl = '' }) {
  const external = Boolean((ollamaUrl || '').trim());
  const ramGib = external ? null : totalMemoryBytes / GIB;
  const docsAuto = isAuto(docsModel);
  return {
    ramGib,
    commentModel: isAuto(model) ? COMMENT_MODEL : model.trim(),
    docsModel: docsAuto ? DOCS_MODEL : docsModel.trim(),
    docsMayFallback: !external && docsAuto && ramGib < DOCS_MODEL_MIN_GIB,
    fallbackDocsModel: FALLBACK_DOCS_MODEL,
  };
}

function formatSummary(selection) {
  const fallback = selection.docsMayFallback
    ? ` (may fall back to ${selection.fallbackDocsModel})`
    : '';
  if (selection.ramGib === null) {
    return `Docturnal: Ollama server from ollama-url, comment model ${selection.commentModel}, docs model ${selection.docsModel}`;
  }
  return `Docturnal: RAM ${selection.ramGib.toFixed(1)} GiB, ` +
    `comment model ${selection.commentModel}, docs model ${selection.docsModel}${fallback}`;
}

// Whether this job needs the docs model. A worker of a parallel run whose shard has only
// summaries uses the comment model alone, so it does not pull or load the docs model.
function needsDocsModel(env = process.env) {
  if ((env.INPUT_MODE || 'all') !== 'work' || !env.DOCTURNAL_PLAN) return true;
  try {
    const plan = JSON.parse(fs.readFileSync(env.DOCTURNAL_PLAN, 'utf8'));
    const shard = plan.shards[Number(env.INPUT_SHARD || 0)] || [];
    return shard.some((p) => (plan.items.find((i) => i.path === p) || {}).kind !== 'summary');
  } catch {
    return true;
  }
}

function writeOutputs(selection, outputPath, pullDocsModel = true) {
  const lines = [
    `comment-model=${selection.commentModel}`,
    `docs-model=${selection.docsModel}`,
    `docs-may-fallback=${selection.docsMayFallback}`,
    `fallback-docs-model=${selection.fallbackDocsModel}`,
    `ram-gib=${selection.ramGib === null ? '' : selection.ramGib.toFixed(1)}`,
    `pull-docs-model=${pullDocsModel}`,
  ];
  fs.appendFileSync(outputPath, lines.join('\n') + '\n');
}

function main() {
  const ollamaUrl = process.env.INPUT_OLLAMA_URL || '';
  const selection = selectModels({
    totalMemoryBytes: ollamaUrl.trim() ? null : readTotalMemory(),
    model: process.env.INPUT_MODEL,
    docsModel: process.env.INPUT_DOCS_MODEL,
    ollamaUrl,
  });
  console.log(formatSummary(selection));
  if (process.env.GITHUB_OUTPUT) {
    writeOutputs(selection, process.env.GITHUB_OUTPUT, needsDocsModel());
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  COMMENT_MODEL,
  DOCS_MODEL,
  FALLBACK_DOCS_MODEL,
  DOCS_MODEL_MIN_GIB,
  parseMemTotal,
  readTotalMemory,
  selectModels,
  formatSummary,
  needsDocsModel,
  writeOutputs,
};
