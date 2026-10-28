'use strict';

// The comment engine. The model only proposes { line, anchor, text, kind } comments; this
// module places each one above the line its anchor names, filters them, enforces the comment
// level, has them checked for accuracy, inserts them, and verifies the result. Comments
// Docturnal wrote on earlier runs (see owned.js) are taken out first and compete with the
// new proposals, so they can be kept, restyled for the level, replaced, or removed.

const { buildAccuracyMessages, ACCURACY_SCHEMA, codeUnder, parseVerdicts } = require('./accuracy');
const { analyzeLines, splitLines } = require('./analyze');
const { languageForPath } = require('./languages');
const ollama = require('./ollama');
const { hasUnknownUrl } = require('./links');

// A comment with a web link the repository does not already have.
const LINK_NOT_FOUND = 'link not found in the repository';
const { findOwned, recordFor } = require('./owned');
const { restatement, restates } = require('./restates');
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
  heavy: 'Comment level: heavy. Give every function, class, and component a comment of kind "block" on its declaration line, explaining its purpose, inputs, and result in 80 words or fewer, without tags such as @param. Give every constant and magic number a short comment of kind "line" on what it means and its unit. Also propose about one comment of kind "line" per 5 lines on non-obvious logic: calculations, loops, edge cases, and magic numbers, each in 30 words or fewer.',
  off: 'Comment level: off. Return an empty comments list.',
};

const SYSTEM_PROMPT = `You review source code and propose comments for it. You never rewrite code.

Each code line is prefixed with its line number and "| ". Line numbers start at 1. For every comment, give:
- line: the number of the code line the comment describes. The comment is placed directly above that line.
- anchor: the exact text of that code line, without its line number and without leading spaces. The comment is placed above the line with this text, so copy it exactly.
- text: the comment text only, without comment markers such as //, #, /*, or *.
- kind: "line" for a single-line comment, or "block" for a multiline comment.

Write like a careful human engineer:
- Explain why: intent, constraints, units, assumptions, and edge cases that a reader cannot see from the code alone.
- Never narrate what the syntax already says, such as "loops over the items", "returns the result", or "calls the function".
- Bad: "Loops over brackets." Good: "Each bracket's upTo is that bracket's width, not a running total."
- A comment describes only the line it sits above and the code that belongs to it, never a neighboring statement or another function.
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
          anchor: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['line', 'block'] },
        },
        required: ['line', 'anchor', 'text', 'kind'],
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
- anchor: the exact text of that line, without its line number and without leading spaces.
- text: what the declaration is for, what it takes, and what it returns or does, in 80 words or fewer. Give the comment text only, without comment markers such as //, #, /*, or *, and without tags such as @param.
- kind: "block".

Write like a careful human engineer:
- Explain why: intent, constraints, units, assumptions, and edge cases. Never narrate what the syntax already says.
- Describe only the listed declaration, never a neighboring one.
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

// How far from the given line number a proposal's anchor is looked for.
const ANCHOR_WINDOW = 5;

// Line comments longer than this are wrapped onto more comment lines.
const LINE_COMMENT_WIDTH = 100;

// Token budget: what is left of the context after the instructions and the model's answer.
// The answer's room is also its num_predict, so a reply can never run past the context,
// where Ollama would drop the start of the prompt and the model would lose the code.
const PROMPT_RESERVE_TOKENS = 1000;
const OUTPUT_RESERVE_TOKENS = 2000;
const CHARS_PER_TOKEN = 3;
const MAX_PROMPT_LINE_CHARS = 500;
// An answer's summary and symbols, and each proposal in it, in tokens, counted generously.
const SUMMARY_TOKENS = 300;
const TOKENS_PER_PROPOSAL = 70;
// The most comments one request asks for: as many as its answer has room for.
const MAX_PROPOSALS = Math.floor((OUTPUT_RESERVE_TOKENS - SUMMARY_TOKENS) / TOKENS_PER_PROPOSAL);

const SYNTAX_ERRORS = 'the file has syntax errors';

const MODEL_OPTIONS = (contextTokens) => ({ temperature: 0.2, seed: 42, num_ctx: contextTokens });

// The accuracy check sends at most this many comments per request. Its answer is only a few
// yes or no verdicts per comment, so it may be short.
const ACCURACY_BATCH = 8;
const ACCURACY_PREDICT_TOKENS = 384;

// In tokens (see lineTokens).
function promptBudget(contextTokens) {
  return Math.max(700, contextTokens - PROMPT_RESERVE_TOKENS - OUTPUT_RESERVE_TOKENS);
}

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
  return text.charCodeAt(0) === 0xfeff ? { bom: '\uFEFF', body: text.slice(1) } : { bom: '', body: text };
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
  // Invisible and direction characters can make a line read differently from what it does.
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(joined)) return { reason: 'invisible or text-direction characters' };
  // In C and C++, the trigraph ??/ is a backslash under older standards, and at the end of a
  // line comment it would join the next line of code to the comment.
  if ((language.id === 'c' || language.id === 'cpp') && joined.includes('??/')) return { reason: 'contains ??/' };
  // "?>" ends PHP mode even inside a // comment.
  if (language.phpTags && joined.includes('?>')) return { reason: 'contains ?>' };
  // JSDoc tags such as @type change type checking in JavaScript.
  if (language.blockStyle === 'jsdoc' && /(^|[\s{])@[A-Za-z]/.test(joined)) return { reason: 'JSDoc tag' };
  return { paragraphs, joined };
}

// Wraps text at width, then narrows the width as far as the line count allows, so the lines
// come out even and the last one is not left with a single short word.
function wrap(text, width) {
  const greedy = wrapGreedy(text, width);
  if (greedy.length < 2) return greedy;
  let lo = 1;
  let hi = width;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (wrapGreedy(text, mid).length <= greedy.length) hi = mid;
    else lo = mid + 1;
  }
  return wrapGreedy(text, lo);
}

function wrapGreedy(text, width) {
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
  const indentWidth = indent.replace(/\t/g, '    ').length;
  // A line comment longer than LINE_COMMENT_WIDTH continues on more comment lines.
  if (kind === 'line') {
    const text = paragraphs.join(' ');
    const [open, close] = language.lineComment ? [`${language.lineComment} `, ''] : ['/* ', ' */'];
    const parts = wrap(text, Math.max(40, LINE_COMMENT_WIDTH - indentWidth - open.length - close.length));
    return parts.map((part) => `${indent}${open}${part}${close}`);
  }
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
  placement: /^(line out of range|shebang|blank line|inside a string|existing comment|import|closing bracket|previous line is a comment|duplicate line|kept the earlier comment)/,
  anchor: /^anchor not found/,
  length: /^(longer than|block comment longer than)/,
  density: /^(level limit reached|within \d+ lines of another comment)/,
  inaccurate: /^inaccurate/,
  restates: /^(restates the code|repeats the function comment)/,
  off: /^comment level is off/,
};

function categoryOf(reason) {
  for (const [category, re] of Object.entries(CATEGORY)) if (re.test(reason)) return category;
  // Everything else protects the code or the text: verification, directives, AI mentions, and so on.
  return 'safety';
}

// proposed and dropped count the model's proposals. earlier counts the comments Docturnal
// wrote on earlier runs: kept (restyled when their form changed for the level) or removed.
// How proposals' anchors were matched: exactly, after fixes (counted by category, a proposal
// may need several), or not at all (by category).
function emptyAnchors() {
  return { exact: 0, fixed: {}, missed: {} };
}

function emptyStats(proposed, anchors = emptyAnchors()) {
  return {
    proposed,
    anchors,
    added: 0,
    dropped: { placement: {}, anchor: {}, length: {}, density: {}, inaccurate: {}, restates: {}, safety: {}, off: {} },
    earlier: { kept: 0, restyled: 0, removed: {} },
  };
}

function isProposal(proposal) {
  return proposal !== null && typeof proposal === 'object';
}

// Anchors are compared with runs of spaces collapsed.
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// The forms of an anchor a small model gives for one line: copied with the prompt's line
// number ("12| ", "12:", "L12"), with spaces, quotes, or a trailing semicolon or comma that
// differ, cut short (ending in "..." or not), or with the lines after it. Each mismatch
// category is counted for the log; the anchor's text never is.
const ANCHOR_FIXES = {
  prefix: 'contains a line-number prefix',
  lines: 'spans several lines',
  loose: 'whitespace or quote differences only',
  truncated: 'truncated or ends with ...',
  near: 'matches a line more than 5 lines away',
  window: 'matches a line more than 15 lines away',
};
const ANCHOR_MISSES = {
  empty: 'is empty or not text',
  ambiguous: 'matches several lines',
  outside: 'matches only a line outside its part of the file',
  none: 'matches no line at all',
};
const LINE_NUMBER_PREFIX = /^\s*(?:line\s+)?L?\d+\s*(?:\||:(?!:)|\.(?=\s))\s?/i;
const ELLIPSIS = /\s*(?:\.\.\.|…)\s*$/;
// A cut-short anchor must keep this many characters (spaces aside) to stand for its line.
const MIN_PREFIX_CHARS = 20;
// Tolerant matches are looked for this far from the given line, and must be unique there.
const ANCHOR_NEAR = 15;

// Spaces removed, quotes made alike, and a trailing semicolon or comma dropped.
function loose(text) {
  return text.replace(/[‘’“”"`]/g, "'").replace(/\s+/g, '').replace(/[;,]+$/, '');
}

