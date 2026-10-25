'use strict';

// Architecture layers grounded in the project's real folders. The groups come from the folder
// tree, not from the model: files are grouped by folder below the folders every file shares, a
// group with several subfolders is split into them while that keeps at most MAX_LAYERS groups,
// test folders are one group, and a small group joins the group whose folder shares the most of
// its path (app/scripts joins app/src), never a test group unless it is tests itself. A group
// of more than SPLIT_ABOVE files, tests aside, is split into parts by its import graph (see
// clusters.js), so a big flat folder such as src/ gets a layer for each of its parts. The model
// then only names the groups and may merge ones with one responsibility, though never two parts
// of one folder. A name it gives must be
// supported by the group's folders, files, or summaries; a generic name such as "User Interface"
// needs every one of its words there. Otherwise the group keeps a name from its folder. A
// description that repeats one file's purpose is dropped, and docs.js builds one from the
// folder summaries.

const path = require('path');

const { clusterFiles } = require('./clusters');

const MAX_LAYERS = 7;
// A group with fewer files joins another, so a small project gets a few meaningful layers.
const MIN_GROUP_FILES = 3;
// A project with this many groups or fewer keeps them all, however small.
const MERGE_ABOVE = 4;
const TEST_FOLDER = /^(test|tests|spec|specs|__tests__|e2e)$/i;
// A group with more files than this, tests aside, is split into at most MAX_PARTS parts of at
// least MIN_GROUP_FILES files each.
const SPLIT_ABOVE = 15;
const MAX_PARTS = 4;
// In the layer plan prompt, a purpose is never cut shorter than this.
const MIN_PURPOSE_CHARS = 20;

const LAYERS_SCHEMA = {
  type: 'object',
  properties: {
    layers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          groups: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'groups'],
      },
    },
  },
  required: ['layers'],
};

// Names that describe architectures in general rather than this code.
const GENERIC_NAMES = /^(user interface|ui|ui layer|frontend|front end|front-end|presentation( layer)?|views?|api|api layer|api routes|routes|routing|endpoints|backend|back end|back-end|server|data access( layer)?|data layer|database|persistence|storage|repositories|models|business logic|domain( layer)?|services?( layer)?|controllers|infrastructure|core( logic)?|utilities|utils|helpers|common|shared|middleware|application( layer)?)$/i;
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'layer', 'code', 'module', 'modules', 'logic', 'files', 'with', 'a', 'an', 'to']);
// Folder names that read better spelled out.
const FOLDER_WORDS = { src: 'Source', lib: 'Library', libs: 'Libraries', test: 'Tests', tests: 'Tests', spec: 'Specs', specs: 'Specs', scripts: 'Scripts', bin: 'Commands', cmd: 'Commands', app: 'App', apps: 'Apps', api: 'API', ui: 'UI', db: 'Database', docs: 'Docs', pkg: 'Packages', packages: 'Packages', utils: 'Utilities', util: 'Utilities' };

const dirOf = (file) => path.posix.dirname(file);
const segments = (dir) => (dir === '.' ? [] : dir.split('/'));

// The name a group gets from its folder, such as "App Tests" for app/tests.
function folderName(folder) {
  const parts = segments(folder);
  if (!parts.length) return 'Top Level';
  return parts.map((p) => FOLDER_WORDS[p.toLowerCase()] || p.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).join(' ');
}

