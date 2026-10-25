'use strict';

// Keeps a layer doc's prose to what its material says. The material is the layer's
// description, its folder summaries, and each file's path, purpose, and definitions. A
// sentence is kept when it shares specific terms with the material and has at most one term the
// material lacks for every five it has, so "Extracts documentation tags and TODOs from
// comments" and "Formats comments for display" are dropped from a layer whose material never
// mentions tags, TODOs, or display, though it says comments. Words that say nothing about this
// code ("provides", "files", "relevant") count either way, and terms match by their first five
// letters, so "changed" matches "changes".

const { stem, words } = require('./restates');

// A sentence may have one term the material lacks for every this many specific terms.
const TERMS_PER_MISSING = 5;
// An Overview with fewer words left is replaced by one built from the folder summaries.
const MIN_OVERVIEW_WORDS = 12;
// A sentence repeats another when this share of their terms is the same, counted against the
// one with more; a sentence with fewer terms than MIN_REPEAT_TERMS repeats only the same words.
const REPEAT_SHARE = 0.8;
const MIN_REPEAT_TERMS = 3;

const COMMON = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those', 'which', 'what',
  'when', 'where', 'while', 'then', 'than', 'its', 'their', 'there', 'they', 'them', 'you', 'your', 'are',
  'was', 'were', 'been', 'being', 'has', 'have', 'had', 'does', 'did', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'not', 'any', 'all', 'each', 'every', 'both', 'such', 'also', 'only', 'one',
  'two', 'more', 'most', 'other', 'others', 'some', 'many', 'much', 'very', 'well', 'how', 'who', 'why',
  'here', 'like', 'just', 'about', 'over', 'under', 'between', 'through', 'before', 'after', 'within',
  'without', 'own', 'same', 'new', 'via', 'per', 'out', 'get', 'gets', 'set', 'sets', 'use', 'uses',
  'used', 'using', 'make', 'makes', 'made', 'need', 'needs', 'help', 'helps', 'provide', 'provides',
  'handle', 'handles', 'contain', 'contains', 'include', 'includes', 'including', 'ensure', 'ensures',
  'allow', 'allows', 'work', 'works', 'responsible', 'part', 'parts', 'various', 'different', 'several',
  'multiple', 'specific', 'main', 'key', 'core', 'based', 'related', 'way', 'ways', 'thing', 'things',
  'code', 'codebase', 'file', 'files', 'folder', 'folders', 'layer', 'layers', 'module', 'modules',
  'function', 'functions', 'project', 'logic', 'system', 'component', 'components', 'feature',
  'features', 'functionality', 'source', 'implementation', 'implements', 'defines', 'define', 'js',
  'ts', 'mjs', 'cjs', 'py', 'src', 'relevant', 'information', 'further', 'meaningful', 'correctly',
  'properly', 'appropriate', 'necessary', 'needed', 'important', 'overall', 'focus', 'focuses', 'able',
  'above', 'below', 'given', 'expected', 'certain', 'available', 'actual', 'whole', 'together', 'first',
  'last', 'next', 'live', 'lives', 'become', 'becomes',
]);

// The specific terms of a text: its words and identifiers, split, without the common ones, and
// cut to their first five letters after stemming.
function terms(text) {
  return words(String(text || '')).filter((w) => w.length > 2 && !COMMON.has(w)).map((w) => stem(w).slice(0, 5));
}

// The terms of a layer's material. folders: Map(dir -> summary); fileInfo: Map(path -> { summary, symbols }).
function layerMaterial(layer, fileInfo, folders = new Map()) {
  const parts = [layer.name, layer.description];
  for (const dir of new Set(layer.files.map((f) => f.split('/').slice(0, -1).join('/') || '.'))) {
    parts.push(dir, folders.get(dir) || '');
  }
  for (const file of layer.files) {
    const info = fileInfo.get(file) || {};
    parts.push(file, info.summary || '', ...(info.symbols || []));
  }
  return new Set(terms(parts.join('\n')));
}