// The anchor's readings, the plainest first: [{ exact, loose, truncated, fixes }].
function anchorReadings(anchor) {
  const firstLine = anchor.split(/\r\n?|\n/).find((l) => l.trim() !== '') || '';
  const readings = [];
  const add = (text, fixes) => {
    const cut = ELLIPSIS.test(text) && text.replace(ELLIPSIS, '').trim() !== '';
    const body = cut ? text.replace(ELLIPSIS, '') : text;
    if (!collapse(body)) return;
    readings.push({ exact: collapse(body), loose: loose(body), cut, fixes });
  };
  const multi = firstLine.trim() !== anchor.trim();
  const base = multi ? [ANCHOR_FIXES.lines] : [];
  add(firstLine, base);
  const unnumbered = firstLine.replace(LINE_NUMBER_PREFIX, '');
  if (unnumbered !== firstLine) add(unnumbered, [...base, ANCHOR_FIXES.prefix]);
  return readings;
}

// How well a line fits a reading: 3 exactly, 2 apart from spaces and quotes, 1 as a cut-short
// start of the line; 0 not at all. Prompt lines longer than MAX_PROMPT_LINE_CHARS end in
// "...", and so may their anchors.
function fit(lineText, reading) {
  const line = collapse(lineText);
  if (!line) return 0;
  if (!reading.cut && line === reading.exact) return 3;
  const l = loose(line);
  if (!reading.cut && l === reading.loose) return 2;
  return reading.loose.length >= MIN_PREFIX_CHARS && l.startsWith(reading.loose) ? 1 : 0;
}

// The best fit of any reading for one line: { score, fixes }.
function bestFit(lineText, readings) {
  let best = { score: 0, fixes: [] };
  for (const r of readings) {
    const score = fit(lineText, r);
    if (score > best.score) best = { score, fixes: [...r.fixes, ...(score === 2 ? [ANCHOR_FIXES.loose] : score === 1 ? [ANCHOR_FIXES.truncated] : [])] };
  }
  return best;
}

