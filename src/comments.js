'use strict';

// The comment engine. The model only proposes { line, text, kind } comments; this module
// filters them, enforces the comment level, inserts them, and verifies the result.

const { analyzeLines, splitLines } = require('./analyze');
const { languageForPath } = require('./languages');
const ollama = require('./ollama');
const { verifyCandidates } = require('./verify');

const LEVELS = {
  low: { maxWords: 10, minGap: 15, linesPerComment: 30, blocks: false },
  medium: { maxWords: 25, minGap: 5, linesPerComment: 12, blocks: false },
  heavy: { maxWords: 30, maxBlockWords: 80, minGap: 2, linesPerComment: 5, blocks: true },
  off: null,
};

const LEVEL_GUIDANCE = {
  low: 'Comment level: low. Propose only a few comments, about one per 30 lines, on the most important or surprising code. Each comment is a single line of 10 words or fewer. Always use kind "line".',
  medium: 'Comment level: medium. Propose about one comment per 12 lines. Each comment is a single line of 25 words or fewer. Always use kind "line".',
  heavy: 'Comment level: heavy. Give every function, class, and component a comment of kind "block" on its declaration line, explaining its purpose, inputs, and result in 80 words or fewer, without tags such as @param. Also propose about one comment of kind "line" per 5 lines on non-obvious logic: calculations, loops, edge cases, and magic numbers, each in 30 words or fewer.',
  off: 'Comment level: off. Return an empty comments list.',
};

const SYSTEM_PROMPT = `You review source code and propose comments for it. You never rewrite code.

Each code line is prefixed with its line number and "| ". Line numbers start at 1. For every comment, give:
- line: the number of the code line the comment describes. The comment is placed directly above that line.
- text: the comment text only, without comment markers such as //, #, /*, or *.
- kind: "line" for a single-line comment, or "block" for a multiline comment.

Write like a careful human engineer:
- Explain intent, assumptions, and non-obvious behavior: why the code does something, not what it does.
- Never restate the code or describe its syntax.
- Use plain, precise language in the present tense. No filler, jokes, or emojis.
- Never mention yourself, AI, or that the comment was generated.
- Never write tool directives such as eslint-disable, ts-ignore, noqa, or type: annotations.
- Skip blank lines, existing comments, imports, and closing brackets. Do not comment code that already has a comment.

Also return:
- summary: 1 to 3 sentences on what this code does and its role in the project.
- symbols: the names of the main functions, classes, components, routes, and exports.

If nothing deserves a comment, return an empty comments list.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    symbols: { type: 'array', items: { type: 'string' } },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['line', 'block'] },
        },
        required: ['line', 'text', 'kind'],
      },
    },
  },
  required: ['summary', 'symbols', 'comments'],
};

// The heavy-level follow-up for functions, classes, and components the first pass left
// without a comment.
const BLOCK_PROMPT = `You write documentation comments for functions, classes, and components. You never rewrite code.

Each code line is prefixed with its line number and "| ". Line numbers start at 1. For each declaration listed, return one comment with:
- line: the declaration's line number, exactly as listed.
- text: what the declaration is for, what it takes, and what it returns or does, in 80 words or fewer. Give the comment text only, without comment markers such as //, #, /*, or *, and without tags such as @param.
- kind: "block".

