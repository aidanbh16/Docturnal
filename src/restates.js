'use strict';

// A deterministic check for comments that only restate the code under them. It measures
// how many of the comment's content words the code already says, through its identifiers
// or its syntax. The model's usefulness answer runs first; this catches what it lets through.

// The share of content words the code must cover for a comment to count as a restatement.
const RESTATES_AT = 0.6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'it', 'its', 'each', 'current', 'total', 'value',
  'amount', 'is', 'are', 'be', 'been', 'was', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'into', 'then', 'which', 'will', 'can', 'if', 'all', 'any', 'given', 'so',
]);

// Words that make a comment worth keeping even when the code covers the rest of it.
const REASON = /\b(because|so that|to avoid|to prevent|otherwise|must|never|always|assumes?|note|why)\b/i;
const EDGE_CASE = /\b(zero|negative|empty|null|overflow)\b/i;
const UNITS = ['hour', 'cent', 'percent', 'second', 'minute', 'millisecond', 'day', 'week', 'month', 'year', 'byte', 'kilobyte', 'megabyte'];

// Words the syntax says without naming them. Each pattern is tested against the code text.
const IMPLIED = [
  [/\breturn\b/, ['returns']],
  [/\breturn\s*[{[(]?\s*\{/, ['object', 'containing', 'contains']],
  [/\+=/, ['adds', 'increments', 'plus']],
  [/-=/, ['subtracts', 'decrements', 'minus']],
  [/[^+=]\+[^+=]/, ['adds', 'plus', 'sum']],
  [/[^*]\*[^*=]/, ['multiplies', 'times', 'product']],
  [/[^/*]\/[^/*=]/, ['divides', 'divided']],
  [/\bmin\b/i, ['minimum', 'up', 'cap', 'caps', 'limits', 'most']],
  [/\bmax\b/i, ['maximum', 'least']],
  [/\bround/i, ['rounds', 'nearest']],
  [/\b(throw|raise)\b/, ['throws', 'raises', 'error']],
  [/\bnew\s+\w*Error\b/, ['error']],
  [/\b(for|while|forEach|map)\b/, ['iterates', 'loops', 'goes', 'through']],
  [/\bif\b/, ['checks', 'when', 'whether']],
  [/\bbreak\b/, ['stops', 'exits']],
  [/\bawait\b/, ['waits']],
  [/(^|[^=!<>])=($|[^=>])/, ['calculates', 'computes', 'stores', 'sets', 'gets', 'assigns', 'initializes']],
];

// Splits identifiers (camelCase, snake_case, SCREAMING_CASE) and text into lowercase words.
function words(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/'s\b/g, '')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// A light stemmer, applied to both sides, so "rounded", "rounds", and "round" match.
function stem(word) {
  if (word.length > 4 && /ie[sd]$/.test(word)) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// A comment that narrates a declaration: "It initializes a pending variable to track any
// pending operations." above `let pending = null;`. After the verb, its words name the line's
// identifiers, or say nothing about the code (FILLER).
const NARRATES = /^\s*(?:(?:it|this)\s+)?(?:initiali[sz]es|sets|declares|creates|defines|assigns|stores|holds|instantiates|introduces)\b/i;
const FILLER = new Set(['variable', 'var', 'constant', 'track', 'tracking', 'keep', 'hold', 'store', 'operation', 'later', 'use', 'new', 'local', 'flag', 'state', 'data', 'information', 'instance', 'object', 'reference', 'placeholder', 'initial', 'default', 'up', 'some', 'possible', 'potential']
  .map((w) => stem(w)));

// True when the comment narrates the declaration on firstLine: an "It"/"This" and a verb such
// as initializes, then only words that are the line's identifiers or filler.
function narratesDeclaration(comment, firstLine) {
  const lead = NARRATES.exec(comment);
  if (!lead) return false;
  const identifiers = new Set(words(firstLine).map(stem));
  const rest = words(comment.slice(lead[0].length)).filter((w) => !STOPWORDS.has(w)).map(stem);
  return rest.every((w) => identifiers.has(w) || FILLER.has(w));
}

// codeLines: the code under the comment, without line numbers.
// Returns { coverage, reason, narrates } where coverage is the share of the comment's content
// words the code covers (null when the comment has none), reason says why it is kept anyway,
// and narrates is true for a comment that only narrates the declaration under it.
function restatement(comment, codeLines) {
  const code = codeLines.join('\n');
  const codeStems = new Set(words(code).map(stem));
  for (const [pattern, implied] of IMPLIED) {
    if (pattern.test(code)) implied.forEach((w) => codeStems.add(stem(w)));
  }
  const content = [...new Set(words(comment).filter((w) => !STOPWORDS.has(w)).map(stem))];

  let reason = null;
  if (REASON.test(comment)) reason = 'states a reason';
  else if (EDGE_CASE.test(comment)) reason = 'names an edge case';
  else if (UNITS.some((unit) => content.includes(stem(unit)) && !codeStems.has(stem(unit)))) reason = 'names a unit';

  const narrates = narratesDeclaration(comment, codeLines[0] || '');
  if (!content.length) return { coverage: null, reason, narrates };
  const covered = content.filter((w) => codeStems.has(w)).length;
  return { coverage: covered / content.length, reason, narrates };
}

// True when the comment only restates the code.
function restates(result) {
  if (result.reason) return false;
  return result.narrates === true || (result.coverage !== null && result.coverage >= RESTATES_AT);
}

// The verbs a name implies, so "Returns the value." says no more than getValue.
const NAME_VERBS = {
  get: ['return', 'retrieve', 'fetch', 'obtain', 'read', 'give'],
  set: ['update', 'assign', 'store', 'change', 'write'],
  is: ['check', 'whether', 'return', 'true', 'false'],
  has: ['check', 'whether', 'return', 'true', 'false', 'contain'],
  can: ['check', 'whether', 'return'],
  should: ['check', 'whether', 'return'],
  create: ['make', 'build', 'construct', 'new', 'return'],
  make: ['create', 'build', 'construct', 'new', 'return'],
  build: ['create', 'make', 'construct', 'return'],
  to: ['convert', 'return'],
  on: ['handle', 'event'],
  handle: ['event'],
  add: ['append', 'insert'],
  remove: ['delete'],
  delete: ['remove'],
  init: ['initialize', 'set'],
  calc: ['calculate', 'compute', 'return'],
  compute: ['calculate', 'return'],
};
// Words that say only what kind of declaration it is.
const KIND_WORDS = new Set(['function', 'method', 'class', 'component', 'helper', 'hook', 'type', 'interface', 'object', 'instance', 'specified', 'provided', 'new', 'data', 'thing', 'something', 'one', 'some', 'here', 'exported', 'export']
  .map((w) => stem(w)));

// True when a summary adds nothing beyond its declaration's own name: "Gets the value." for
// getValue. names: the declaration's name, and its class's name for a method.
function onlyItsName(comment, names) {
  const own = new Set();
  for (const w of names.filter(Boolean).flatMap((n) => words(String(n)))) {
    own.add(stem(w));
    for (const v of NAME_VERBS[w] || []) own.add(stem(v));
  }
  if (!own.size) return false;
  const content = words(comment).filter((w) => !STOPWORDS.has(w)).map(stem);
  return content.every((w) => own.has(w) || KIND_WORDS.has(w));
}

module.exports = { RESTATES_AT, onlyItsName, restatement, restates, stem, words };