// The line, counted from 1, whose text the anchor gives. range: the lines of the file the
// proposal's request showed, { start, end } as indices (the whole file by default).
// 1. An exact match at the given line, or else the nearest within ANCHOR_WINDOW lines,
//    looking below first.
// 2. A tolerant match at the given line.
// 3. Within ANCHOR_NEAR lines, then within the range: the one line that fits best. When two
//    or more fit equally well, the anchor is ambiguous and the comment is dropped.
// Returns { line, fixes } or { line: null, miss }, where fixes and miss are categories.
function locateAnchor(lines, line, anchor, range = { start: 0, end: lines.length }) {
  if (typeof anchor !== 'string') return { line: null, miss: ANCHOR_MISSES.empty };
  const readings = anchorReadings(anchor);
  if (!readings.length) return { line: null, miss: ANCHOR_MISSES.empty };
  const center = Math.min(Math.max(line, 1), lines.length);
  const at = (l) => (l >= 1 && l <= lines.length ? bestFit(lines[l - 1].text, readings) : { score: 0, fixes: [] });
  for (let d = 0; d <= ANCHOR_WINDOW; d++) {
    for (const l of d ? [center + d, center - d] : [center]) {
      const f = at(l);
      if (f.score === 3) return { line: l, fixes: f.fixes };
    }
  }
  const here = at(center);
  if (here.score) return { line: center, fixes: here.fixes };
  // The lines that fit best in [from, to], or [] when none fit.
  const bestIn = (from, to) => {
    let top = 0;
    let found = [];
    for (let l = Math.max(1, from); l <= Math.min(lines.length, to); l++) {
      const f = at(l);
      if (!f.score || f.score < top) continue;
      if (f.score > top) {
        top = f.score;
        found = [];
      }
      found.push({ line: l, fixes: f.fixes });
    }
    return found;
  };
  const near = bestIn(center - ANCHOR_NEAR, center + ANCHOR_NEAR);
  if (near.length === 1) {
    const far = Math.abs(near[0].line - center) > ANCHOR_WINDOW;
    return { line: near[0].line, fixes: [...near[0].fixes, ...(far ? [ANCHOR_FIXES.near] : [])] };
  }
  if (near.length > 1) return { line: null, miss: ANCHOR_MISSES.ambiguous };
  const inRange = bestIn(range.start + 1, range.end);
  if (inRange.length === 1) return { line: inRange[0].line, fixes: [...inRange[0].fixes, ANCHOR_FIXES.window] };
  if (inRange.length > 1) return { line: null, miss: ANCHOR_MISSES.ambiguous };
  return { line: null, miss: bestIn(1, lines.length).length ? ANCHOR_MISSES.outside : ANCHOR_MISSES.none };
}

// A shebang or encoding line looks like a comment but documents nothing, so it does not
// count toward the level or block the line after it.
function analyzeFile(body, lines, language) {
  const analysis = analyzeLines(body, lines, language);
  if (!analysis.ok) return analysis;
  analysis.protectedUntil = protectedHeadLines(lines, language);
  for (let i = 0; i < analysis.protectedUntil; i++) {
    analysis.info[i].commentOnly = false;
    analysis.info[i].hasComment = false;
  }
  return analysis;
}

// Reads the file and takes out the comments Docturnal wrote on earlier runs (records).
// Returns the context the later steps share: `lines` and `analysis` describe the file
// without those comments, which is what the model sees and where comments are placed.
// `owned` lists the comments taken out, each with its target line in `lines`. On a file
// that cannot be commented, `error` says why.
// knownUrls: the URLs the repository already has. A proposed comment with any other URL is
// dropped (none are known by default).
function prepareFile({ text, language, level, records = [], knownUrls = new Set() }) {
  const { bom, body } = stripBom(text);
  const original = splitLines(body);
  const ctx = { language, original: text, bom, body, lines: original, analysis: null, owned: [], knownUrls };
  // At level off with nothing of Docturnal's to remove, there is nothing to place.
  if (!LEVELS[level] && !records.length) return ctx;
  if (language.phpTags && !phpIsSafe(original)) return { ...ctx, error: 'PHP file mixes code with HTML' };
  const analysis = analyzeFile(body, original, language);
  // A file the parser cannot read is never commented: verification could not prove anything.
  if (analysis.syntaxErrors) return { ...ctx, error: SYNTAX_ERRORS, syntaxError: true };
  if (!analysis.ok) return { ...ctx, error: `cannot analyze file: ${analysis.error}` };
  ctx.analysis = analysis;
  const owned = records.length ? findOwned(original, analysis.info, records) : [];
  if (!owned.length) return ctx;

  const removed = new Set();
  for (const o of owned) for (let i = o.start; i <= o.end; i++) removed.add(i);
  const body0 = original.filter((_, i) => !removed.has(i)).map((line) => line.text + line.eol).join('');
  // Taking the comments out must leave every other line, and the program, exactly as it is.
  if (!verifyCandidates(language, bom + body0, [{ text, inserted: [...removed] }])[0]) return ctx;
  const lines = splitLines(body0);
  const analysis0 = analyzeFile(body0, lines, language);
  if (!analysis0.ok) return ctx;
  const removedBefore = (index) => [...removed].filter((r) => r < index).length;
  return {
    ...ctx,
    body: body0,
    lines,
    analysis: analysis0,
    owned: owned.map((o) => ({
      record: o.record,
      target: o.anchor - removedBefore(o.anchor) + 1,
      lines: original.slice(o.start, o.end + 1).map((line) => line.text),
    })),
  };
}