Write like a careful human engineer:
- Explain intent, assumptions, and non-obvious behavior. Never restate the code.
- Use plain, precise language in the present tense. No filler, jokes, or emojis.
- Never mention yourself, AI, or that the comment was generated.
- Never write tool directives such as eslint-disable, ts-ignore, noqa, or type: annotations.`;

const BLOCK_SCHEMA = {
  type: 'object',
  properties: { comments: RESPONSE_SCHEMA.properties.comments },
  required: ['comments'],
};

// Lines shown after each declaration in the follow-up, so the model sees what it documents.
const BLOCK_CONTEXT_LINES = 30;

// Token budget: what is left of the context after the instructions and the model's answer.
const PROMPT_RESERVE_TOKENS = 1000;
const OUTPUT_RESERVE_TOKENS = 1500;
const CHARS_PER_TOKEN = 3;
const MAX_PROMPT_LINE_CHARS = 500;

// Comments that tools read as instructions. Inserting one could change lint, type checking, or builds.
const DIRECTIVE = new RegExp(
  [
    'eslint', 'jshint', 'jslint', 'tslint', 'biome-ignore', 'deno-lint', 'ts-ignore', 'ts-expect-error',
    'ts-nocheck', 'ts-check', '@ts-', 'prettier-ignore', 'istanbul', 'c8\\s+ignore', 'v8\\s+ignore',
    'noqa', 'type\\s*:', 'pragma', 'coding[:=]', 'nolint', 'pylint', 'mypy', 'pyright', 'pyre-',
    'fmt\\s*:\\s*(off|on|skip)', 'isort\\s*:', 'nosec', 'noinspection', 'rubocop', 'phpcs', 'phpstan',
    'psalm-', 'swiftlint', 'ktlint', 'clang-format', 'clang-tidy', 'NOLINT', 'cppcheck', 'coverity',
    '@flow', '@jsx', '@license', '@preserve', '@vite-ignore', 'webpack[A-Z]', '__PURE__', 'sourceMappingURL',
    'sourceURL', '#region', '#endregion', 'go:', '\\+build', 'SPDX-', 'shellcheck', 'frozen_string_literal',
    'vim:', '-\\*-', 'lint:', 'checkstyle', 'SuppressWarnings', 'codecov', 'NOSONAR',
  ].map((d) => `(?<!\\w)${d}`).join('|'),
  'i'
);
const SELF_REFERENCE = /\b(as an AI|AI[- ]generated|generated by (an )?AI|this comment was generated)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

const CLOSING_LINE = /^(?:[}\])]|<\/|\{\s*$|end\b|END\b|fi\b|done\b|esac\b|else\b|elif\b|elsif\b|elseif\b|except\b|finally\b|catch\b|rescue\b|ensure\b)/;
const ENCODING_LINE = /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? { bom: '﻿', body: text.slice(1) } : { bom: '', body: text };
}

function dominantEol(lines) {
  const counts = { '\n': 0, '\r\n': 0, '\r': 0 };
  for (const line of lines) if (line.eol) counts[line.eol]++;
  return Object.keys(counts).reduce((best, eol) => (counts[eol] > counts[best] ? eol : best), '\n');
}

function isMinified(lines) {
  if (!lines.length) return false;
  const total = lines.reduce((sum, line) => sum + line.text.length, 0);
  return lines.some((line) => line.text.length > 1000) || total / lines.length > 200;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function stripMarkers(line) {
  let text = line.trim();
  let previous;
  do {
    previous = text;
    text = text
      .replace(/^(\/\*+|\*+\/|\*+|\/\/+|#+|--+|<!--|-->|"""|'''|[|^$>!]+)\s*/, '')
      .replace(/\s*(\*+\/|-->|"""|''')$/, '')
      .replace(/\\+$/, '')
      .trim();
  } while (text !== previous);
  return text;
}

// Turns model text into clean paragraphs, or returns { reason } when it must be rejected.
function cleanText(raw, language) {
  if (typeof raw !== 'string') return { reason: 'text is not a string' };
  const normalized = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, ' ');
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map(stripMarkers).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => p.replace(/\*\//g, '*\\/'));
  const joined = paragraphs.join(' ');
  if (!joined) return { reason: 'empty text' };
  if (DIRECTIVE.test(joined)) return { reason: 'tool directive' };
  if (SELF_REFERENCE.test(joined)) return { reason: 'mentions AI' };
  if (EMOJI.test(joined)) return { reason: 'emoji' };
  // "?>" ends PHP mode even inside a // comment.
  if (language.phpTags && joined.includes('?>')) return { reason: 'contains ?>' };
  // JSDoc tags such as @type change type checking in JavaScript.
  if (language.blockStyle === 'jsdoc' && /(^|[\s{])@[A-Za-z]/.test(joined)) return { reason: 'JSDoc tag' };
  return { paragraphs, joined };
}

function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatComment(language, kind, paragraphs, indent) {
  if (kind === 'line') {
    const text = paragraphs.join(' ');
    return [language.lineComment ? `${indent}${language.lineComment} ${text}` : `${indent}/* ${text} */`];
  }
  const indentWidth = indent.replace(/\t/g, '    ').length;
  const width = Math.max(40, 80 - indentWidth - 3);
  const body = [];
  paragraphs.forEach((p, i) => {
    if (i > 0) body.push('');
    body.push(...wrap(p, width));
  });
  if (language.blockStyle === 'jsdoc' || language.blockStyle === 'cblock') {
    const open = language.blockStyle === 'jsdoc' ? '/**' : '/*';
    return [`${indent}${open}`, ...body.map((b) => (b ? `${indent} * ${b}` : `${indent} *`)), `${indent} */`];
  }
  return body.map((b) => (b ? `${indent}${language.lineComment} ${b}` : `${indent}${language.lineComment}`));
}

// Lines at the top that must stay first: a shebang, and encoding declarations in Python and Ruby.
function protectedHeadLines(lines, language) {
  let protectedUntil = 0;
  if (lines[0] && lines[0].text.startsWith('#!')) protectedUntil = 1;
  if (language.encodingLine) {
    for (let n = 1; n <= Math.min(2, lines.length); n++) {
      if (ENCODING_LINE.test(lines[n - 1].text)) protectedUntil = n;
    }
  }
  return protectedUntil;
}

function phpIsSafe(lines) {
  const firstCode = lines.find((line) => line.text.trim() !== '');
  if (!firstCode || !firstCode.text.trimStart().startsWith('<?php')) return false;
  // A closing tag anywhere but at the very end means the file mixes PHP with HTML.
  const body = lines.map((line) => line.text).join('\n').trimEnd();
  const close = body.indexOf('?>');
  return close === -1 || close === body.length - 2;
}

function previousNonBlank(info, index) {
  for (let i = index - 1; i >= 0; i--) if (!info[i].blank) return i;
  return -1;
}

function resolveTarget(line, lines, analysis, language) {
  let target = analysis.decoratorTarget.get(line) || line;
  if (language.annotation) {
    while (target > 1 && language.annotation.test(lines[target - 2].text.trim())) target--;
  }
  return target;
}

function placementProblem(target, lines, analysis, protectedUntil) {
  const index = target - 1;
  const info = analysis.info[index];
  const trimmed = lines[index].text.trim();
  if (target <= protectedUntil) return 'shebang or encoding line';
  if (info.blank) return 'blank line';
  if (info.unsafeStart) return 'inside a string, template literal, JSX, or block comment';
  if (info.commentOnly) return 'existing comment';
  if (info.isImport) return 'import';
  if (CLOSING_LINE.test(trimmed)) return 'closing bracket';
  const previous = previousNonBlank(analysis.info, index);
  if (previous >= 0 && analysis.info[previous].commentOnly) return 'previous line is a comment';
  return null;
}

// Where existing comments sit: a run of comment lines documents the line after it,
// and a trailing comment documents its own line. A file header, a comment run before the
// first code line and followed by a blank line, documents the file instead, so it does not
// count toward the level or the gap between comments. With exemptDeclarations (heavy level),
// neither does a comment on a declaration, since block comments there are not limited.
function existingCommentPositions(info, exemptDeclarations) {
  const positions = [];
  let start = 0;
  while (start < info.length && info[start].blank) start++;
  if (start < info.length && info[start].commentOnly) {
    let end = start;
    while (end + 1 < info.length && info[end + 1].commentOnly) end++;
    if (end + 1 < info.length && info[end + 1].blank) start = end + 1;
    else start = 0;
  } else {
    start = 0;
  }
  for (let i = start; i < info.length; i++) {
    if (info[i].commentOnly) {
      let end = i;
      while (end + 1 < info.length && info[end + 1].commentOnly) end++;
      positions.push(end + 2);
      i = end;
    } else if (info[i].hasComment) {
      positions.push(i + 1);
    }
  }
  return exemptDeclarations ? positions.filter((pos) => !(info[pos - 1] && info[pos - 1].isDeclaration)) : positions;
}

function render(lines, insertions, eol, bom) {
  const byTarget = new Map(insertions.map((ins) => [ins.target, ins]));
  const out = [];
  const inserted = [];
  lines.forEach((line, i) => {
    const ins = byTarget.get(i + 1);
    if (ins) {
      for (const commentLine of ins.commentLines) {
        inserted.push(out.length);
        out.push(commentLine + eol);
      }
    }
    out.push(line.text + line.eol);
  });
  return { text: bom + out.join(''), inserted };
}

// What happens to each proposal, by category. The PR body and the log count these.
const CATEGORY = {
  placement: /^(line out of range|shebang|blank line|inside a string|existing comment|import|closing bracket|previous line is a comment|duplicate line)/,
  length: /^(longer than|block comment longer than)/,
  density: /^(level limit reached|within \d+ lines of another comment)/,
  off: /^comment level is off/,
};

function categoryOf(reason) {
  for (const [category, re] of Object.entries(CATEGORY)) if (re.test(reason)) return category;
  // Everything else protects the code or the text: verification, directives, AI mentions, and so on.
  return 'safety';
}

function emptyStats(proposed) {
  return { proposed, added: 0, lineShift: 0, dropped: { placement: {}, length: {}, density: {}, safety: {}, off: {} } };
}

function result(text, added, rejections, stats, undocumented = []) {
  for (const r of rejections) {
    const bucket = stats.dropped[r.category];
    bucket[r.reason] = (bucket[r.reason] || 0) + 1;
  }
  stats.added = added;
  return { text, added, rejected: rejections.length, rejections, stats, undocumented };
}

function hasLine(proposal) {
  return proposal !== null && typeof proposal === 'object' && Number.isInteger(proposal.line);
}

// Small models sometimes count lines from 0. Within one model response, line numbers are
// read as zero-based only on clear evidence: one of them is 0, or there are at least two,
// none can take a comment as given, and all can after adding 1. Anything else keeps the
// numbers as given, so a comment never moves onto a line it was not written for.
// Returns the shift to add: 0 or 1.
function lineShiftFor(group, isPlaceable) {
  const numbered = group.filter(hasLine);
  if (!numbered.length) return 0;
  if (numbered.some((p) => p.line === 0)) return 1;
  if (numbered.length < 2) return 0;
  const noneFit = numbered.every((p) => !isPlaceable(p.line));
  const allFitShifted = numbered.every((p) => isPlaceable(p.line + 1));
  return noneFit && allFitShifted ? 1 : 0;
}

// Filters, limits, inserts, and verifies proposals for one file.
// proposals: [{ line, text, kind }], or groups: one array of proposals per model response.
// Returns { text, added, rejected, rejections, stats }, where stats counts the proposals
// and what happened to them, and never holds comment text.
function applyProposals({ text, language, level, proposals, groups = [proposals] }) {
  const rules = LEVELS[level];
  const all = groups.flat();
  const stats = emptyStats(all.length);
  const rejections = [];
  const reject = (proposal, reason) =>
    rejections.push({ line: hasLine(proposal) ? proposal.line : undefined, reason, category: categoryOf(reason) });
  const rejectAll = (reason) => {
    all.forEach((p) => reject(p, reason));
    return result(text, 0, rejections, stats);
  };

  if (!rules) return rejectAll('comment level is off');
  // Heavy level still looks for undocumented functions when the model proposed nothing.
  if (!all.length && !rules.blocks) return result(text, 0, rejections, stats);

  const { bom, body } = stripBom(text);
  const lines = splitLines(body);
  if (language.phpTags && !phpIsSafe(lines)) return rejectAll('PHP file mixes code with HTML');
  const analysis = analyzeLines(body, lines, language);
  if (!analysis.ok) return rejectAll(`cannot analyze file: ${analysis.error}`);

  const protectedUntil = protectedHeadLines(lines, language);
  // A shebang or encoding line looks like a comment but documents nothing, so it does not
  // count toward the level or block the line after it.
  for (let i = 0; i < protectedUntil; i++) {
    analysis.info[i].commentOnly = false;
    analysis.info[i].hasComment = false;
  }
  const isPlaceable = (line) => line >= 1 && line <= lines.length &&
    !placementProblem(resolveTarget(line, lines, analysis, language), lines, analysis, protectedUntil);
  const aligned = [];
  for (const group of groups) {
    const shift = lineShiftFor(group, isPlaceable);
    if (shift) stats.lineShift += group.filter(hasLine).length;
    aligned.push(...group.map((p) => (shift && hasLine(p) ? { ...p, line: p.line + shift } : p)));
  }

  const candidates = [];
  const seenTargets = new Set();
  for (const proposal of aligned) {
    if (!hasLine(proposal) || proposal.line < 1 || proposal.line > lines.length) {
      reject(proposal, 'line out of range');
      continue;
    }
    const target = resolveTarget(proposal.line, lines, analysis, language);
    const problem = placementProblem(target, lines, analysis, protectedUntil);
    if (problem) {
      reject(proposal, problem);
      continue;
    }
    const cleaned = cleanText(proposal.text, language);
    if (cleaned.reason) {
      reject(proposal, cleaned.reason);
      continue;
    }
    // At heavy level, every comment on a declaration is a block comment, whatever kind the
    // model gave it.
    let kind = 'line';
    if (rules.blocks && analysis.info[target - 1].isDeclaration) {
      kind = 'block';
      if (wordCount(cleaned.joined) > rules.maxBlockWords) {
        reject(proposal, `block comment longer than ${rules.maxBlockWords} words`);
        continue;
      }
    } else if (wordCount(cleaned.joined) > rules.maxWords) {
      reject(proposal, `longer than ${rules.maxWords} words`);
      continue;
    }
    if (seenTargets.has(target)) {
      reject(proposal, 'duplicate line');
      continue;
    }
    seenTargets.add(target);
    candidates.push({
      proposal,
      target,
      kind,
      declaration: analysis.info[target - 1].isDeclaration,
      paragraphs: kind === 'block' ? cleaned.paragraphs : [cleaned.joined],
    });
  }

  // Functions, classes, and components that heavy level wants a block comment on, and that
  // have none yet. finish() reports the ones still without a comment after this pass.
  const symbols = rules.blocks
    ? analysis.info.flatMap((li, i) => {
      if (!li.symbol) return [];
      const target = resolveTarget(i + 1, lines, analysis, language);
      return placementProblem(target, lines, analysis, protectedUntil) ? [] : [{ line: i + 1, target, name: li.symbol }];
    })
    : [];
  const finish = (newText, kept) => {
    const documented = new Set(kept.map((c) => c.target));
    const undocumented = symbols.filter((s) => !documented.has(s.target)).map(({ line, name }) => ({ line, name }));
    return result(newText, kept.length, rejections, stats, undocumented);
  };

  // Existing comments count toward the level's limits, so re-runs do not pile up comments.
  // Every file may have at least one comment, so a short file with a function can get one.
  // Only line comments are limited: a block comment above a declaration never counts toward
  // the level or the gap, and is never dropped by them.
  const codeLines = analysis.info.filter((li) => !li.blank && !li.commentOnly).length;
  const allowed = Math.max(1, Math.round(codeLines / rules.linesPerComment));
  const taken = existingCommentPositions(analysis.info, rules.blocks);
  let budget = allowed - taken.length;
  // Block comments first, then comments on functions and classes, then the rest, each in
  // file order, so a limited budget goes to declarations.
  const rank = (c) => (c.kind === 'block' ? 0 : c.declaration ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b) || a.target - b.target);
  const accepted = [];
  for (const candidate of candidates) {
    if (candidate.kind === 'block') {
      accepted.push(candidate);
      continue;
    }
    if (budget <= 0) {
      reject(candidate.proposal, 'level limit reached');
      continue;
    }
    if (taken.some((pos) => Math.abs(pos - candidate.target) < rules.minGap)) {
      reject(candidate.proposal, `within ${rules.minGap} lines of another comment`);
      continue;
    }
    taken.push(candidate.target);
    accepted.push(candidate);
    budget--;
  }
  if (!accepted.length) return finish(text, []);

  const eol = dominantEol(lines);
  const insertionFor = (c) => ({
    target: c.target,
    commentLines: formatComment(language, c.kind, c.paragraphs, lines[c.target - 1].text.match(/^[ \t]*/)[0]),
  });
  const renderSet = (set) => render(lines, set.map(insertionFor), eol, bom);

  const full = renderSet(accepted);
  if (verifyCandidates(language, text, [full])[0]) return finish(full.text, accepted);

  // The full set failed, so test each comment alone and keep only those that pass.
  const singles = accepted.map((c) => renderSet([c]));
  const passed = verifyCandidates(language, text, singles);
  const kept = accepted.filter((c, i) => {
    if (!passed[i]) reject(c.proposal, 'verification failed');
    return passed[i];
  });
  if (!kept.length) return finish(text, []);
  const combined = renderSet(kept);
  if (!verifyCandidates(language, text, [combined])[0]) {
    kept.forEach((c) => reject(c.proposal, 'verification failed in combination'));
    return finish(text, []);
  }
  return finish(combined.text, kept);
}

function numberedLine(lines, i) {
  const text = lines[i].text;
  return `${i + 1}| ${text.length > MAX_PROMPT_LINE_CHARS ? `${text.slice(0, MAX_PROMPT_LINE_CHARS)}...` : text}`;
}

// Splits the file into windows of whole lines that fit the context budget, preferring to
// break at a blank line.
function buildWindows(lines, contextTokens) {
  const budget = Math.max(2000, (contextTokens - PROMPT_RESERVE_TOKENS - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN);
  const windows = [];
  let start = 0;
  while (start < lines.length) {
    let size = 0;
    let end = start;
    let lastBlank = -1;
    while (end < lines.length) {
      const length = numberedLine(lines, end).length + 1;
      if (end > start && size + length > budget) break;
      size += length;
      if (lines[end].text.trim() === '') lastBlank = end;
      end++;
    }
    if (end < lines.length && lastBlank > start + (end - start) / 2) end = lastBlank + 1;
    windows.push({ start, end });
    start = end;
  }
  return windows;
}

function buildMessages({ path, language, level, lines, window, index, count }) {
  const numbered = [];
  for (let i = window.start; i < window.end; i++) numbered.push(numberedLine(lines, i));
  const part = count > 1
    ? `Part ${index + 1} of ${count}: lines ${window.start + 1} to ${window.end} of ${lines.length}.\n`
    : '';
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${LEVEL_GUIDANCE[level]}` },
    { role: 'user', content: `File: ${path}\nLanguage: ${language.name}\n${part}\n${numbered.join('\n')}` },
  ];
}

