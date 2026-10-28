'use strict';

// The comment engine. Code chooses where comments go (see targets.js): functions, methods,
// classes, exported declarations, and complex blocks without a comment above them, only as
// many as the comment level leaves room for. The model only writes the text: one short
// request per target, or a few small targets together, each showing just that code. This
// module then filters the comments, has them checked for accuracy, inserts them, and verifies
// the result. Comments Docturnal wrote on earlier runs (see owned.js) are taken out first
// and compete with the new ones, so they can be kept, restyled for the level, or removed.

const { buildAccuracyMessages, ACCURACY_SCHEMA, codeUnder, parseVerdicts } = require('./accuracy');
const { analyzeLines, splitLines } = require('./analyze');
const { languageForPath } = require('./languages');
const ollama = require('./ollama');
const { hasUnknownUrl } = require('./links');

// A comment with a web link the repository does not already have.
const LINK_NOT_FOUND = 'link not found in the repository';
const { findOwned, recordFor } = require('./owned');
const { restatement, restates } = require('./restates');
const { LOW_LINES, MEDIUM_BLOCK_SCORE, MEDIUM_LINES, parsedTargets } = require('./targets');
const { verifyCandidates } = require('./verify');

const LEVELS = {
  low: { maxWords: 10, minGap: 15, linesPerComment: 30, blocks: false },
  medium: { maxWords: 25, minGap: 5, linesPerComment: 12, blocks: false },
  heavy: { maxWords: 30, maxBlockWords: 80, minGap: 2, linesPerComment: 5, blocks: true },
  off: null,
};

// What a request asks for, by the comment's kind: at most this many words, which is also
// what its answer's num_predict is sized for. A block comment may run to maxBlockWords, but
// is asked for in fewer.
const ASK_WORDS = { low: 10, medium: 25, heavy: 30 };
const ASK_BLOCK_WORDS = 50;

// The most new comments a file gets in one run, block comments on declarations at heavy
// included: its highest-ranked targets. A file with more room left gets the rest in a later
// batch, so one large file never takes a whole night.
const PER_RUN = { low: 3, medium: 8, heavy: 20 };

const TARGET_PROMPT = `You write code comments. You never rewrite code.

Each target shows its code, each line as "number| code". The comment goes directly above the target's line. Write one comment for each target:
- A function, method, class, or component: what it is for, what it takes and returns, and its side effects.
- A type or interface: what it describes.
- A constant: what the value means, and its unit.
- A block: what it achieves, and why when the code shows it.

Keep to each target's word limit, in 1 or 2 plain sentences in the present tense. Explain intent, units, constraints, and edge cases; never narrate the syntax, such as "loops over the items". Describe only the target. Give the text only: no comment markers, no tags such as @param, no tool directives, and no mention of yourself or AI.

Return each target's id with its comment.`;

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
  },
  required: ['comments'],
};

// A target's code: at most MAX_EXCERPT_LINES lines, with BLOCK_CONTEXT_LINES lines before a
// block for context. Targets whose code is at most SMALL_EXCERPT_LINES lines are asked for
// together, up to MAX_TARGETS_PER_REQUEST and MAX_EXCERPT_LINES lines in one request.
const MAX_EXCERPT_LINES = 40;
const BLOCK_CONTEXT_LINES = 3;
const CONSTANT_LINES = 6;
const SMALL_EXCERPT_LINES = 15;
const MAX_TARGETS_PER_REQUEST = 4;
const MAX_TARGET_LINE_CHARS = 160;

// Answer tokens: about 2 a word, counted generously, plus each entry's id and quotes and the
// reply's own braces. The answer is never cut off by num_predict for a comment within its limit.
const TOKENS_PER_WORD = 2;
const TOKENS_PER_ENTRY = 24;
const REPLY_TOKENS = 16;
// The instructions and each target's heading, in tokens, counted generously.
const INSTRUCTION_TOKENS = 600;

// Line comments longer than this are wrapped onto more comment lines.
const LINE_COMMENT_WIDTH = 100;
const CHARS_PER_TOKEN = 3;

const SYNTAX_ERRORS = 'the file has syntax errors';

const MODEL_OPTIONS = (contextTokens) => ({ temperature: 0.2, seed: 42, num_ctx: contextTokens });