// Turns the earlier comments and the model's proposals into candidates: each placed, cleaned,
// and given the kind the level calls for. Returns { rules, candidates, rejections,
// earlierRemoved, symbols, undocumented, proposed }. At heavy level, symbols lists the
// functions, classes, and components that can take a block comment, and undocumented the
// ones without a new proposal, which the follow-up request asks for.
function buildCandidates(ctx, level, groups) {
  const rules = LEVELS[level];
  const all = groups.flat();
  const built = { rules, candidates: [], rejections: [], earlierRemoved: [], symbols: [], undocumented: [], proposed: all.length, anchors: emptyAnchors() };
  const reject = (proposal, reason) => built.rejections.push({
    line: isProposal(proposal) && Number.isInteger(proposal.line) ? proposal.line : undefined,
    reason,
    category: categoryOf(reason),
  });
  if (ctx.error || !rules) {
    all.forEach((p) => reject(p, ctx.error || 'comment level is off'));
    ctx.owned.forEach(() => built.earlierRemoved.push('comment level is off'));
    return built;
  }

  const { lines, analysis, language } = ctx;
  const info = analysis.info;
  const problemAt = (target) => placementProblem(target, lines, analysis, analysis.protectedUntil);
  // At heavy level, every comment on a declaration is a block comment, whatever kind the
  // model gave it; everything else is a line comment.
  const shape = (target, cleaned) => {
    if (rules.blocks && info[target - 1].isDeclaration) {
      return wordCount(cleaned.joined) > rules.maxBlockWords
        ? { reason: `block comment longer than ${rules.maxBlockWords} words` }
        : { kind: 'block', paragraphs: cleaned.paragraphs };
    }
    return wordCount(cleaned.joined) > rules.maxWords
      ? { reason: `longer than ${rules.maxWords} words` }
      : { kind: 'line', paragraphs: [cleaned.joined] };
  };
  const add = (fields, target, shaped) => built.candidates.push({
    ...fields,
    target,
    kind: shaped.kind,
    paragraphs: shaped.paragraphs,
    declaration: info[target - 1].isDeclaration,
    // Only heavy level asks for comments on constants, so only there do they rank with declarations.
    constant: rules.blocks && info[target - 1].isConstant,
  });

  for (const earlier of ctx.owned) {
    const problem = problemAt(earlier.target);
    const cleaned = cleanText(earlier.lines.map(stripMarkers).join('\n'), language);
    const shaped = problem ? { reason: problem } : cleaned.reason ? cleaned : shape(earlier.target, cleaned);
    if (shaped.reason) built.earlierRemoved.push(shaped.reason);
    else add({ source: 'earlier', earlier }, earlier.target, shaped);
  }

  // Each group is one request's answer; its window is the lines that request showed.
  const proposals = groups.flatMap((group) => (Array.isArray(group) ? group.map((proposal) => ({ proposal, range: group.window })) : [{ proposal: group }]));
  for (const { proposal, range } of proposals) {
    if (!isProposal(proposal) || !Number.isInteger(proposal.line) || proposal.line < 0 || proposal.line > lines.length + ANCHOR_NEAR) {
      reject(proposal, 'line out of range');
      continue;
    }
    const found = locateAnchor(lines, proposal.line, proposal.anchor, range);
    if (!found.line) {
      built.anchors.missed[found.miss] = (built.anchors.missed[found.miss] || 0) + 1;
      reject(proposal, `anchor not found, ${found.miss}`);
      continue;
    }
    if (!found.fixes.length) built.anchors.exact++;
    for (const fix of found.fixes) built.anchors.fixed[fix] = (built.anchors.fixed[fix] || 0) + 1;
    const line = found.line;
    const target = resolveTarget(line, lines, analysis, language);
    const problem = problemAt(target);
    if (problem) {
      reject(proposal, problem);
      continue;
    }
    const cleaned = cleanText(proposal.text, language);
    if (cleaned.reason) {
      reject(proposal, cleaned.reason);
      continue;
    }
    if (hasUnknownUrl(cleaned.joined, ctx.knownUrls)) {
      reject(proposal, LINK_NOT_FOUND);
      continue;
    }
    const shaped = shape(target, cleaned);
    if (shaped.reason) {
      reject(proposal, shaped.reason);
      continue;
    }
    add({ source: 'model', proposal }, target, shaped);
  }

  if (rules.blocks) {
    built.symbols = info.flatMap((li, i) => {
      if (!li.symbol) return [];
      const target = resolveTarget(i + 1, lines, analysis, language);
      return problemAt(target) ? [] : [{ line: i + 1, target, name: li.symbol }];
    });
    const proposedAt = new Set(built.candidates.filter((c) => c.source === 'model').map((c) => c.target));
    built.undocumented = built.symbols.filter((s) => !proposedAt.has(s.target)).map(({ line, name }) => ({ line, name }));
  }
  return built;
}

// Block comments first, then comments on declarations and constants, then the rest; earlier
// comments before new ones; each in file order. A limited budget goes to the first.
function byRank(a, b) {
  const rank = (c) => (c.kind === 'block' ? 0 : c.declaration || c.constant ? 1 : 2);
  const age = (c) => (c.source === 'earlier' ? 0 : 1);
  return rank(a) - rank(b) || age(a) - age(b) || a.target - b.target;
}

// Picks the comments to insert: drops the ones the accuracy check marked inaccurate, keeps an
// earlier comment over a new one on the same line, and applies the level's limits.
function selectComments(ctx, built, verdicts, drop) {
  const { rules } = built;
  const firstAt = new Map();
  const unique = [];
  const earlierFirst = [...built.candidates].sort((a, b) => (a.source === 'earlier' ? 0 : 1) - (b.source === 'earlier' ? 0 : 1));
  for (const c of earlierFirst) {
    const verdict = verdicts.get(c) || {};
    // Only a new line comment is dropped for adding nothing. A comment already in the file,
    // Docturnal's or a person's, stays, and a block comment is what heavy level promises
    // every function.
    const judged = c.source === 'model' && c.kind === 'line';
    // After the model's answers, a word count catches restatements the model let through.
    // Comments on constants are exempt, since naming what a constant holds is their job, and
    // so are comments on declarations, the function summary at medium and low that heavy
    // writes as a block: a summary always shares words with the function's own names.
    const words = judged && !c.constant && !c.declaration
      ? restatement(c.paragraphs.join(' '), codeUnder(ctx.lines, c.target).map((l) => l.text))
      : null;
    if (verdict.accurate === false) {
      drop(c, 'inaccurate');
    } else if (judged && verdict.useful === false) {
      drop(c, 'restates the code');
    } else if (judged && verdict.repeats === true && c.functionComment) {
      drop(c, 'repeats the function comment');
    } else if (words && restates(words)) {
      drop(c, 'restates the code (word match)', { coverage: words.coverage, narrates: words.narrates });
    } else if (firstAt.has(c.target)) {
      drop(c, firstAt.get(c.target) === 'earlier' ? 'kept the earlier comment' : 'duplicate line');
    } else {
      firstAt.set(c.target, c.source);
      unique.push(c);
    }
  }
  if (!rules) return [];

  // Existing comments count toward the level's limits, so re-runs do not pile up comments.
  // Every file may have at least one comment, so a short file with a function can get one.
  // Only line comments are limited: a block comment above a declaration never counts toward
  // the level or the gap, and is never dropped by them. At heavy level, a comment on a
  // constant may sit next to another, since constants are often declared together.
  const info = ctx.analysis.info;
  const codeLines = info.filter((li) => !li.blank && !li.commentOnly).length;
  const allowed = Math.max(1, Math.round(codeLines / rules.linesPerComment));
  const taken = existingCommentPositions(info, rules.blocks);
  let budget = allowed - taken.length;
  const accepted = [];
  for (const candidate of unique.sort(byRank)) {
    if (candidate.kind === 'block') {
      accepted.push(candidate);
      continue;
    }
    if (budget <= 0) {
      drop(candidate, 'level limit reached');
      continue;
    }
    const gapExempt = rules.blocks && candidate.constant;
    if (!gapExempt && taken.some((pos) => Math.abs(pos - candidate.target) < rules.minGap)) {
      drop(candidate, `within ${rules.minGap} lines of another comment`);
      continue;
    }
    taken.push(candidate.target);
    accepted.push(candidate);
    budget--;
  }
  return accepted;
}