// The word a part of a folder is known by when the model gives it no name: its most central
// file's name, the one most of the part's files import or share a word of their names with.
function partWord(files, importsOf) {
  const words = (f) => path.posix.basename(f).replace(/\.[^.]+$/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const inPart = new Set(files);
  const score = new Map(files.map((f) => [f, 0]));
  for (const file of files) {
    for (const target of importsOf(file)) if (inPart.has(target) && target !== file) score.set(target, score.get(target) + 1);
    for (const other of files) if (other !== file && words(file).some((w) => w.length > 2 && words(other).includes(w))) score.set(file, score.get(file) + 1);
  }
  const best = [...files].sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b))[0];
  return words(best).map((w) => FOLDER_WORDS[w] || w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Groups files by folder: [{ id, folder, folders, files, part }], at most MAX_LAYERS of them.
// importsOf(file) returns the project files a file imports, for merging when there are too many
// and for splitting a large group; purposeOf(file) returns its purpose, for splitting. part is
// set on each part of a split group: { of: its folder, word: the name word for its fallback name }.
function groupFiles(files, importsOf = () => [], purposeOf = () => '') {
  const dirs = files.map((f) => segments(dirOf(f)));
  // The folders every file shares, such as src/ in a project with all its code there.
  let depth = 0;
  while (dirs.length && dirs.every((d) => d.length > depth && d[depth] === dirs[0][depth])) depth++;
  const prefix = dirs.length ? dirs[0].slice(0, depth) : [];
  const at = (file, level) => {
    const d = segments(dirOf(file));
    return d.length > level ? d.slice(0, level + 1).join('/') : (d.slice(0, level).join('/') || '.');
  };
  let groups = new Map();
  for (const file of files) {
    const key = at(file, prefix.length);
    if (!groups.has(key)) groups.set(key, { folder: key, files: [], level: prefix.length });
    groups.get(key).files.push(file);
  }
  // Split a group into its subfolders, largest group first, while that keeps few enough.
  for (const group of [...groups.values()].sort((a, b) => b.files.length - a.files.length)) {
    if (!segments(group.folder).length || segments(group.folder).length !== group.level + 1) continue;
    const below = new Map();
    for (const file of group.files) {
      const key = at(file, group.level + 1);
      if (!below.has(key)) below.set(key, []);
      below.get(key).push(file);
    }
    const subfolders = [...below.keys()].filter((k) => k !== group.folder);
    if (subfolders.length < 2 || groups.size - 1 + below.size > MAX_LAYERS) continue;
    groups.delete(group.folder);
    for (const [key, groupFiles] of below) groups.set(key, { folder: key, files: groupFiles, level: group.level + 1 });
  }
  groups = [...groups.values()];
  const join = (into, small) => {
    into.files.push(...small.files);
    into.folders = [...(into.folders || [into.folder]), ...(small.folders || [small.folder])];
  };
  // Test folders, such as test/ and app/tests/, are one group.
  const tests = groups.filter((g) => segments(g.folder).some((s) => TEST_FOLDER.test(s)));
  for (const extra of tests.slice(1)) {
    join(tests[0], extra);
    groups = groups.filter((g) => g !== extra);
  }
  const isTests = (g) => (g.folders || [g.folder]).every((f) => segments(f).some((s) => TEST_FOLDER.test(s)));
  // The group a small one joins: the one whose folder shares the most of its path, then the one
  // it shares the most imports with, then the largest. A test group takes only tests. Null when
  // no group can take it.
  const partner = (small) => {
    const others = groups.filter((g) => g !== small && (isTests(small) || !isTests(g)));
    if (!others.length) return null;
    const owner = new Map();
    others.forEach((g, i) => g.files.forEach((f) => owner.set(f, i)));
    const mine = new Set(small.files);
    const links = new Map();
    for (const file of small.files) {
      for (const target of importsOf(file)) if (owner.has(target)) links.set(owner.get(target), (links.get(owner.get(target)) || 0) + 1);
    }
    others.forEach((g, i) => {
      for (const file of g.files) for (const target of importsOf(file)) if (mine.has(target)) links.set(i, (links.get(i) || 0) + 1);
    });
    const shared = (g) => {
      const a = segments(small.folder);
      let best = 0;
      for (const folder of g.folders || [g.folder]) {
        const b = segments(folder);
        let n = 0;
        while (n < a.length && n < b.length && a[n] === b[n]) n++;
        best = Math.max(best, n);
      }
      return best;
    };
    const order = others.map((g, i) => ({ g, shared: shared(g), links: links.get(i) || 0 }));
    order.sort((x, y) => y.shared - x.shared || y.links - x.links || y.g.files.length - x.g.files.length);
    return order[0].g;
  };
  // A group of one or two files joins another while more than MERGE_ABOVE remain, and while
  // there are too many groups, the smallest joins another.
  // A group no other can take stays as it is.
  const alone = new Set();
  for (;;) {
    groups.sort((a, b) => a.files.length - b.files.length || a.folder.localeCompare(b.folder));
    const small = groups.find((g) => !alone.has(g));
    if (!small || groups.length <= MERGE_ABOVE || (small.files.length >= MIN_GROUP_FILES && groups.length <= MAX_LAYERS)) break;
    const into = partner(small);
    if (!into) {
      alone.add(small);
      continue;
    }
    join(into, small);
    groups = groups.filter((g) => g !== small);
  }
  // A large group splits into parts by its imports, largest first, while that keeps at most
  // MAX_LAYERS groups. Tests stay one group.
  for (const group of [...groups].sort((a, b) => b.files.length - a.files.length || a.folder.localeCompare(b.folder))) {
    const room = MAX_LAYERS - groups.length + 1;
    if (group.files.length <= SPLIT_ABOVE || isTests(group) || room < 2) continue;
    const parts = clusterFiles(group.files, { importsOf, purposeOf, maxClusters: Math.min(MAX_PARTS, room), minSize: MIN_GROUP_FILES });
    if (parts.length < 2) continue;
    const holds = (folder, file) => folder === '.' || file.startsWith(`${folder}/`) || dirOf(file) === folder;
    groups = groups.filter((g) => g !== group);
    for (const partFiles of parts) {
      const folders = (group.folders || [group.folder]).filter((f) => partFiles.some((file) => holds(f, file)));
      groups.push({ folder: folders[0] || group.folder, folders, files: partFiles, part: { of: group.folder, word: partWord(partFiles, importsOf) } });
    }
  }
  return groups
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.files.slice().sort()[0].localeCompare(b.files.slice().sort()[0]))
    .map((g, i) => ({ id: `g${i + 1}`, folder: g.folder, folders: g.folders || [g.folder], files: g.files.sort(), ...(g.part ? { part: g.part } : {}) }));
}