// The accuracy check sends at most this many comments per request. Its answer is only a few
// yes or no verdicts per comment, so it may be short.
const ACCURACY_BATCH = 8;
const ACCURACY_PREDICT_TOKENS = 384;

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
function emptyStats(proposed) {
  return {
    proposed,
    added: 0,
    dropped: { placement: {}, length: {}, density: {}, inaccurate: {}, restates: {}, safety: {}, off: {} },
    earlier: { kept: 0, restyled: 0, removed: {} },
  };
}

function isProposal(proposal) {
  return proposal !== null && typeof proposal === 'object';
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
// and given the kind the level calls for. A proposal's line is the line its comment goes
// above, which code chose (see chooseTargets): the model never names one. Returns { rules,
// candidates, rejections, earlierRemoved, symbols, proposed }. At heavy level, symbols lists
// the functions, classes, and components that can take a block comment.
function buildCandidates(ctx, level, groups, { withEarlier = true } = {}) {
  const rules = LEVELS[level];
  const all = groups.flat();
  const built = { rules, candidates: [], rejections: [], earlierRemoved: [], symbols: [], proposed: all.length };
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

  for (const earlier of withEarlier ? ctx.owned : []) {
    const problem = problemAt(earlier.target);
    const cleaned = cleanText(earlier.lines.map(stripMarkers).join('\n'), language);
    const shaped = problem ? { reason: problem } : cleaned.reason ? cleaned : shape(earlier.target, cleaned);
    if (shaped.reason) built.earlierRemoved.push(shaped.reason);
    else add({ source: 'earlier', earlier }, earlier.target, shaped);
  }

  for (const proposal of all) {
    if (!isProposal(proposal) || !Number.isInteger(proposal.line) || proposal.line < 1 || proposal.line > lines.length) {
      reject(proposal, 'line out of range');
      continue;
    }
    const target = resolveTarget(proposal.line, lines, analysis, language);
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
  const stats = emptyStats(built.proposed);
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
// proposals: [{ line, text, kind }], where line is the line the comment goes above, or
// groups: one array of proposals per model response. records: the Docturnal comments
// recorded for this file on earlier runs.
function applyProposals({ text, language, level, proposals, groups = [proposals], records = [], knownUrls }) {
  const ctx = prepareFile({ text, language, level, records, knownUrls });
  return finishFile(ctx, buildCandidates(ctx, level, groups));
}

// The innermost function, class, or component around line index i, as an index, or -1.
function enclosingSymbol(info, i) {
  for (let j = i - 1; j >= 0; j--) if (info[j].symbol && info[j].symbolEnd !== null && info[j].symbolEnd >= i) return j;
  return -1;
}

const isClassLine = (text) => /\bclass\b/.test(text.split('(')[0]);

// The spots that can get a comment, in file order: [{ line, kind, what, name, owner,
// exported, used, start, end, features, in, rank }], where line is the line the comment goes above
// (counted from 1, in ctx.lines), kind is "block" or "line", and what is "function",
// "method", "class", "component", "type", "constant", or "block". Only spots that can take a
// comment are listed: no comment directly above, none of Docturnal's earlier ones there, and
// no placement rule against them. They are chosen within the level's room in the file, as
// selectComments counts it (the comments already there count), and apart by the level's
// minimum gap, so no comment written for one is ever dropped for density.
// exportNames: the names the file exports. usage: Map from a name to how many other files use it.
// at: a Set of lines that hold Docturnal's earlier comments. With it, only those spots are
// listed, whatever the room, since their comments held it: the ones code would choose.
function chooseTargets(ctx, level, { exportNames = [], usage = new Map(), components = false, at = null } = {}) {
  const rules = LEVELS[level];
  if (!rules || ctx.error || !ctx.analysis) return [];
  const { lines, analysis, language } = ctx;
  const info = analysis.info;
  const parsed = parsedTargets(ctx);
  const exported = new Set([...exportNames, ...(parsed.publicNames || [])]);
  const earlierAt = new Set(ctx.owned.map((o) => o.target));
  const free = (line) => line >= 1 && line <= lines.length && (at ? at.has(line) : !earlierAt.has(line)) && !placementProblem(line, lines, analysis, analysis.protectedUntil);

  const declarations = [];
  const seen = new Set();
  info.forEach((li, i) => {
    if (!li.symbol) return;
    const line = resolveTarget(i + 1, lines, analysis, language);
    if (seen.has(line) || !free(line)) return;
    seen.add(line);
    const parent = enclosingSymbol(info, i);
    const inClass = parent >= 0 && isClassLine(lines[parent].text);
    const owner = inClass ? info[parent].symbol : null;
    const end = li.symbolEnd === null ? i : li.symbolEnd;
    const isPrivate = /^[#_]/.test(li.symbol) || /\bprivate\b/.test(lines[i].text);
    const what = isClassLine(lines[i].text) ? 'class' : inClass ? 'method' : components && /^[A-Z]/.test(li.symbol) ? 'component' : 'function';
    declarations.push({
      line,
      what,
      name: li.symbol,
      owner,
      nested: parent >= 0 && !inClass,
      exported: parent === -1 ? exported.has(li.symbol) : inClass && exported.has(owner) && !isPrivate,
      used: usage.get(parent === -1 ? li.symbol : owner || li.symbol) || 0,
      start: line - 1,
      end,
      size: end - i + 1,
      complexity: parsed.blocks.filter((b) => b.line - 1 > i && b.line - 1 <= end).reduce((sum, b) => sum + b.score, 0),
    });
  });
  const others = [];
  for (const e of parsed.exported) {
    if (seen.has(e.line) || !free(e.line) || info[e.line - 1].symbol) continue;
    seen.add(e.line);
    others.push({ line: e.line, what: e.what, name: e.name, exported: true, used: usage.get(e.name) || 0, start: e.line - 1, end: e.end ? e.end - 1 : e.line - 1 });
  }
  if (rules.blocks) {
    info.forEach((li, i) => {
      if (!li.isConstant || seen.has(i + 1) || !free(i + 1)) return;
      seen.add(i + 1);
      const name = (lines[i].text.match(/([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?![=>])/) || [])[1] || null;
      others.push({ line: i + 1, what: 'constant', name, exported: false, used: 0, start: i, end: i });
    });
  }
  const blocks = parsed.blocks
    .filter((b) => !seen.has(b.line) && free(b.line) && (rules.blocks || b.score >= MEDIUM_BLOCK_SCORE))
    .map((b) => ({ ...b, what: 'block', start: b.line - 1, end: b.end - 1 }));

  if (at) {
    const kindOf = (t) => (rules.blocks && info[t.line - 1].isDeclaration ? 'block' : 'line');
    return [...declarations, ...others, ...blocks].map((t) => ({ ...t, kind: kindOf(t) })).sort((a, b) => a.line - b.line);
  }

  // Exported and widely used declarations first, then by size and complexity.
  const important = (d) => d.exported || d.used > 0;
  const byImportance = (a, b) => Number(important(b)) - Number(important(a)) || b.used - a.used ||
    (b.size + 2 * b.complexity) - (a.size + 2 * a.complexity) || a.line - b.line;
  let lineTargets;
  const chosen = [];
  if (rules.blocks) {
    // Heavy: a block comment on every function, class, and component, which no limit counts;
    // exported types take one too. Then constants and complex blocks, as room allows.
    for (const d of [...declarations].sort(byImportance)) chosen.push({ ...d, kind: 'block' });
    for (const o of others.filter((x) => x.what === 'type' && info[x.line - 1].isDeclaration)) chosen.push({ ...o, kind: 'block' });
    lineTargets = [
      ...others.filter((x) => x.what === 'constant'),
      ...blocks.sort((a, b) => b.score - a.score || a.line - b.line),
    ];
  } else if (level === 'medium') {
    const main = declarations.filter((d) => !d.nested && (important(d) || d.size >= MEDIUM_LINES)).sort(byImportance);
    lineTargets = [
      ...main.filter(important),
      ...others.filter((x) => x.what === 'type'),
      ...main.filter((d) => !important(d)),
      ...blocks.sort((a, b) => b.score - a.score || a.line - b.line),
    ];
  } else {
    lineTargets = declarations.filter((d) => !d.nested && (important(d) || d.size >= LOW_LINES)).sort(byImportance);
  }

  // The room for line comments, counted as selectComments counts it.
  const codeLines = info.filter((li) => !li.blank && !li.commentOnly).length;
  const taken = existingCommentPositions(info, rules.blocks);
  for (const o of ctx.owned) if (!(rules.blocks && info[o.target - 1] && info[o.target - 1].isDeclaration)) taken.push(o.target);
  let room = Math.max(1, Math.round(codeLines / rules.linesPerComment)) - taken.length;
  for (const t of lineTargets) {
    if (room <= 0) break;
    const gapExempt = rules.blocks && t.what === 'constant';
    if (!gapExempt && taken.some((pos) => Math.abs(pos - t.line) < rules.minGap)) continue;
    taken.push(t.line);
    chosen.push({ ...t, kind: 'line' });
    room--;
  }
  // rank: the order of importance, 0 first.
  return chosen.map((target, rank) => ({ ...target, rank })).sort((a, b) => a.line - b.line);
}

// A target's code, as numbered lines: [{ index, text }] and whether it was cut short.
function excerptOf(lines, target) {
  let from = target.start;
  let to = target.end;
  if (target.what === 'block') from = Math.max(0, target.start - BLOCK_CONTEXT_LINES);
  if (target.what === 'constant') {
    to = target.start;
    while (to + 1 < lines.length && to + 1 < target.start + CONSTANT_LINES && lines[to + 1].text.trim() !== '') to++;
  }
  to = Math.max(to, target.start);
  const last = Math.min(to, from + MAX_EXCERPT_LINES - 1, lines.length - 1);
  const out = [];
  for (let i = from; i <= last; i++) {
    const text = lines[i].text;
    out.push(`${i + 1}| ${text.length > MAX_TARGET_LINE_CHARS ? `${text.slice(0, MAX_TARGET_LINE_CHARS)}...` : text}`);
  }
  return { lines: out, cut: last < to };
}

const plainName = (name) => String(name).replace(/[`\r\n]/g, '').slice(0, 80);

// What the model is told about a target, with its word limit.
function targetHeading(target, id, level) {
  const words = target.kind === 'block' ? ASK_BLOCK_WORDS : ASK_WORDS[level];
  const name = target.name ? ` \`${plainName(target.name)}\`` : '';
  const facts = [];
  if (target.exported) facts.push('exported');
  if (target.used) facts.push(`used in ${target.used} other ${target.used === 1 ? 'file' : 'files'}`);
  let what;
  if (target.what === 'block') what = `a block in \`${plainName(target.in || 'its function')}\` with ${target.features.join(', ')}`;
  else if (target.what === 'method' && target.owner) what = `the method${name} of \`${plainName(target.owner)}\``;
  else what = `the ${target.what}${name}`;
  return `Target ${id}, line ${target.line}: ${what}${facts.length ? ` (${facts.join(', ')})` : ''}. At most ${words} words.`;
}

// The answer tokens a target needs.
function targetTokens(target, level) {
  return (target.kind === 'block' ? ASK_BLOCK_WORDS : ASK_WORDS[level]) * TOKENS_PER_WORD + TOKENS_PER_ENTRY;
}

// The requests for a file's targets: each target alone, or up to MAX_TARGETS_PER_REQUEST
// small ones together, in file order. Each request's prompt and answer fit the context.
// Returns [{ targets, messages, numPredict }].
function buildTargetRequests({ path, language, level, lines, targets, contextTokens }) {
  const excerpts = targets.map((t) => excerptOf(lines, t));
  const groups = [];
  let current = [];
  let size = 0;
  targets.forEach((target, i) => {
    const n = excerpts[i].lines.length;
    const small = n <= SMALL_EXCERPT_LINES;
    if (current.length && (!small || current.length >= MAX_TARGETS_PER_REQUEST || size + n > MAX_EXCERPT_LINES)) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += n;
    if (!small) {
      groups.push(current);
      current = [];
      size = 0;
    }
  });
  if (current.length) groups.push(current);

  return groups.map((group) => {
    const numPredict = REPLY_TOKENS + group.reduce((sum, i) => sum + targetTokens(targets[i], level), 0);
    // A target whose code does not fit, with lines of up to MAX_TARGET_LINE_CHARS, is cut short.
    const room = Math.max(200, contextTokens - INSTRUCTION_TOKENS - numPredict) * CHARS_PER_TOKEN;
    const share = Math.floor(room / group.length);
    const parts = group.map((i, k) => {
      const excerpt = excerpts[i];
      const shown = [];
      let chars = 0;
      for (const line of excerpt.lines) {
        if (shown.length && chars + line.length + 1 > share) break;
        shown.push(line);
        chars += line.length + 1;
      }
      const cut = excerpt.cut || shown.length < excerpt.lines.length;
      return `${targetHeading(targets[i], k + 1, level)}\n${shown.join('\n')}${cut ? '\n...' : ''}`;
    });
    return {
      targets: group.map((i) => targets[i]),
      numPredict,
      messages: [
        { role: 'system', content: TARGET_PROMPT },
        { role: 'user', content: `File: ${path}\nLanguage: ${language.name}\n\n${parts.join('\n\n')}` },
      ],
    };
  });
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
// limit: the entries that were complete.
function salvageReply(content) {
  const out = { comments: [] };
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

// Why a request gave no comments, or only part of its answer, by category. The log gives
// these, never the reply.
const REPLY_CAUSES = {
  failed: 'the request failed',
  length: 'the reply stopped at its length limit',
  context: 'the prompt and the reply filled the context',
  json: 'the reply is not valid JSON',
  noList: 'the reply has no comments list',
  none: 'the model wrote none',
  missing: 'the reply left out some targets',
};

// Reads one reply: a string, or { content, doneReason, promptTokens, replyTokens } from a
// chat function that gives them. count: the request's targets, with ids 1 to count.
// Returns { texts: Map from id to text, cause }, where cause is null when every target has
// a comment. Throws when nothing in it can be used.
function readReply(reply, { contextTokens, count }) {
  const raw = reply && typeof reply === 'object' ? reply : { content: reply };
  const content = typeof raw.content === 'string' ? raw.content : '';
  const full = Number.isInteger(raw.promptTokens) && Number.isInteger(raw.replyTokens) && raw.promptTokens + raw.replyTokens >= contextTokens - 8;
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    data = undefined;
  }
  let entries;
  let cause = null;
  let salvaged = false;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    cause = raw.doneReason === 'length' ? REPLY_CAUSES.length : full ? REPLY_CAUSES.context : REPLY_CAUSES.json;
    entries = salvageReply(content).comments;
    salvaged = true;
    if (!entries.length) throw new Error(cause);
  } else if (!Array.isArray(data.comments)) {
    throw new Error(REPLY_CAUSES.noList);
  } else {
    entries = data.comments;
  }
  const texts = new Map();
  for (const entry of entries) {
    if (!isProposal(entry) || !Number.isInteger(entry.id) || entry.id < 1 || entry.id > count || texts.has(entry.id)) continue;
    if (typeof entry.text === 'string' && entry.text.trim()) texts.set(entry.id, entry.text);
  }
  if (!cause && texts.size < count) cause = texts.size ? REPLY_CAUSES.missing : full ? REPLY_CAUSES.context : REPLY_CAUSES.none;
  return { texts, cause, salvaged };
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

// Step 1 of 4, without a model: reads the file, takes out Docturnal's earlier comments
// (records), and chooses the targets and the requests for them. exportNames and usage rank
// the targets (see chooseTargets). Returns a plan for proposeComments, checkComments, and
// finishComments, with plan.targets and plan.planned (the requests to make).
function planTargets({ path, text, level = 'medium', contextTokens = 8192, records = [], knownUrls, exportNames = [], usage = new Map() }) {
  const language = languageForPath(path);
  const plan = { path, language: language && language.id, level, text, failedRequests: 0, errors: [], replies: [], targets: [], more: 0, replaceable: [], planned: [], next: 0, groups: [], requests: 0, proposeMs: 0, checkMs: 0, checkRequests: 0, ctx: null, built: null, verdicts: new Map() };
  if (!language) return { ...plan, skipped: 'unsupported language' };
  if (isMinified(splitLines(stripBom(text).body))) return { ...plan, skipped: 'minified' };
  const ctx = prepareFile({ text, language, level, records, knownUrls });
  if (ctx.syntaxError) return { ...plan, skipped: SYNTAX_ERRORS };
  plan.ctx = ctx;
  const choices = { exportNames, usage, components: /\.(jsx|tsx)$/i.test(path) };
  // The highest-ranked targets, up to the level's cap for one run; plan.more counts the rest.
  const ranked = chooseTargets(ctx, level, choices).sort((a, b) => a.rank - b.rank);
  const taken = ranked.slice(0, PER_RUN[level] ?? ranked.length);
  plan.more = ranked.length - taken.length;
  plan.targets = [...taken].sort((a, b) => a.line - b.line);
  plan.replaceable = ctx.owned.length ? chooseTargets(ctx, level, { ...choices, at: new Set(ctx.owned.map((o) => o.target)) }) : [];
  plan.contextTokens = contextTokens;
  // The requests go in order of importance, so the first one asks for the best targets.
  plan.planned = taken.length
    ? buildTargetRequests({ path, language, level, lines: ctx.lines, targets: taken, contextTokens })
    : [];
  plan.built = buildCandidates(ctx, level, []);
  return plan;
}

// Sends requests and reads their replies: one group of proposals per request, each comment
// above its target's line. Counts the requests, their time, and each reply's cause.
// shouldStop(written, request): true when the time left does not fit the next request and the
// checks of the comments written so far; the rest of the file is then left (plan.unfinished).
async function writeTargets(plan, requests, { model, contextTokens = 8192, chat = ollama.chat, host, now = Date.now, shouldStop = () => false }) {
  const started = now();
  const groups = [];
  for (const request of requests) {
    if (shouldStop(groups.flat().length, request)) {
      plan.unfinished = true;
      break;
    }
    const span = request.targets.map((t) => t.line).join(', ');
    try {
      plan.requests++;
      const reply = await chat({
        label: `comments for ${plan.path}, ${request.targets.length === 1 ? 'line' : 'lines'} ${span}`,
        model,
        host,
        messages: request.messages,
        format: TARGET_SCHEMA,
        options: { ...MODEL_OPTIONS(contextTokens), num_predict: request.numPredict },
        withReason: true,
      });
      const parsed = readReply(reply, { contextTokens, count: request.targets.length });
      const group = [...parsed.texts].map(([id, text]) => {
        const target = request.targets[id - 1];
        return { line: target.line, text, kind: target.kind };
      });
      groups.push(group);
      plan.replies.push({ lines: span, asked: request.targets.length, proposed: group.length, cause: parsed.cause, salvaged: parsed.salvaged });
    } catch (err) {
      plan.failedRequests++;
      plan.errors.push(`lines ${span}: ${err.message}`);
      plan.replies.push({ lines: span, asked: request.targets.length, proposed: 0, cause: Object.values(REPLY_CAUSES).includes(err.message) ? err.message : REPLY_CAUSES.failed });
    }
  }
  plan.proposeMs += now() - started;
  return groups;
}

// Step 2 of 4, with the comment model: one request per planned group of targets.
async function proposeComments(plan, options) {
  if (plan.skipped || !plan.ctx) return plan;
  while (await proposeNext(plan, options));
  return settleProposals(plan);
}

// One request at a time, so a run can take turns between files: sends the plan's next
// planned request. Returns false when none is left, or shouldStop says there is no time.
async function proposeNext(plan, options) {
  if (plan.skipped || !plan.ctx || plan.next >= plan.planned.length) return false;
  const request = plan.planned[plan.next];
  if (options.shouldStop && options.shouldStop(plan.groups.flat().length, request)) return false;
  plan.next++;
  plan.groups.push(...(await writeTargets(plan, [request], { ...options, shouldStop: undefined })));
  return true;
}

// After the requests: the candidates for the check, and whether the time left any request
// unmade (plan.unfinished).
function settleProposals(plan) {
  if (plan.skipped || !plan.ctx) return plan;
  plan.unfinished = plan.next < plan.planned.length;
  plan.built = limitToLevel(plan.ctx, buildCandidates(plan.ctx, plan.level, plan.groups));
  return plan;
}

// After the check, step 3b: an earlier Docturnal comment the check found inaccurate is
// replaced, when its spot is one code would choose: the comment model writes a new one there,
// and the check model checks it. write and check: { chat, model, host } for each model.
// A replacement that cannot be written or checked is left out; the earlier comment is still
// removed. Throws nothing.
async function replaceInaccurate(plan, { write, check, now = Date.now }) {
  if (!plan.built || !plan.replaceable.length) return plan;
  const wrong = new Set(plan.built.candidates
    .filter((c) => c.source === 'earlier' && (plan.verdicts.get(c) || {}).accurate === false)
    .map((c) => c.target));
  const targets = plan.replaceable.filter((t) => wrong.has(t.line));
  if (!targets.length) return plan;
  const contextTokens = plan.contextTokens;
  const requests = buildTargetRequests({ path: plan.path, language: plan.ctx.language, level: plan.level, lines: plan.ctx.lines, targets, contextTokens });
  const groups = await writeTargets(plan, requests, { ...write, contextTokens, now });
  const added = buildCandidates(plan.ctx, plan.level, groups, { withEarlier: false });
  plan.built.proposed += added.proposed;
  plan.built.rejections.push(...added.rejections);
  if (!added.candidates.length) return plan;
  plan.built.candidates.push(...added.candidates);
  try {
    await checkComments(plan, { ...check, contextTokens, now, only: added.candidates });
  } catch (err) {
    plan.errors.push(`accuracy check of the replacements: ${err.message}`);
    plan.built.candidates = plan.built.candidates.filter((c) => !added.candidates.includes(c));
  }
  return plan;
}

// Steps 1 and 2 together. Returns the plan for checkComments and finishComments, with
// plan.replies giving, for each request, its lines, how many targets it asked for and got,
// and the cause when it gave fewer, and plan.proposeMs and plan.requests the time and the
// requests it took.
async function planComments(options) {
  const plan = planTargets(options);
  return proposeComments(plan, options);
}

// How many accuracy-check requests a plan needs.
function checkRequests(plan) {
  return plan.built ? Math.ceil(plan.built.candidates.length / ACCURACY_BATCH) : 0;
}

// Whether the plan has comments for the accuracy check.
function needsCheck(plan) {
  return Boolean(plan.built && plan.built.candidates.length);
}

// Step 3 of 4: asks whether each candidate comment, earlier or new, is true of the code
// under it, ACCURACY_BATCH comments per request. `chat` and `model` may be the docs
// model's. Sets plan.verdicts. only: the candidates to check, whose verdicts are added to
// the ones before (every candidate by default).
// Throws when the check gets no usable answer.
async function checkComments(plan, { chat = ollama.chat, model, host, contextTokens = 8192, now = Date.now, only = null }) {
  if (!needsCheck(plan)) return plan;
  const started = now();
  try {
    await checkAll(plan, { chat, model, host, contextTokens, only });
  } finally {
    plan.checkMs += now() - started;
  }
  return plan;
}

async function checkAll(plan, { chat, model, host, contextTokens, only }) {
  const candidates = only || plan.built.candidates;
  for (const c of candidates) {
    if (c.source === 'model' && c.kind === 'line') c.functionComment = functionCommentFor(plan.ctx, plan.built, c.target);
  }
  const items = [...candidates].sort(byRank).map((c) => ({
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
  plan.verdicts = only ? new Map([...plan.verdicts, ...verdicts]) : verdicts;
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

// Step 4 of 4, without a model: selects, inserts, and verifies.
// Returns { path, language, text, added, rejected, rejections, stats, records,
// undocumented, failedRequests, errors, skipped }.
function finishComments(plan) {
  if (plan.skipped) return { ...unchanged(plan), skipped: plan.skipped };
  return { ...headOf(plan), ...finishFile(plan.ctx, plan.built, plan.verdicts) };
}

function headOf(plan) {
  return { path: plan.path, language: plan.language, failedRequests: plan.failedRequests, errors: plan.errors };
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
    const check = { ...options, model: options.checkModel || options.model };
    try {
      await checkComments(plan, check);
    } catch (err) {
      plan.errors.push(`accuracy check: ${err.message}`);
      return { ...unchanged(plan), checkFailed: err.message };
    }
    await replaceInaccurate(plan, { write: options, check, now: options.now });
  }
  return finishComments(plan);
}

// The replies line for the log, when a request gave fewer comments than it asked for: each
// request's lines and cause, with counts only.
function replySummary(plan) {
  const notable = (plan.replies || []).filter((r) => r.cause);
  if (!notable.length) return '';
  return `replies: ${notable.map((r) => `lines ${r.lines}: ${r.cause}${r.salvaged ? `, ${r.proposed} complete ${r.proposed === 1 ? 'comment' : 'comments'} kept` : r.cause === REPLY_CAUSES.missing ? `, ${r.proposed} of ${r.asked}` : ''}`).join('; ')}`;
}

module.exports = {
  CATEGORY,
  LEVELS,
  MAX_EXCERPT_LINES,
  MAX_TARGETS_PER_REQUEST,
  PER_RUN,
  REPLY_CAUSES,
  TARGET_SCHEMA,
  applyProposals,
  buildTargetRequests,
  checkComments,
  checkRequests,
  chooseTargets,
  cleanText,
  commentFile,
  finishComments,
  needsCheck,
  planComments,
  planTargets,
  prepareFile,
  proposeComments,
  proposeNext,
  settleProposals,
  readReply,
  replaceInaccurate,
  replySummary,
  salvageReply,
};