// The follow-up request: the declarations by name and line, and the code from each one on,
// as many as fit the context budget.
function buildBlockMessages({ path, language, lines, missing, contextTokens }) {
  const budget = Math.max(2000, (contextTokens - PROMPT_RESERVE_TOKENS - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN);
  const shown = new Set();
  const asked = [];
  let size = 0;
  for (const declaration of missing) {
    const extra = [];
    for (let i = declaration.line - 1; i < Math.min(lines.length, declaration.line - 1 + BLOCK_CONTEXT_LINES); i++) {
      if (!shown.has(i)) extra.push(i);
    }
    const length = extra.reduce((sum, i) => sum + numberedLine(lines, i).length + 1, 0);
    if (asked.length && size + length > budget) break;
    size += length;
    extra.forEach((i) => shown.add(i));
    asked.push(declaration);
  }
  const code = [];
  let previous = -2;
  for (const i of [...shown].sort((a, b) => a - b)) {
    if (i !== previous + 1 && code.length) code.push('...');
    code.push(numberedLine(lines, i));
    previous = i;
  }
  const list = asked.map((d) => `- line ${d.line}: ${d.name}`).join('\n');
  return {
    asked,
    messages: [
      { role: 'system', content: BLOCK_PROMPT },
      {
        role: 'user',
        content: `File: ${path}\nLanguage: ${language.name}\n\nWrite a block comment for each of these declarations:\n${list}\n\nCode:\n${code.join('\n')}`,
      },
    ],
  };
}

function parseResponse(content) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object') throw new Error('response is not an object');
  return {
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    symbols: Array.isArray(data.symbols)
      ? data.symbols.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 100)).filter(Boolean)
      : [],
    comments: Array.isArray(data.comments) ? data.comments : [],
  };
}

