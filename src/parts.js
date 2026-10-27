'use strict';

// The top-level parts of a large project, and the documents each part gets. A project with two
// or more workspace packages, or LARGE_PROJECT_FILES source files or more, is documented as a
// hierarchy: each workspace package (a folder with its own package.json, pyproject.toml, go.mod,
// Cargo.toml, or similar, or one the root package.json's workspaces or pnpm-workspace.yaml
// names) is a part, and so is each other top-level folder. Files of two parts never share a
// document. A part's tests are a document of their own. A document with more than SUB_ABOVE
// code files, at any level, gets sub-documents, one for each of its real subfolders, with tiny
// subfolders kept in its own document, down to MAX_DEPTH levels; layers.js divides a document
// that is still too big, within its folder only. A part that groups several (see foldParts) has
// each of them as a sub-document. A smaller project keeps the flat layers of layers.js.
// Node built-ins only: the pre-check loads this through docs.js.

const path = require('path');

const { SKIP_DIRS } = require('./languages');

const LARGE_PROJECT_FILES = 100;
// A part with more code files than this gets sub-documents.
const SUB_ABOVE = 40;
// A subfolder with fewer code files stays in its part's own document.
const MIN_SUB_FILES = 5;
// At most this many subfolders of one part get documents; the smallest stay with the part.
const MAX_SUBS = 10;
// The README lists at most this many parts.
const MAX_TOP_PARTS = 12;
// A document is at most this deep: a part, a package or subfolder in it, and a subfolder in that.
const MAX_DEPTH = 3;

const MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'pubspec.yaml', 'mix.exs', 'Package.swift', 'deno.json',
]);
const TEST_FOLDER = /^(test|tests|spec|specs|__tests__|e2e)$/i;
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$|^test_[^/]+\.py$|_test\.(py|go)$/i;
// Folder names that read better spelled out.
const FOLDER_WORDS = { src: 'Source', lib: 'Library', libs: 'Libraries', test: 'Tests', tests: 'Tests', spec: 'Specs', specs: 'Specs', scripts: 'Scripts', bin: 'Commands', cmd: 'Commands', app: 'App', apps: 'Apps', api: 'API', ui: 'UI', db: 'Database', docs: 'Docs', pkg: 'Packages', packages: 'Packages', utils: 'Utilities', util: 'Utilities' };

const dirOf = (file) => path.posix.dirname(file);
const segments = (dir) => (dir === '.' ? [] : dir.split('/'));
const within = (file, dir) => dir === '.' || file.startsWith(`${dir}/`);

const titleWord = (w) => FOLDER_WORDS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1);

// The name a folder gives, such as "App Tests" for app/tests.
function folderName(folder) {
  const parts = segments(folder);
  if (!parts.length) return 'Top Level';
  return parts.map((p) => FOLDER_WORDS[p.toLowerCase()] || p.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).join(' ');
}

// The name a package gives, from its manifest's name: "@excalidraw/element" is "Excalidraw
// Element", "@excalidraw/excalidraw" is "Excalidraw", and "excalidraw-app" is "Excalidraw App".
function packageTitle(name) {
  const words = [];
  for (const w of String(name).replace(/^@/, '').split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    if (!words.some((x) => x.toLowerCase() === w.toLowerCase())) words.push(w);
  }
  return words.slice(0, 5).map(titleWord).join(' ');
}

const isTestFile = (file) => segments(dirOf(file)).some((s) => TEST_FOLDER.test(s)) || TEST_FILE.test(path.posix.basename(file));