// Whether a sentence is grounded in the material.
function grounded(sentence, material) {
  const specific = [...new Set(terms(sentence.replace(/\]\([^)]*\)/g, ']')))];
  if (!specific.length) return false;
  const missing = specific.filter((t) => !material.has(t)).length;
  return missing < specific.length && missing <= Math.floor(specific.length / TERMS_PER_MISSING);
}

function sentences(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/).filter((s) => s.trim());
}

// Keeps the sentences of a section's Markdown that keep(text) accepts: paragraphs sentence by
// sentence, list items whole, code blocks as they are, and a subheading only when something
// under it stays. Returns the text, or ''.
function filterSection(markdown, keep) {
  const blocks = [];
  let fence = null;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const kept = sentences(paragraph.join(' ')).filter((s) => keep(s));
    if (kept.length) blocks.push({ kind: 'text', text: kept.join(' ') });
    paragraph = [];
  };
  for (const line of String(markdown || '').split('\n')) {
    if (fence !== null) {
      fence.push(line);
      if (/^\s*(```|~~~)/.test(line)) {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = null;
      }
    } else if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = [line];
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ kind: 'heading', text: line });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      if (keep(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))) blocks.push({ kind: 'item', text: line });
    } else if (/^\s{2,}\S/.test(line) && blocks.length && blocks[blocks.length - 1].kind === 'item' && !paragraph.length) {
      blocks[blocks.length - 1].text += `\n${line}`;
    } else if (!line.trim()) {
      flush();
      blocks.push({ kind: 'blank' });
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  if (fence !== null) blocks.push({ kind: 'code', text: fence.join('\n') });
  // A subheading with nothing kept under it goes too.
  const out = blocks.filter((block, i) => {
    if (block.kind !== 'heading') return true;
    const next = blocks.slice(i + 1).find((b) => b.kind !== 'blank');
    return next && next.kind !== 'heading';
  });
  const lines = [];
  for (const block of out) {
    if (block.kind === 'blank') {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    } else if (block.kind === 'item') {
      lines.push(block.text);
    } else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(block.text, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The grounded sentences of a section. stats.ungrounded counts the sentences and items dropped.
function groundSection(markdown, material, stats = {}) {
  return filterSection(markdown, (s) => {
    if (grounded(s, material)) return true;
    stats.ungrounded = (stats.ungrounded || 0) + 1;
    return false;
  });
}

// Drops the sentences and list items that repeat one already in the doc: most of their terms
// the same, or, for one with few terms, the same words. seen: what the doc already says, earlier
// sections first; what is kept is added to it. stats.repeated counts the drops.
function withoutRepeats(markdown, seen, stats = {}) {
  return filterSection(markdown, isNew(seen, stats));
}

// The check withoutRepeats makes, for one sentence or item at a time.
function isNew(seen, stats = {}) {
  return (s) => {
    const own = new Set(terms(s));
    const plain = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const repeat = seen.some((other) => {
      if (own.size < MIN_REPEAT_TERMS || other.terms.size < MIN_REPEAT_TERMS) return plain === other.plain;
      let both = 0;
      for (const t of own) if (other.terms.has(t)) both++;
      return both / Math.max(own.size, other.terms.size) >= REPEAT_SHARE;
    });
    if (repeat) {
      stats.repeated = (stats.repeated || 0) + 1;
      return false;
    }
    seen.push({ terms: own, plain });
    return true;
  };
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

// An Overview built from the summaries of a layer's folders, largest folder first. A folder in
// sharedDirs, whose files other layers hold too, is left out: its summary is about more than
// this layer.
function folderOverview(layer, folders = new Map(), sharedDirs = new Set()) {
  const counts = new Map();
  for (const file of layer.files) {
    const dir = file.split('/').slice(0, -1).join('/') || '.';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  const dirs = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([dir]) => dir);
  const summaries = dirs.filter((dir) => !sharedDirs.has(dir)).map((dir) => folders.get(dir)).filter(Boolean).slice(0, 3);
  return summaries.join(' ');
}

module.exports = { TERMS_PER_MISSING, MIN_OVERVIEW_WORDS, filterSection, folderOverview, groundSection, grounded, isNew, layerMaterial, terms, withoutRepeats, wordCount };