// Comments one file. `chat` defaults to the local Ollama client and is replaceable for tests.
// Returns { path, language, summary, symbols, text, added, rejected, rejections, failedWindows, errors }.
async function commentFile({ path, text, level = 'medium', model, contextTokens = 8192, chat = ollama.chat, host }) {
  const language = languageForPath(path);
  const base = { path, language: language && language.id, summary: '', symbols: [], text, added: 0, rejected: 0, rejections: [], stats: emptyStats(0), failedWindows: 0, errors: [] };
  if (!language) return { ...base, skipped: 'unsupported language' };
  const lines = splitLines(stripBom(text).body);
  if (isMinified(lines)) return { ...base, skipped: 'minified' };

  const windows = buildWindows(lines, contextTokens);
  const summaries = [];
  const symbols = new Set();
  const groups = [];
  for (const [index, window] of windows.entries()) {
    try {
      const content = await chat({
        model,
        host,
        messages: buildMessages({ path, language, level, lines, window, index, count: windows.length }),
        format: RESPONSE_SCHEMA,
        options: { temperature: 0.2, seed: 42, num_ctx: contextTokens },
      });
      const parsed = parseResponse(content);
      if (parsed.summary) summaries.push(parsed.summary);
      parsed.symbols.forEach((s) => symbols.add(s));
      groups.push(parsed.comments);
    } catch (err) {
      base.failedWindows++;
      base.errors.push(`lines ${window.start + 1}-${window.end}: ${err.message}`);
    }
  }

  let applied = applyProposals({ text, language, level, groups });
  // Heavy level: one follow-up request for the functions, classes, and components that still
  // have no comment above them. Skipped when the model answered nothing at all.
  if (applied.undocumented.length && groups.length) {
    const { messages } = buildBlockMessages({ path, language, lines, missing: applied.undocumented, contextTokens });
    try {
      const content = await chat({
        model,
        host,
        messages,
        format: BLOCK_SCHEMA,
        options: { temperature: 0.2, seed: 42, num_ctx: contextTokens },
      });
      groups.push(parseResponse(content).comments);
      applied = applyProposals({ text, language, level, groups });
    } catch (err) {
      base.errors.push(`block comments: ${err.message}`);
    }
  }
  return {
    ...base,
    summary: summaries.join(' ').slice(0, 1000),
    symbols: [...symbols].slice(0, 50),
    ...applied,
  };
}

module.exports = {
  CATEGORY,
  LEVELS,
  RESPONSE_SCHEMA,
  applyProposals,
  buildWindows,
  cleanText,
  commentFile,
};
