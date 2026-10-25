'use strict';

// Generated text never invents a web link. A link is kept only when the same URL already
// appears in the repository: its tracked text files, the README, or package.json's homepage,
// repository, and bugs. Other links become plain text, or are removed when the URL is the
// text; images from outside URLs and raw HTML are removed. Only counts are logged, never URLs.

const fs = require('fs');
const path = require('path');

const { listFiles } = require('./git');
const { isPlainPath } = require('./safe-path');

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// The most bytes read from one file when collecting URLs.
const MAX_SCAN_BYTES = 1024 * 1024;

// Trailing punctuation belongs to the sentence, and an unmatched ")" to Markdown.
function trimUrl(url) {
  let out = url.replace(/[.,;:!?*_~]+$/, '');
  while (out.endsWith(')') && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) out = out.slice(0, -1).replace(/[.,;:!?*_~]+$/, '');
  return out;
}

function normalizeUrl(url) {
  const trimmed = trimUrl(url);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function addUrlsFrom(text, known) {
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizeUrl(match[0]);
    if (url) known.add(url);
  }
}

// package.json's repository can be "github:owner/name", "owner/name", or a git URL.
function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository && repository.url;
  if (typeof value !== 'string') return null;
  const shorthand = value.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  return value.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

const cache = new Map();

// The URLs the repository already has, read once per run, before Docturnal writes anything.
function knownUrls(cwd) {
  if (cache.has(cwd)) return cache.get(cwd);
  const known = new Set();
  let files = [];
  try {
    files = listFiles(cwd);
  } catch {
    // Not a git repository, as in some tests: nothing is known.
  }
  for (const file of new Set([...files, 'README.md'])) {
    try {
      const full = path.join(cwd, file);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
      const buffer = fs.readFileSync(full);
      if (buffer.includes(0)) continue;
      addUrlsFrom(buffer.toString('utf8'), known);
    } catch {
      // A file that cannot be read adds nothing.
    }
  }
  try {
    if (!isPlainPath(cwd, 'package.json')) throw new Error('a symbolic link');
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    for (const value of [pkg.homepage, repositoryUrl(pkg.repository), pkg.bugs && (typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url)]) {
      if (typeof value === 'string') addUrlsFrom(value, known);
    }
  } catch {
    // No package.json.
  }
  cache.set(cwd, known);
  return known;
}

function isKnown(url, known) {
  const normalized = normalizeUrl(url);
  return Boolean(normalized && known && known.has(normalized));
}

// True when text has a URL the repository does not.
function hasUnknownUrl(text, known) {
  for (const match of String(text).matchAll(URL_PATTERN)) if (!isKnown(match[0], known)) return true;
  return false;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

// Cleans one line of generated Markdown prose (not code). stats.droppedLinks counts what
// was dropped.
function cleanProseLine(line, known, stats) {
  let dropped = 0;
  const drop = () => {
    dropped++;
    stats.droppedLinks = (stats.droppedLinks || 0) + 1;
  };
  // Code spans are kept, unless they hold an unknown URL, such as an invented download command.
  const parts = line.split(/(`+[^`]*`+)/);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) {
      if (hasUnknownUrl(part, known)) {
        drop();
        return '';
      }
      return part;
    }
    let text = part
      // Images from outside URLs, and badges, are never added.
      .replace(/!\[([^\]\n]*)\]\(([^)\s]*)(\s+"[^"]*")?\)/g, (match, alt, target) => {
        if (!EXTERNAL.test(target)) return match;
        drop();
        return '';
      })
      .replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]*)(\s+"[^"]*")?\)/gi, (match, label, target) => {
        if (isKnown(target, known)) return match;
        drop();
        return label;
      })
      .replace(/<(https?:\/\/[^>\s]+)>/gi, (match, target) => {
        if (isKnown(target, known)) return match;
        drop();
        return '';
      })
      // Raw HTML, comments included: generated text has none. Docturnal adds its own markers
      // after this.
      .replace(/<!--[\s\S]*?-->/g, () => {
        drop();
        return '';
      })
      .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, () => {
        drop();
        return '';
      });
    // Bare URLs, outside the links kept above.
    text = text.replace(/(\]\()?(\bhttps?:\/\/[^\s<>"'`]+)/gi, (match, linkOpen, url) => {
      if (linkOpen || isKnown(url, known)) return match;
      drop();
      return url.slice(trimUrl(url).length);
    });
    return text;
  });
  if (!dropped) return line;
  // Only a line that lost something is tidied, so indentation and hard breaks stay.
  const indent = line.match(/^\s*/)[0];
  return indent + out.join('').slice(indent.length).replace(/ {2,}/g, ' ').replace(/ +([.,;:])/g, '$1').replace(/\(\s*\)/g, '').trimEnd();
}

// A line inside a fenced code block: dropped when it holds an unknown URL.
function keepCodeLine(line, known, stats) {
  if (!hasUnknownUrl(line, known)) return true;
  stats.droppedLinks = (stats.droppedLinks || 0) + 1;
  return false;
}

// Forgets what knownUrls read, for a new run in the same folder.
function forgetKnownUrls(cwd) {
  cache.delete(cwd);
}

module.exports = { cleanProseLine, forgetKnownUrls, hasUnknownUrl, keepCodeLine, knownUrls, normalizeUrl, repositoryUrl };
