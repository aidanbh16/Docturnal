'use strict';

// Orders existing code by importance, so the first batches comment the files a reader most
// needs: entry points, files many others import, complex files, and files that change often.
// Then picks one batch, kept within as few layers as it can, so a pull request reviews like
// one area of the project.

const path = require('path');
const ts = require('typescript');

const JS_TS = /\.(c|m)?(j|t)sx?$/;
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.d.ts'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs', '__init__.py'];

// What a file imports, as written: module names and paths.
function importSpecifiers(file, text) {
  if (JS_TS.test(file)) {
    try {
      return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
    } catch {
      return [];
    }
  }
  if (/\.pyi?$/.test(file)) {
    const out = [];
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import\b/gm)) out.push(m[1]);
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) out.push(...m[1].split(',').map((s) => s.trim()));
    return out;
  }
  // Other languages: a quoted path after an include, require, import, use, or source.
  const out = [];
  for (const m of text.matchAll(/(?:#\s*include|\brequire(?:_relative)?|\bimport|\bsource|\buse|\bload)\s*\(?\s*["'<]([^"'>\n]+)["'>]/g)) out.push(m[1]);
  return out;
}

// The repository file an import names, or null for a package or anything not in the repo.
function resolveImport(from, specifier, known) {
  const tryPath = (base) => {
    for (const ext of RESOLVE_EXTENSIONS) if (known.has(base + ext)) return base + ext;
    for (const index of INDEX_FILES) if (known.has(path.posix.join(base, index))) return path.posix.join(base, index);
    return null;
  };
  const dir = path.posix.dirname(from);
  if (specifier.startsWith('./') || specifier.startsWith('../')) return tryPath(path.posix.normalize(path.posix.join(dir, specifier)));
  if (/\.pyi?$/.test(from)) {
    // Python: a dotted module, relative to the package for leading dots, otherwise to the root.
    const dots = specifier.match(/^\.*/)[0].length;
    const parts = specifier.slice(dots).split('.').filter(Boolean);
    let base = '';
    if (dots) {
      base = dir;
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    }
    const target = path.posix.join(base === '.' ? '' : base, ...parts);
    return tryPath(target) || tryPath(path.posix.join(dir, ...parts));
  }
  if (specifier.startsWith('/')) return tryPath(specifier.slice(1));
  // Other languages name paths relative to the file or to the root.
  return tryPath(path.posix.normalize(path.posix.join(dir, specifier))) || tryPath(path.posix.normalize(specifier));
}

// The paths package.json names as entry points: main, bin, and exports.
function packageEntries(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];
  const out = [];
  const collect = (value) => {
    if (typeof value === 'string') out.push(path.posix.normalize(value.replace(/^\.\//, '')));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(packageJson.main);
  collect(packageJson.bin);
  collect(packageJson.exports);
  return out;
}

function isEntryPoint(file, entries) {
  const base = path.posix.basename(file);
  if (entries.has(file)) return true;
  if (/^index\.[\w]+$/.test(base) || base === '__main__.py' || base === 'main.py' || base === 'main.go') return true;
  return /(^|\/)(routes?|handlers?|controllers?)\//i.test(file) || /(route|handler|controller)s?\.[\w]+$/i.test(base);
}

// Functions and branches: a rough measure of how much there is to explain.
function complexity(text) {
  return (text.match(/\b(function|def|func|fn|class|if|elif|for|foreach|while|case|catch|except|switch)\b|=>|&&|\|\|/g) || []).length;
}

// files: the backlog. allFiles: every comment-action file, for the import graph.
// readText(path) returns a file's text. activity: Map of path to recent commit count.
// Returns the backlog ordered by importance, most important first: [{ path, score, ... }].
function rankFiles({ files, allFiles, readText, packageJson, activity = new Map() }) {
  const entries = new Set(packageEntries(packageJson));
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) texts.set(file, readText(file) || '');
    return texts.get(file);
  };
  const importers = importersOf(allFiles, textOf);
  return files.map((file) => {
    const entry = isEntryPoint(file, entries);
    const fanIn = importers.has(file) ? importers.get(file).size : 0;
    const branches = Math.min(complexity(textOf(file)), 200);
    const changes = activity.get(file) || 0;
    return { path: file, entry, fanIn, complexity: branches, activity: changes, score: (entry ? 1000 : 0) + fanIn * 20 + branches + changes * 10 };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

// Who imports each file: Map from a file to the Set of files that import it.
function importersOf(allFiles, textOf) {
  const known = new Set(allFiles);
  const importers = new Map();
  for (const file of allFiles) {
    for (const specifier of importSpecifiers(file, textOf(file))) {
      const target = resolveImport(file, specifier, known);
      if (!target || target === file) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return importers;
}

// How many of the files that import `file` use each of `names`: Map from a name to a count.
function nameUsage(file, names, importers, textOf) {
  const usage = new Map();
  const from = [...(importers.get(file) || [])];
  for (const name of new Set(names)) {
    const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
    const count = from.filter((other) => word.test(textOf(other))).length;
    if (count) usage.set(name, count);
  }
  return usage;
}

// One batch from the ranked backlog: the layer of the most important file first, then the
// next layers in order of their most important file, until the batch is full.
// layers: [{ name, files, slug, part }]. Returns { files, layers: [names] }. A sub-document whose
// name another layer has too, such as "Tests" in two parts, is named with its part's name.
function selectBatch(ranked, layers, size) {
  const count = (name) => layers.filter((l) => l.name === name).length;
  const title = (layer) => {
    const part = layer.part && layers.find((l) => (l.part ? `${l.part}/${l.slug}` : l.slug) === layer.part);
    return part && count(layer.name) > 1 ? `${part.name} ${layer.name}` : layer.name;
  };
  const layerOf = new Map();
  for (const layer of layers) for (const file of layer.files) layerOf.set(file, title(layer));
  const order = [];
  for (const item of ranked) {
    const name = layerOf.get(item.path) || null;
    if (!order.includes(name)) order.push(name);
  }
  const files = [];
  const used = [];
  for (const name of order) {
    if (files.length >= size) break;
    const inLayer = ranked.filter((item) => (layerOf.get(item.path) || null) === name).map((item) => item.path);
    files.push(...inLayer.slice(0, size - files.length));
    if (name) used.push(name);
  }
  return { files, layers: used };
}

module.exports = { complexity, importSpecifiers, importersOf, isEntryPoint, nameUsage, packageEntries, rankFiles, resolveImport, selectBatch };