// Inserts the accepted comments and verifies the result. Returns { text, kept }.
function renderComments(ctx, accepted, drop) {
  const { language, lines, bom } = ctx;
  const base = bom + ctx.body;
  if (!accepted.length) return { text: base, kept: [] };
  const eol = dominantEol(lines);
  for (const c of accepted) {
    c.commentLines = formatComment(language, c.kind, c.paragraphs, lines[c.target - 1].text.match(/^[ \t]*/)[0]);
  }
  const renderSet = (set) => render(lines, set.map((c) => ({ target: c.target, commentLines: c.commentLines })), eol, bom);

  const full = renderSet(accepted);
  if (verifyCandidates(language, base, [full])[0]) return { text: full.text, kept: accepted };

  // The full set failed, so test each comment alone and keep only those that pass.
  const singles = accepted.map((c) => renderSet([c]));
  const passed = verifyCandidates(language, base, singles);
  const kept = accepted.filter((c, i) => {
    if (!passed[i]) drop(c, 'verification failed');
    return passed[i];
  });
  if (!kept.length) return { text: base, kept: [] };
  const combined = renderSet(kept);
  if (!verifyCandidates(language, base, [combined])[0]) {
    kept.forEach((c) => drop(c, 'verification failed in combination'));
    return { text: base, kept: [] };
  }
  return { text: combined.text, kept };
}

// Selects, inserts, and verifies, and counts what happened. verdicts: Map from candidate to
// the check's answers ({ accurate, useful, repeats }); a candidate without them stays.
// Returns { text, added, rejected, rejections, stats, records, undocumented }, where stats
// never holds comment text, and records lists every Docturnal comment now in the file.
function finishFile(ctx, built, verdicts = new Map()) {
  const stats = emptyStats(built.proposed, built.anchors);
  const rejections = [...built.rejections];
  const earlierRemoved = [...built.earlierRemoved];
  // extra: details for the log, such as the word-match coverage; never comment text.
  const drop = (c, reason, extra = {}) => {
    if (c.source === 'earlier') earlierRemoved.push(reason);
    else rejections.push({ line: c.proposal.line, reason, category: categoryOf(reason), ...extra });
  };
  const { text, kept } = ctx.error
    ? { text: ctx.original, kept: [] }
    : renderComments(ctx, selectComments(ctx, built, verdicts, drop), drop);

  for (const r of rejections) {
    const bucket = stats.dropped[r.category];
    bucket[r.reason] = (bucket[r.reason] || 0) + 1;
  }
  for (const reason of earlierRemoved) stats.earlier.removed[reason] = (stats.earlier.removed[reason] || 0) + 1;
  const keptEarlier = kept.filter((c) => c.source === 'earlier');
  stats.earlier.kept = keptEarlier.length;
  stats.earlier.restyled = keptEarlier.filter((c) =>
    c.commentLines.map((l) => l.trim()).join('\n') !== c.earlier.lines.map((l) => l.trim()).join('\n')).length;
  stats.added = kept.length - keptEarlier.length;

  const documented = new Set(kept.map((c) => c.target));
  return {
    text,
    added: stats.added,
    rejected: rejections.length,
    rejections,
    stats,
    records: [...kept].sort((a, b) => a.target - b.target).map((c) => recordFor(c.commentLines, ctx.lines[c.target - 1].text)),
    undocumented: built.symbols.filter((s) => !documented.has(s.target)).map(({ line, name }) => ({ line, name })),
  };
}

// Filters, limits, inserts, and verifies proposals for one file, without a model.
// proposals: [{ line, anchor, text, kind }], or groups: one array of proposals per model
// response. records: the Docturnal comments recorded for this file on earlier runs.
function applyProposals({ text, language, level, proposals, groups = [proposals], records = [], knownUrls }) {
  const ctx = prepareFile({ text, language, level, records, knownUrls });
  return finishFile(ctx, buildCandidates(ctx, level, groups));
}

function numberedLine(lines, i) {
  const text = lines[i].text;
  return `${i + 1}| ${text.length > MAX_PROMPT_LINE_CHARS ? `${text.slice(0, MAX_PROMPT_LINE_CHARS)}...` : text}`;
}

// A numbered line's tokens, counted generously: its text, and its "12| " prefix, where the
// tokenizer gives each digit a token of its own.
function lineTokens(lines, i) {
  const numbered = numberedLine(lines, i);
  const prefix = String(i + 1).length + 2;
  return Math.ceil((numbered.length - prefix + 1) / CHARS_PER_TOKEN) + prefix;
}