function readJson(readFile, file) {
  try {
    const value = JSON.parse(readFile(file) || '');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// The workspace patterns of the root package.json and pnpm-workspace.yaml, such as "packages/*".
function workspacePatterns(readFile) {
  const patterns = [];
  const pkg = readJson(readFile, 'package.json');
  const ws = pkg && (Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces && pkg.workspaces.packages);
  if (Array.isArray(ws)) patterns.push(...ws.filter((p) => typeof p === 'string'));
  let pnpm = null;
  try {
    pnpm = readFile('pnpm-workspace.yaml');
  } catch {
    // None.
  }
  if (typeof pnpm === 'string') {
    let inPackages = false;
    for (const line of pnpm.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const item = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
        if (item) patterns.push(item[1]);
      }
    }
  }
  return patterns.map((p) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
}

// A pattern's folders: "*" stands for one folder name. A pattern with "**" names no folders by
// itself; its packages have manifests.
function patternRegex(pattern) {
  if (pattern.includes('**')) return null;
  return new RegExp(`^${pattern.split('/').map((s) => s.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')).join('/')}$`);
}

// The name in a package's manifest, or ''.
function manifestName(dir, allFiles, readFile) {
  const at = (name) => (allFiles.has(`${dir}/${name}`) ? `${dir}/${name}` : null);
  const plain = (name) => (typeof name === 'string' && /^[@A-Za-z0-9][\w@./ -]{0,79}$/.test(name.trim()) ? name.trim() : '');
  const read = (file) => {
    try {
      return file ? readFile(file) || '' : '';
    } catch {
      return '';
    }
  };
  if (at('package.json')) {
    const pkg = readJson(readFile, at('package.json'));
    if (pkg && plain(pkg.name)) return plain(pkg.name);
  }
  for (const file of [at('pyproject.toml'), at('Cargo.toml')]) {
    const text = read(file);
    const section = text.match(/^\[(?:project|tool\.poetry|package)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const name = section && section[1].match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (name && plain(name[1])) return plain(name[1]);
  }
  const mod = read(at('go.mod')).match(/^module\s+(\S+)/m);
  if (mod && plain(mod[1].split('/').pop())) return plain(mod[1].split('/').pop());
  return '';
}

// The project's workspace packages: [{ folder, name }], deepest first. allFiles: every tracked
// path. A manifest at the root is the workspace's, not a package; one under a test folder, a
// fixtures folder, or a skipped folder such as node_modules is not a package.
function findPackages(allFiles, readFile = () => null) {
  const all = new Set(allFiles);
  const ignored = (dir) => segments(dir).some((s) => SKIP_DIRS.has(s) || s.startsWith('.') || TEST_FOLDER.test(s) || /^(fixtures?|__fixtures__)$/i.test(s));
  const dirs = new Set();
  for (const file of all) {
    const dir = dirOf(file);
    if (dir !== '.' && MANIFESTS.has(path.posix.basename(file)) && !ignored(dir)) dirs.add(dir);
  }
  const folders = new Set();
  for (const file of all) for (let d = dirOf(file); d !== '.'; d = dirOf(d)) folders.add(d);
  for (const pattern of workspacePatterns(readFile)) {
    const negated = pattern.startsWith('!');
    const re = patternRegex(negated ? pattern.slice(1) : pattern);
    if (!re) continue;
    for (const dir of folders) {
      if (!re.test(dir) || ignored(dir)) continue;
      if (negated) dirs.delete(dir);
      else dirs.add(dir);
    }
  }
  return [...dirs]
    .sort((a, b) => segments(b).length - segments(a).length || a.localeCompare(b))
    .map((folder) => ({ folder, name: manifestName(folder, all, readFile) }));
}

// Whether a project is documented as a hierarchy of parts: two or more packages hold its files,
// or it has LARGE_PROJECT_FILES source files or more.
function isLargeProject(files, packages) {
  const holding = packages.filter((p) => files.some((f) => within(f, p.folder)));
  return holding.length >= 2 || files.length >= LARGE_PROJECT_FILES;
}

// The top-level parts: [{ folder, name, package, files }], each file in the deepest package that
// holds it, else in its top-level folder; files at the root are a part of their own.
function topParts(files, packages) {
  const parts = new Map();
  for (const file of [...files].sort()) {
    const pkg = packages.find((p) => within(file, p.folder));
    const folder = pkg ? pkg.folder : (segments(dirOf(file))[0] || '.');
    if (!parts.has(folder)) parts.set(folder, { folder, name: pkg && pkg.name ? packageTitle(pkg.name) : folderName(pkg ? segments(folder).pop() : folder), package: Boolean(pkg), files: [] });
    parts.get(folder).files.push(file);
  }
  const list = [...parts.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  // Names are unique: a second part with a name is named after its folder.
  const used = new Set();
  for (const part of list) {
    if (!part.name || used.has(part.name.toLowerCase())) part.name = folderName(part.folder);
    for (let n = 2; used.has(part.name.toLowerCase()); n++) part.name = `${folderName(part.folder)} ${n}`;
    used.add(part.name.toLowerCase());
  }
  return foldParts(list);
}

// More than MAX_TOP_PARTS parts: the top-level folder holding the most parts becomes one part
// with each of them as a document, and when no folder holds two, the smallest parts become
// documents of one part, "Other Parts".
function foldParts(parts) {
  let list = parts;
  while (list.length > MAX_TOP_PARTS) {
    const byTop = new Map();
    for (const part of list) {
      const top = segments(part.folder)[0];
      if (top && top !== part.folder) byTop.set(top, [...(byTop.get(top) || []), part]);
    }
    const [top, members] = [...byTop].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] || [];
    let folded;
    if (members && members.length >= 2) {
      const merging = list.filter((p) => p.folder === top || members.includes(p));
      folded = { folder: top, name: folderName(top), package: false, files: merging.flatMap((p) => p.files), folded: merging };
    } else {
      const smallest = [...list].sort((a, b) => a.files.length - b.files.length || a.folder.localeCompare(b.folder)).slice(0, list.length - MAX_TOP_PARTS + 1);
      folded = { folder: '.', name: 'Other Parts', package: false, files: smallest.flatMap((p) => p.files), folded: smallest };
    }
    list = [...list.filter((p) => !folded.folded.includes(p)), folded].sort((a, b) => a.folder.localeCompare(b.folder));
  }
  return list;
}

// The deepest folder every file is in, at or below `floor`.
function commonFolder(files, floor) {
  const dirs = files.map((f) => segments(dirOf(f)));
  let depth = segments(floor).length;
  while (dirs.length && dirs.every((d) => d.length > depth && d[depth] === dirs[0][depth])) depth++;
  return dirs.length ? dirs[0].slice(0, depth).join('/') || '.' : floor;
}

// The documents under one document: { own: the files in that document, subs: [sub] }, where a
// sub is { name, folder, files, tests, divide, rest, subs }, its own files and its own
// sub-documents. depth is the level of the document (a part is 1), and no document is deeper
// than MAX_DEPTH. A document with more than SUB_ABOVE code files gets a sub-document for each
// subfolder of the folder its code shares, named after it; a subfolder of fewer than
// MIN_SUB_FILES files, and any beyond the MAX_SUBS largest, stays in the document's own files.
// divide marks a sub-document still too big for one, for layers.js to divide within its folder:
// one at MAX_DEPTH, one whose files have no subfolders to split by, or the own files of a
// document left with too many (rest). named says the document is a part or a package, which
// keeps its own document even when all its files are in one folder.
function documentsOf(name, folder, files, depth, named) {
  const tests = files.filter(isTestFile);
  const code = files.filter((f) => !isTestFile(f));
  if (!code.length) return { own: tests, subs: [] };
  const testSubs = tests.length ? [leaf('Tests', commonFolder(tests, '.'), tests, { tests: true })] : [];
  const split = code.length > SUB_ABOVE ? folderSubs(name, folder, code, depth, named) : null;
  if (!split) return { own: code, subs: testSubs };
  return { own: split.own, subs: [...split.subs, ...testSubs] };
}

function leaf(name, folder, files, { tests = false, divide = false, rest = false } = {}) {
  return { name, folder, files: [...files].sort(), tests, divide, ...(rest ? { rest } : {}), subs: [] };
}

// The sub-documents of a document with too many code files, one for each subfolder: { own,
// subs }, or null when a document that is not named has no subfolders to split by.
function folderSubs(name, folder, code, depth, named) {
  const base = commonFolder(code, folder);
  const groups = new Map([[base, []]]);
  for (const file of code) {
    const rel = segments(dirOf(file)).slice(segments(base).length);
    const key = rel.length ? [...segments(base), rel[0]].join('/') : base;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  // Tiny subfolders stay with the document, and so do the smallest while there are too many.
  const subfolders = [...groups.keys()].filter((k) => k !== base)
    .sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b));
  subfolders.forEach((key, i) => {
    if (groups.get(key).length < MIN_SUB_FILES || i >= MAX_SUBS) {
      groups.get(base).push(...groups.get(key));
      groups.delete(key);
    }
  });
  if (groups.size === 1 && !named) return null;
  const relName = (dir) => folderName(segments(dir).slice(segments(folder).length).join('/') || '.');
  const subs = [...groups].filter(([key]) => key !== base).sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => subfolderDoc(relName(dir), dir, files, depth + 1));
  const rest = groups.get(base).sort();
  if (rest.length <= SUB_ABOVE) return { own: rest, subs };
  // The document's own files are too many for it: they are divided into documents too.
  subs.unshift(leaf(base === folder ? name : relName(base), base, rest, { divide: true, rest: true }));
  return { own: [], subs };
}

// A subfolder's document at depth, with sub-documents of its own when it is too big for one
// and not yet at MAX_DEPTH.
function subfolderDoc(name, folder, files, depth) {
  const split = files.length > SUB_ABOVE && depth < MAX_DEPTH ? folderSubs(name, folder, files, depth, false) : null;
  if (!split) return leaf(name, folder, files, { divide: files.length > SUB_ABOVE });
  return { name, folder, files: split.own, tests: false, divide: false, subs: split.subs };
}

// The documents of one part: { own: files in the part's own document, subs: [sub] } (see
// documentsOf). A part that groups several (see foldParts) has a document for each of them,
// with its own sub-documents.
function partDocuments(part) {
  if (!part.folded) return documentsOf(part.name, part.folder, part.files, 1, true);
  const subs = part.folded.map((member) => {
    const docs = documentsOf(member.name, member.folder, member.files, 2, true);
    return { name: member.name, folder: member.folder, files: docs.own, tests: docs.own.length > 0 && docs.own.every(isTestFile), divide: false, package: member.package, subs: docs.subs };
  });
  return { own: [], subs };
}

module.exports = {
  FOLDER_WORDS, LARGE_PROJECT_FILES, MAX_DEPTH, MAX_SUBS, MAX_TOP_PARTS, MIN_SUB_FILES, SUB_ABOVE,
  findPackages, folderName, isLargeProject, isTestFile, packageTitle, partDocuments, topParts, workspacePatterns,
};
