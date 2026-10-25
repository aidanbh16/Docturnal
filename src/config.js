'use strict';

// Reads the action inputs from INPUT_* environment variables and validates them.

const path = require('path');

const COMMENT_LEVELS = ['low', 'medium', 'heavy', 'off'];
const EXISTING_CODE = ['gradual', 'none'];
const MODES = ['all', 'plan', 'work', 'finish', 'cleanup'];

class ConfigError extends Error {}

function readInput(env, name, fallback) {
  const value = (env[`INPUT_${name}`] || '').trim();
  return value === '' ? fallback : value;
}

// Accepts commas or newlines, so users can write either style in the workflow file.
function readList(env, name) {
  return readInput(env, name, '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInt(env, name, inputName, fallback) {
  const raw = readInput(env, name, String(fallback));
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new ConfigError(`Invalid ${inputName} "${raw}". Use a whole number greater than 0.`);
  }
  return Number(raw);
}

function readChoice(env, name, inputName, choices, fallback) {
  const raw = readInput(env, name, fallback).toLowerCase();
  if (!choices.includes(raw)) throw new ConfigError(`Invalid ${inputName} "${raw}". Use one of: ${choices.join(', ')}.`);
  return raw;
}

function readWholeNumber(env, name, inputName, fallback) {
  const raw = readInput(env, name, String(fallback));
  if (!/^\d+$/.test(raw)) throw new ConfigError(`Invalid ${inputName} "${raw}". Use a whole number.`);
  return Number(raw);
}

function readBoolean(env, name, inputName, fallback) {
  const raw = readInput(env, name, String(fallback)).toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new ConfigError(`Invalid ${inputName} "${raw}". Use true or false.`);
  return raw === 'true';
}

// Keeps paths inside the repo: no absolute paths and no ".." segments.
function readRepoPath(env, name, inputName, fallback) {
  const raw = readInput(env, name, fallback);
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new ConfigError(`Invalid ${inputName} "${raw}". Use a path relative to the repository root.`);
  }
  return normalized;
}

function readConfig(env = process.env) {
  const commentLevel = readInput(env, 'COMMENT_LEVEL', 'medium').toLowerCase();
  if (!COMMENT_LEVELS.includes(commentLevel)) {
    throw new ConfigError(
      `Invalid comment-level "${commentLevel}". Use one of: ${COMMENT_LEVELS.join(', ')}.`
    );
  }

  return {
    commentLevel,
    docsDir: readRepoPath(env, 'DOCS_DIR', 'docs-dir', 'docs'),
    path: readRepoPath(env, 'PATH', 'path', '.'),
    exclude: readList(env, 'EXCLUDE'),
    extensions: readList(env, 'EXTENSIONS').map((ext) => ext.replace(/^\./, '').toLowerCase()),
    contextTokens: readPositiveInt(env, 'CONTEXT_TOKENS', 'context-tokens', 8192),
    timeBudgetMinutes: readPositiveInt(env, 'TIME_BUDGET_MINUTES', 'time-budget-minutes', 90),
    model: readInput(env, 'MODEL', 'auto'),
    docsModel: readInput(env, 'DOCS_MODEL', 'auto'),
    selectedCommentModel: readInput(env, 'SELECTED_COMMENT_MODEL', null),
    selectedDocsModel: readInput(env, 'SELECTED_DOCS_MODEL', null),
    docsMayFallback: readInput(env, 'DOCS_MAY_FALLBACK', 'false') === 'true',
    fallbackDocsModel: readInput(env, 'FALLBACK_DOCS_MODEL', null),
    // Docturnal for teams, without the app: open the pull request from the Action.
    openPr: readBoolean(env, 'OPEN_PR', 'open-pr', false),
    githubToken: readInput(env, 'GITHUB_TOKEN', ''),
    // Docturnal for teams: an Ollama server of your own instead of one on the runner.
    ollamaUrl: readInput(env, 'OLLAMA_URL', ''),
    // Existing code: comment it in small batches ("gradual"), or only new and changed code.
    existingCode: readChoice(env, 'EXISTING_CODE', 'existing-code', EXISTING_CODE, 'gradual'),
    backlogBatchSize: readPositiveInt(env, 'BACKLOG_BATCH_SIZE', 'backlog-batch-size', 15),
    // Which part of a run this job does: all of it, or the plan, one shard of work, or the
    // finish of a parallel run.
    mode: readChoice(env, 'MODE', 'mode', MODES, 'all'),
    shard: readWholeNumber(env, 'SHARD', 'shard', 0),
    // 0: decide from the repository, 8 jobs for a public one and 2 for a private one.
    maxJobs: readWholeNumber(env, 'MAX_JOBS', 'max-jobs', 0),
    // The job's timeout-minutes, when the workflow passes it, to check the time budget's margin.
    jobTimeoutMinutes: readWholeNumber(env, 'JOB_TIMEOUT_MINUTES', 'job-timeout-minutes', 0),
  };
}

module.exports = { COMMENT_LEVELS, EXISTING_CODE, MODES, ConfigError, readConfig };