// Splits the file into windows of whole lines that fit the context budget, preferring to
// break at a blank line.
function buildWindows(lines, contextTokens) {
  const budget = promptBudget(contextTokens);
  const windows = [];
  let start = 0;
  while (start < lines.length) {
    let size = 0;
    let end = start;
    let lastBlank = -1;
    while (end < lines.length) {
      const length = lineTokens(lines, end);
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

// How many comments to ask for in a window: its share, by code lines, of the room the level
// leaves for line comments in the file (as selectComments counts it, less the comments
// already there), half again so the checks have some to drop, and at heavy level one per
// declaration. Comments past the level's limit are dropped anyway, and each costs answer time.
function proposalCap(ctx, level, window) {
  const rules = LEVELS[level];
  if (!rules || !ctx.analysis) return 0;
  const isCode = (li) => !li.blank && !li.commentOnly;
  const all = ctx.analysis.info;
  const fileCode = all.filter(isCode).length;
  const room = Math.max(0, Math.max(1, Math.round(fileCode / rules.linesPerComment)) - existingCommentPositions(all, rules.blocks).length);
  const info = all.slice(window.start, window.end);
  const share = fileCode ? info.filter(isCode).length / fileCode : 0;
  const blocks = rules.blocks ? info.filter((li) => li.isDeclaration).length : 0;
  return Math.min(MAX_PROPOSALS, Math.ceil(room * share * 1.5) + blocks);
}

// Answer tokens for a window: the summary and symbols, and each comment asked for.
function proposalTokens(cap) {
  return Math.min(OUTPUT_RESERVE_TOKENS, SUMMARY_TOKENS + cap * TOKENS_PER_PROPOSAL);
}

function buildMessages({ path, language, level, lines, window, index, count, cap = MAX_PROPOSALS }) {
  const numbered = [];
  for (let i = window.start; i < window.end; i++) numbered.push(numberedLine(lines, i));
  const part = count > 1
    ? `Part ${index + 1} of ${count}: lines ${window.start + 1} to ${window.end} of ${lines.length}.\n`
    : '';
  const limit = !LEVELS[level] ? '' : cap
    ? `Propose at most ${cap} ${cap === 1 ? 'comment' : 'comments'}.\n`
    : 'This code already has as many comments as the level allows, so return an empty comments list.\n';
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${LEVEL_GUIDANCE[level]}` },
    { role: 'user', content: `File: ${path}\nLanguage: ${language.name}\n${part}${limit}\n${numbered.join('\n')}` },
  ];
}

// The follow-up request: the declarations by name and line, and the code from each one on,
// as many as fit the context budget.
function buildBlockMessages({ path, language, lines, missing, contextTokens }) {
  const budget = promptBudget(contextTokens);
  const shown = new Set();
  const asked = [];
  let size = 0;
  for (const declaration of missing) {
    const extra = [];
    for (let i = declaration.line - 1; i < Math.min(lines.length, declaration.line - 1 + BLOCK_CONTEXT_LINES); i++) {
      if (!shown.has(i)) extra.push(i);
    }
    const length = extra.reduce((sum, i) => sum + lineTokens(lines, i), 0);
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

function cleanSymbols(value) {
  return Array.isArray(value) ? value.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 100)).filter(Boolean) : [];
}

// The index of the brace that closes the object opening at `from`, or -1 when the text ends first.
function objectEnd(text, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// What can be used of a reply that is not valid JSON, such as one cut off at its length
// limit: the summary and symbols if they were finished, and the comments that were complete.
function salvageReply(content) {
  const out = { summary: '', symbols: [], comments: [] };
  const value = (re) => {
    const m = content.match(re);
    if (!m) return undefined;
    try {
      return JSON.parse(m[1]);
    } catch {
      return undefined;
    }
  };
  const summary = value(/"summary"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (typeof summary === 'string') out.summary = summary.trim();
  out.symbols = cleanSymbols(value(/"symbols"\s*:\s*(\[[^\]]*\])/));
  const start = content.search(/"comments"\s*:\s*\[/);
  if (start === -1) return out;
  let i = content.indexOf('[', start) + 1;
  while (i < content.length) {
    while (i < content.length && /[\s,]/.test(content[i])) i++;
    if (content[i] !== '{') break;
    const end = objectEnd(content, i);
    if (end === -1) break;
    try {
      out.comments.push(JSON.parse(content.slice(i, end + 1)));
    } catch {
      break;
    }
    i = end + 1;
  }
  return out;
}

// Why a request gave no proposals, or gave only part of its answer, by category. The log
// gives these, never the reply.
const REPLY_CAUSES = {
  failed: 'the request failed',
  length: 'the reply stopped at its length limit',
  context: 'the prompt and the reply filled the context',
  json: 'the reply is not valid JSON',
  noList: 'the reply has no comments list',
  none: 'the model proposed none',
  capped: 'the code already has as many comments as the level allows',
};

// Reads one reply: a string, or { content, doneReason, promptTokens, replyTokens } from a
// chat function that gives them. Returns { summary, symbols, comments, cause }, where cause
// is null for a usable answer with proposals. Throws when nothing in it can be used.
function readReply(reply, { contextTokens, cap }) {
  const raw = reply && typeof reply === 'object' ? reply : { content: reply };
  const content = typeof raw.content === 'string' ? raw.content : '';
  const full = Number.isInteger(raw.promptTokens) && Number.isInteger(raw.replyTokens) && raw.promptTokens + raw.replyTokens >= contextTokens - 8;
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    data = undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const cause = raw.doneReason === 'length' ? REPLY_CAUSES.length : full ? REPLY_CAUSES.context : REPLY_CAUSES.json;
    const salvaged = salvageReply(content);
    if (!salvaged.summary && !salvaged.comments.length) throw new Error(cause);
    return { ...salvaged, cause, salvaged: true };
  }
  const comments = Array.isArray(data.comments) ? data.comments : null;
  const cause = !comments ? REPLY_CAUSES.noList : comments.length ? null : full ? REPLY_CAUSES.context : cap === 0 ? REPLY_CAUSES.capped : REPLY_CAUSES.none;
  return {
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    symbols: cleanSymbols(data.symbols),
    comments: comments || [],
    cause,
  };
}

// Only the comments the level can take are checked for accuracy and kept: the selection is
// run once without verdicts, and the new comments it drops for the level's limits (too many,
// or too close to another comment in the file or a new one ranked ahead of it) are dropped
// now, for the same reasons. One of them
// could only have been inserted had the check dropped a comment ahead of it; checking every
// proposal for that chance would cost more time than it gives.
function limitToLevel(ctx, built) {
  if (!built.rules || !built.candidates.length) return built;
  const dropped = new Map();
  for (const c of built.candidates) {
    if (c.source === 'model' && c.kind === 'line') c.functionComment = functionCommentFor(ctx, built, c.target);
  }
  // Docturnal's earlier comments are left out of the dry run: the check may remove them, and a
  // new comment then takes their place.
  const fresh = { ...built, candidates: built.candidates.filter((c) => c.source === 'model') };
  selectComments(ctx, fresh, new Map(), (c, reason, extra = {}) => {
    if (categoryOf(reason) === 'density') dropped.set(c, { reason, extra });
  });
  for (const [c, { reason, extra }] of dropped) {
    built.rejections.push({ line: c.proposal.line, reason, category: categoryOf(reason), ...extra });
  }
  built.candidates = built.candidates.filter((c) => !dropped.has(c));
  return built;
}

// Step 1 of 3, with the comment model: asks for proposals per window and, at heavy level,
// sends one follow-up request for the functions, classes, and components still without one.
// records: the Docturnal comments recorded for this file on earlier runs. known: the file's
// summary and symbols when its content has not changed since they were written; with it, a
// file whose comments already fill the level needs no request at all.
// Returns a plan for checkComments and finishComments, with plan.replies giving, for each
// request, its lines, its proposals, and the cause when it gave none or only part of an
// answer, and plan.proposeMs and plan.requests the time and the requests it took.
async function planComments({ path, text, level = 'medium', model, contextTokens = 8192, chat = ollama.chat, host, records = [], knownUrls, known = null, now = Date.now }) {
  const started = now();
  const language = languageForPath(path);
  const plan = { path, language: language && language.id, level, text, summary: '', symbols: [], failedWindows: 0, errors: [], replies: [], requests: 0, proposeMs: 0, checkMs: 0, checkRequests: 0, ctx: null, built: null, verdicts: new Map() };
  if (!language) return { ...plan, skipped: 'unsupported language' };
  if (isMinified(splitLines(stripBom(text).body))) return { ...plan, skipped: 'minified' };

  const ctx = prepareFile({ text, language, level, records, knownUrls });
  if (ctx.syntaxError) return { ...plan, skipped: SYNTAX_ERRORS };
  const { lines } = ctx;
  const windows = buildWindows(lines, contextTokens);
  const caps = windows.map((window) => proposalCap(ctx, level, window));
  const summaries = [];
  const symbols = new Set();
  const groups = [];
  const nothingToAdd = known && typeof known.summary === 'string' && !ctx.owned.length && caps.every((cap) => cap === 0);
  if (nothingToAdd) {
    summaries.push(known.summary);
    cleanSymbols(known.symbols).forEach((s) => symbols.add(s));
    plan.replies.push({ lines: `1-${lines.length}`, proposed: 0, cause: REPLY_CAUSES.capped, asked: false });
  }
  for (const [index, window] of (nothingToAdd ? [] : windows).entries()) {
    const span = `${window.start + 1}-${window.end}`;
    const cap = caps[index];
    try {
      plan.requests++;
      const reply = await chat({
        label: `comments for ${path}, lines ${window.start + 1} to ${window.end}`,
        model,
        host,
        messages: buildMessages({ path, language, level, lines, window, index, count: windows.length, cap }),
        format: RESPONSE_SCHEMA,
        options: { ...MODEL_OPTIONS(contextTokens), num_predict: proposalTokens(cap) },
        withReason: true,
      });
      const parsed = readReply(reply, { contextTokens, cap });
      if (parsed.summary) summaries.push(parsed.summary);
      parsed.symbols.forEach((s) => symbols.add(s));
      const group = parsed.comments;
      group.window = window;
      groups.push(group);
      plan.replies.push({ lines: span, proposed: group.length, cause: parsed.cause, salvaged: Boolean(parsed.salvaged) });
    } catch (err) {
      plan.failedWindows++;
      plan.errors.push(`lines ${span}: ${err.message}`);
      plan.replies.push({ lines: span, proposed: 0, cause: Object.values(REPLY_CAUSES).includes(err.message) ? err.message : REPLY_CAUSES.failed });
    }
  }

  let built = buildCandidates(ctx, level, groups);
  // Skipped when the model answered nothing at all.
  if (built.undocumented.length && groups.length) {
    const { messages } = buildBlockMessages({ path, language, lines, missing: built.undocumented, contextTokens });
    try {
      plan.requests++;
      const reply = await chat({ label: `block comments for ${path}`, model, host, messages, format: BLOCK_SCHEMA, options: { ...MODEL_OPTIONS(contextTokens), num_predict: OUTPUT_RESERVE_TOKENS }, withReason: true });
      groups.push(readReply(reply, { contextTokens }).comments);
      built = buildCandidates(ctx, level, groups);
    } catch (err) {
      plan.errors.push(`block comments: ${err.message}`);
    }
  }
  plan.summary = summaries.join(' ').slice(0, 1000);
  plan.symbols = [...symbols].slice(0, 50);
  plan.ctx = ctx;
  plan.built = limitToLevel(ctx, built);
  plan.proposeMs = now() - started;
  return plan;
}

// How many accuracy-check requests a plan needs.
function checkRequests(plan) {
  return plan.built ? Math.ceil(plan.built.candidates.length / ACCURACY_BATCH) : 0;
}

// Whether the plan has comments for the accuracy check.
function needsCheck(plan) {
  return Boolean(plan.built && plan.built.candidates.length);
}

// Step 2 of 3: asks whether each candidate comment, earlier or new, is true of the code
// under it, ACCURACY_BATCH comments per request. `chat` and `model` may be the docs
// model's. Sets plan.verdicts.
// Throws when the check gets no usable answer.
async function checkComments(plan, { chat = ollama.chat, model, host, contextTokens = 8192, now = Date.now }) {
  if (!needsCheck(plan)) return plan;
  const started = now();
  try {
    await checkAll(plan, { chat, model, host, contextTokens });
  } finally {
    plan.checkMs += now() - started;
  }
  return plan;
}

async function checkAll(plan, { chat, model, host, contextTokens }) {
  for (const c of plan.built.candidates) {
    if (c.source === 'model' && c.kind === 'line') c.functionComment = functionCommentFor(plan.ctx, plan.built, c.target);
  }
  const items = [...plan.built.candidates].sort(byRank).map((c) => ({
    candidate: c,
    comment: c.paragraphs.join(' '),
    target: c.target,
    functionComment: c.functionComment,
  }));
  const verdicts = new Map();
  const batches = Math.ceil(items.length / ACCURACY_BATCH);
  for (let b = 0; b < batches; b++) {
    const batch = items.slice(b * ACCURACY_BATCH, (b + 1) * ACCURACY_BATCH);
    const messages = buildAccuracyMessages({ path: plan.path, language: plan.ctx.language, lines: plan.ctx.lines, items: batch });
    plan.checkRequests++;
    const content = await chat({
      label: `accuracy check for ${plan.path}${batches > 1 ? ` (${b + 1} of ${batches})` : ''}`,
      model,
      host,
      messages,
      format: ACCURACY_SCHEMA,
      // The same context size as every other call, so Ollama does not reload the model.
      options: { ...MODEL_OPTIONS(contextTokens), num_predict: ACCURACY_PREDICT_TOKENS },
    });
    const answers = parseVerdicts(content, batch.length);
    batch.forEach((item, i) => {
      if (answers.has(i + 1)) verdicts.set(item.candidate, answers.get(i + 1));
    });
  }
  plan.verdicts = verdicts;
  return plan;
}

// The comment of the innermost function, class, or component around a line: the block
// comment proposed for it (an earlier one first), or else the comment already above it.
// Null when the line is in none, or the enclosing one has no comment.
function functionCommentFor(ctx, built, target) {
  const info = ctx.analysis.info;
  let start = -1;
  for (let i = target - 2; i >= 0; i--) {
    if (info[i].symbol && info[i].symbolEnd !== null && info[i].symbolEnd >= target - 1) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const declaration = resolveTarget(start + 1, ctx.lines, ctx.analysis, ctx.language);
  const blocks = built.candidates.filter((c) => c.kind === 'block' && c.target === declaration);
  const block = blocks.find((c) => c.source === 'earlier') || blocks[0];
  if (block) return block.paragraphs.join(' ');
  const above = [];
  for (let i = declaration - 2; i >= 0 && info[i].commentOnly; i--) above.unshift(stripMarkers(ctx.lines[i].text));
  const text = above.filter(Boolean).join(' ');
  return text || null;
}

// Step 3 of 3, without a model: selects, inserts, and verifies.
// Returns { path, language, summary, symbols, text, added, rejected, rejections, stats,
// records, undocumented, failedWindows, errors, skipped }.
function finishComments(plan) {
  if (plan.skipped) return { ...unchanged(plan), skipped: plan.skipped };
  return { ...headOf(plan), ...finishFile(plan.ctx, plan.built, plan.verdicts) };
}

function headOf(plan) {
  return { path: plan.path, language: plan.language, summary: plan.summary, symbols: plan.symbols, failedWindows: plan.failedWindows, errors: plan.errors };
}

// The result for a file left as it is.
function unchanged(plan) {
  return { ...headOf(plan), text: plan.text, added: 0, rejected: 0, rejections: [], stats: emptyStats(0), records: [], undocumented: [] };
}

// Comments one file with one model for every step. `chat` defaults to the local Ollama client
// and is replaceable for tests. checkModel, if given, runs the accuracy check. When the
// check fails, nothing changes and checkFailed holds the error.
async function commentFile(options) {
  const plan = await planComments(options);
  if (needsCheck(plan)) {
    try {
      await checkComments(plan, { ...options, model: options.checkModel || options.model });
    } catch (err) {
      plan.errors.push(`accuracy check: ${err.message}`);
      return { ...unchanged(plan), checkFailed: err.message };
    }
  }
  return finishComments(plan);
}

// The anchors line for the log: counts per category, never an anchor's text. Empty when
// every anchor matched exactly.
function anchorSummary(anchors) {
  if (!anchors) return '';
  const list = (counts) => Object.entries(counts).map(([category, n]) => `${category}: ${n}`).join(', ');
  const fixed = Object.keys(anchors.fixed).length;
  const missed = Object.values(anchors.missed).reduce((sum, n) => sum + n, 0);
  if (!fixed && !missed) return '';
  const parts = [`${anchors.exact} matched exactly`];
  if (fixed) parts.push(`matched after a fix: ${list(anchors.fixed)}`);
  if (missed) parts.push(`${missed} not found: ${list(anchors.missed)}`);
  return `anchors: ${parts.join('; ')}`;
}

// The replies line for the log, when a request gave no proposals or only part of its answer:
// each request's lines and cause, with counts only.
function replySummary(plan) {
  const notable = (plan.replies || []).filter((r) => r.cause);
  if (!notable.length) return '';
  return `replies: ${notable.map((r) => `lines ${r.lines}: ${r.cause}${r.salvaged ? `, ${r.proposed} complete ${r.proposed === 1 ? 'comment' : 'comments'} kept` : ''}${r.asked === false ? ', no request made' : ''}`).join('; ')}`;
}

module.exports = {
  ANCHOR_FIXES,
  ANCHOR_MISSES,
  CATEGORY,
  LEVELS,
  MAX_PROPOSALS,
  REPLY_CAUSES,
  RESPONSE_SCHEMA,
  anchorSummary,
  applyProposals,
  buildWindows,
  checkComments,
  checkRequests,
  cleanText,
  commentFile,
  finishComments,
  locateAnchor,
  needsCheck,
  planComments,
  readReply,
  replySummary,
  salvageReply,
};
