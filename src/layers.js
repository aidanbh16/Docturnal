'use strict';

// Architecture layers grounded in the project's real folders. The groups come from the folder
// tree, not from the model: files are grouped by folder below the folders every file shares, a
// group with several subfolders is split into them while that keeps at most MAX_LAYERS groups,
// and when there are more, the smallest group joins the one it shares the most imports with.
// The model then only names the groups and may merge ones with one responsibility. A name it
// gives must be supported by the group's folders, files, or summaries; a generic name such as
// "User Interface" needs every one of its words there. Otherwise the group keeps a name from its
// folder.

const path = require('path');


const MAX_LAYERS = 7;
// A group with fewer files joins another, so a small project gets a few meaningful layers.
const MIN_GROUP_FILES = 3;
// A project with this many groups or fewer keeps them all, however small.
const MERGE_ABOVE = 4;
const TEST_FOLDER = /^(test|tests|spec|specs|__tests__|e2e)$/i;

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

// Groups files by folder: [{ id, folder, files }], at most MAX_LAYERS of them. importsOf(file)
// returns the project files a file imports, for merging when there are too many.
function groupFiles(files, importsOf = () => []) {
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
  // The group a small one joins: the one it shares the most imports with, or the one whose
  // folder shares the most of its path, or the largest.
  const partner = (small) => {
    const others = groups.filter((g) => g !== small);
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
    const linked = [...links].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (linked) return others[linked[0]];
    const shared = (g) => {
      const a = segments(small.folder);
      const b = segments(g.folder);
      let n = 0;
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      return n;
    };
    return [...others].sort((x, y) => shared(y) - shared(x) || y.files.length - x.files.length)[0];
  };
  // A group of one or two files joins another while more than MERGE_ABOVE remain, and while
  // there are too many groups, the smallest joins another.
  for (;;) {
    groups.sort((a, b) => a.files.length - b.files.length || a.folder.localeCompare(b.folder));
    const small = groups[0];
    if (!small || groups.length <= MERGE_ABOVE || (small.files.length >= MIN_GROUP_FILES && groups.length <= MAX_LAYERS)) break;
    join(partner(small), small);
    groups.shift();
  }
  return groups
    .sort((a, b) => a.folder.localeCompare(b.folder))
    .map((g, i) => ({ id: `g${i + 1}`, folder: g.folder, folders: g.folders || [g.folder], files: g.files.sort() }));
}

// The text a group's name may draw on: its folders, file names, and summaries.
function groupText(group, fileInfo, folders) {
  const parts = [...group.folders, ...group.files.map((f) => path.posix.basename(f).replace(/\.\w+$/, ''))];
  for (const folder of new Set(group.files.map(dirOf))) if (folders.get(folder)) parts.push(folders.get(folder));
  for (const file of group.files) {
    const info = fileInfo.get(file);
    if (info && info.summary) parts.push(info.summary);
  }
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
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
- description: one sentence on what the layer does.
- groups: the ids of its groups.

Put every group in exactly one layer. Put two groups in one layer only when the material shows they share one responsibility. Never use a generic name such as "User Interface", "API Routes", "Data Access", or "Business Logic" unless the group's files really are that.

Groups:
`;
  const heads = groups.map((group) => {
    const summaries = [...new Set(group.files.map(dirOf))].map((d) => folders.get(d)).filter(Boolean);
    return `- ${group.id}: ${group.folders.join(', ')} (${group.files.length} ${group.files.length === 1 ? 'file' : 'files'})${summaries.length ? `. ${summaries.join(' ').slice(0, 300)}` : ''}`;
  });
  const fixed = system.length + instructions.length + heads.reduce((n, h) => n + h.length + 1, 0);
  const share = Math.max(0, Math.floor((totalChars - fixed) / Math.max(1, groups.length)) - 12);
  const lines = groups.map((group, i) => {
    let files = '';
    for (const f of group.files) {
      const item = `${files ? '; ' : ''}${path.posix.basename(f)}: ${String((fileInfo.get(f) || {}).summary || '').trim()}`;
      if (files.length + item.length > share) break;
      files += item;
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
  const groups = groupFiles(files, importsOf);
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
  const byId = new Map(groups.map((g) => [g.id, g]));
  const assigned = new Set();
  const layers = [];
  for (const entry of answer && Array.isArray(answer.layers) ? answer.layers : []) {
    if (!entry || typeof entry !== 'object') continue;
    const members = (Array.isArray(entry.groups) ? entry.groups : []).map(String).filter((id) => byId.has(id) && !assigned.has(id));
    if (!members.length) continue;
    members.forEach((id) => assigned.add(id));
    const merged = { folders: members.flatMap((id) => byId.get(id).folders), files: members.flatMap((id) => byId.get(id).files) };
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 60) : '';
    const grounded = name && supports(groupText(merged, fileInfo, folders), name);
    if (name && !grounded) errors.push(`layers: the name "${name}" is not supported by its folders, so it is named after them`);
    layers.push({
      name: grounded ? name : folderName(byId.get(members[0]).folder),
      description: grounded && typeof entry.description === 'string' ? entry.description : '',
      files: merged.files,
    });
  }
  for (const group of groups) {
    if (!assigned.has(group.id)) layers.push({ name: folderName(group.folder), description: '', files: group.files });
  }
  return { layers };
}

module.exports = { GENERIC_NAMES, LAYERS_SCHEMA, MAX_LAYERS, folderName, groupFiles, layersPrompt, planGroundedLayers, supports };