// The text a group's name may draw on: its folders, file names, and summaries. A part of a
// folder draws on its own files only, since the folder's summary is about all its parts.
function groupText(group, fileInfo, folders) {
  const parts = [...group.folders, ...group.files.map((f) => path.posix.basename(f).replace(/\.\w+$/, ''))];
  if (!group.partial) for (const folder of new Set(group.files.map(dirOf))) if (folders.get(folder)) parts.push(folders.get(folder));
  for (const file of group.files) {
    const info = fileInfo.get(file);
    if (info && info.summary) parts.push(info.summary);
  }
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function contentWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

// Whether a layer's description only repeats one file's purpose, such as pkcs8.mjs's
// "Converts PKCS#1 to PKCS#8 for WebCrypto" for a whole layer: most of the words of both are
// the same.
function copiesPurpose(description, purposes) {
  const own = contentWords(description);
  if (!own.size) return false;
  return purposes.some((purpose) => {
    const theirs = contentWords(purpose);
    let both = 0;
    for (const w of own) if (theirs.has(w)) both++;
    return theirs.size > 0 && both / Math.max(own.size, theirs.size) >= 0.6;
  });
}

function significantWords(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// Whether the text supports a name: a word counts when the text has it, or its first five
// letters (so "Commenting" matches "comments").
function supports(text, name) {
  const words = significantWords(name);
  if (!words.length) return false;
  const has = (w) => new RegExp(`\\b${w.length > 5 ? w.slice(0, 5) : w}`).test(text);
  return GENERIC_NAMES.test(name.trim()) ? words.every(has) : words.some(has);
}

// The prompt, at most totalChars long: every group's line, then as many of its files' purposes
// as fit, shared evenly between the groups.
function layersPrompt(groups, fileInfo, folders, totalChars, styleRules = '') {
  const system = `You document the architecture of software projects, using only what the material shows.${styleRules ? `\n\n${styleRules}` : ''}`;
  const instructions = `These groups are the folders of a project. Name each group as an architecture layer.

For each layer, give:
- name: 2 to 4 words in title case, taken from what its folders and files do, such as "Comment Engine" or "Settings Page".
- description: one sentence that sums up the whole layer, from its folder summaries. Never one file's purpose.
- groups: the ids of its groups.

Put every group in exactly one layer. Put two groups in one layer only when the material shows they share one responsibility. A group marked "part" is one part of a large folder: name it from what its own files do, and never put two parts of one folder in one layer. Never use a generic name such as "User Interface", "API Routes", "Data Access", or "Business Logic" unless the group's files really are that.

Groups:
`;
  const heads = groups.map((group) => {
    const summaries = group.part ? [] : [...new Set(group.files.map(dirOf))].map((d) => folders.get(d)).filter(Boolean);
    const where = group.part ? `part of ${group.part.of}` : group.folders.join(', ');
    return `- ${group.id}: ${where} (${group.files.length} ${group.files.length === 1 ? 'file' : 'files'})${summaries.length ? `. ${summaries.join(' ').slice(0, 300)}` : ''}`;
  });
  const fixed = system.length + instructions.length + heads.reduce((n, h) => n + h.length + 1, 0);
  const purpose = (f) => String((fileInfo.get(f) || {}).summary || '').trim();
  const listed = (group, cut) => group.files.map((f) => {
    const text = purpose(f);
    const short = text.length <= cut ? text : `${text.slice(0, Math.max(0, text.lastIndexOf(' ', cut)) || cut)}...`;
    return `${path.posix.basename(f)}: ${short}`;
  }).join('; ');
  // The room for each group's files: a group whose files need less than an even share leaves
  // the rest to the others.
  const shares = new Map();
  let room = Math.max(0, totalChars - fixed);
  const byNeed = groups.map((group) => ({ group, need: listed(group, Infinity).length + 12 })).sort((a, b) => a.need - b.need);
  byNeed.forEach(({ group, need }, k) => {
    const even = Math.floor(room / (byNeed.length - k));
    shares.set(group, Math.min(need, even) - 12);
    room -= Math.min(need, even);
  });
  // Every file with its purpose when they fit; else each purpose cut evenly, down to
  // MIN_PURPOSE_CHARS; else the names of as many files as fit.
  const lines = groups.map((group, i) => {
    const share = Math.max(0, shares.get(group));
    let files = listed(group, Infinity);
    if (files.length > share) {
      const names = group.files.reduce((n, f) => n + path.posix.basename(f).length + 4, 0);
      const cut = Math.floor((share - names) / Math.max(1, group.files.length)) - 3;
      if (cut >= MIN_PURPOSE_CHARS) files = listed(group, cut);
      else {
        files = '';
        for (const f of group.files) {
          const item = `${files ? ', ' : ''}${path.posix.basename(f)}`;
          if (files.length + item.length > share) break;
          files += item;
        }
      }
    }
    return files ? `${heads[i]}\n  Files: ${files}` : heads[i];
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${instructions}${lines.join('\n')}`.slice(0, Math.max(0, totalChars - system.length)) },
  ];
}

// Plans layers: { layers: [{ name, description, files }] }, for normalizeLayers in docs.js.
// call(label, request) sends one request to the docs model.
async function planGroundedLayers({ files, fileInfo, folders = new Map(), readSource = () => null, call, contextTokens, promptChars = 4000, styleRules = '', errors = [] }) {
  // Loaded here, not at the top: it loads typescript, and the pre-check must run without it.
  const { importSpecifiers, resolveImport } = require('./importance');
  const known = new Set(files);
  const importsCache = new Map();
  const importsOf = (file) => {
    if (!importsCache.has(file)) {
      const text = readSource(file);
      let targets = [];
      try {
        targets = text ? importSpecifiers(file, text).map((s) => resolveImport(file, s, known)).filter(Boolean) : [];
      } catch {
        // Imports that cannot be read do not merge anything.
      }
      importsCache.set(file, targets);
    }
    return importsCache.get(file);
  };
  const groups = groupFiles(files, importsOf, (f) => (fileInfo.get(f) || {}).summary || '');
  // The name a group gets when the model gives it none: its folder's, and for a part of a
  // folder, with its most central file's name, such as "Source Ollama".
  const fallbackName = (group) => (group.part ? `${folderName(group.folder)} ${group.part.word}` : folderName(group.folder));
  let answer = null;
  try {
    const content = await call('layers', {
      messages: layersPrompt(groups, fileInfo, folders, promptChars, styleRules),
      format: LAYERS_SCHEMA,
      options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: 120 + 80 * groups.length },
    });
    answer = JSON.parse(content);
  } catch (err) {
    errors.push(`layers: ${err.message}`);
  }
  // Every file's purpose in the project: a layer's description may repeat none of them.
  const purposes = files.map((f) => (fileInfo.get(f) || {}).summary).filter(Boolean);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const assigned = new Set();
  const layers = [];
  for (const entry of answer && Array.isArray(answer.layers) ? answer.layers : []) {
    if (!entry || typeof entry !== 'object') continue;
    // Two parts of one folder stay apart: the first keeps the entry, and the others are named
    // on their own below.
    const splitFrom = new Set();
    const members = (Array.isArray(entry.groups) ? entry.groups : []).map(String).filter((id) => {
      if (!byId.has(id) || assigned.has(id)) return false;
      const part = byId.get(id).part;
      if (!part) return true;
      if (splitFrom.has(part.of)) return false;
      splitFrom.add(part.of);
      return true;
    });
    if (!members.length) continue;
    members.forEach((id) => assigned.add(id));
    const merged = { folders: members.flatMap((id) => byId.get(id).folders), files: members.flatMap((id) => byId.get(id).files), partial: splitFrom.size > 0 };
    let name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 60) : '';
    if (name && layers.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      errors.push(`layers: the name "${name}" is given to two layers, so the second is named after its folder`);
      name = '';
    }
    const grounded = name && supports(groupText(merged, fileInfo, folders), name);
    if (name && !grounded) errors.push(`layers: the name "${name}" is not supported by its folders, so it is named after them`);
    let description = grounded && typeof entry.description === 'string' ? entry.description.trim() : '';
    if (description && merged.files.length > 1 && copiesPurpose(description, purposes)) {
      errors.push(`layers: the description of "${name}" repeats one file's purpose, so it comes from its folders`);
      description = '';
    }
    layers.push({ name: grounded ? name : fallbackName(byId.get(members[0])), description, files: merged.files });
  }
  for (const group of groups) {
    if (!assigned.has(group.id)) layers.push({ name: fallbackName(group), description: '', files: group.files });
  }
  return { layers };
}

module.exports = { GENERIC_NAMES, LAYERS_SCHEMA, MAX_LAYERS, SPLIT_ABOVE, copiesPurpose, folderName, groupFiles, layersPrompt, planGroundedLayers, supports };
