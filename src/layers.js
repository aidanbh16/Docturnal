'use strict';

// Architecture layers grounded in the project's real folders. The groups come from the folder
// tree, not from the model: files are grouped by folder below the folders every file shares, a
// group with several subfolders is split into them while that keeps at most MAX_LAYERS groups,
// test folders are one group, and a small group joins the group whose folder shares the most of
// its path (app/scripts joins app/src), never a test group unless it is tests itself. A group
// of more than SPLIT_ABOVE files, tests aside, is split into parts, so a big flat folder such as
// src/ gets a layer for each of its parts: the docs model divides it and names the parts (see
// split.js), and when its answers break the rules, the parts come from the import graph (see
// clusters.js). The model then only names the other groups and may merge ones with one
// responsibility, though never two parts of one folder. A name it gives must be
// supported by the group's folders, files, or summaries; a generic name such as "User Interface"
// needs every one of its words there. Otherwise the group keeps a name from its folder. A
// description that repeats one file's purpose is dropped, and docs.js builds one from the
// folder summaries; a part's comes from the purposes of its most imported files.
// A large project is documented as a hierarchy of parts instead (see parts.js and
// planPartLayers below).

const path = require('path');

const { clusterFiles } = require('./clusters');
const { grounded, terms } = require('./grounding');
const { FOLDER_WORDS, SUB_ABOVE, findPackages, folderName, isLargeProject, partDocuments, topParts } = require('./parts');
const { splitWithModel, where } = require('./split');

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
// The time a part document is expected to take: the docs model divides a large folder only
// while the part documents still have this much time each.
const PART_DOC_MINUTES = 3;

const dirOf = (file) => path.posix.dirname(file);
const segments = (dir) => (dir === '.' ? [] : dir.split('/'));

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

const isTests = (g) => (g.folders || [g.folder]).every((f) => segments(f).some((s) => TEST_FOLDER.test(s)));

// Groups files by folder, at most MAX_LAYERS groups, before any large group is split.
// importsOf(file) returns the project files a file imports, for merging when there are too many.
function folderGroups(files, importsOf = () => []) {
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
  return groups.map((g) => ({ folder: g.folder, folders: g.folders || [g.folder], files: g.files }));
}

// The folders of a group that hold some of these files.
function partFolders(group, files) {
  const holds = (folder, file) => folder === '.' || file.startsWith(`${folder}/`) || dirOf(file) === folder;
  const found = group.folders.filter((f) => files.some((file) => holds(f, file)));
  return found.length ? found : [group.folder];
}

// Splits each large group into parts, largest first, while that keeps at most MAX_LAYERS
// groups; tests stay one group. It yields { group, maxParts } for each group to split and takes
// back its parts, [{ files, name, description }] (name and description only when the model
// gave them), or fewer than two to keep the group whole. It returns the groups. part is set on
// each part: { of: its folder, word: the name word for its fallback name }.
function* splitSteps(groups, importsOf) {
  let current = [...groups];
  for (const group of [...groups].sort((a, b) => b.files.length - a.files.length || a.folder.localeCompare(b.folder))) {
    const room = MAX_LAYERS - current.length + 1;
    if (group.files.length <= SPLIT_ABOVE || isTests(group) || room < 2) continue;
    const parts = yield { group, maxParts: Math.min(MAX_PARTS, room) };
    if (!parts || parts.length < 2) continue;
    current = current.filter((g) => g !== group);
    for (const { files, name, description } of parts) {
      const folders = partFolders(group, files);
      current.push({
        folder: folders[0], folders, files, part: { of: group.folder, word: partWord(files, importsOf) },
        ...(name ? { named: { name, description } } : {}),
      });
    }
  }
  return current;
}

// The groups in a stable order, each with its id.
function finishGroups(groups) {
  return groups
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.files.slice().sort()[0].localeCompare(b.files.slice().sort()[0]))
    .map((g, i) => ({ id: `g${i + 1}`, folder: g.folder, folders: g.folders, files: g.files.sort(), ...(g.part ? { part: g.part } : {}), ...(g.named ? { named: g.named } : {}) }));
}

// The parts clusterFiles finds for a group: [{ files }].
function clusterParts(group, maxParts, importsOf, purposeOf) {
  return clusterFiles(group.files, { importsOf, purposeOf, maxClusters: maxParts, minSize: MIN_GROUP_FILES }).map((files) => ({ files }));
}

// Groups files by folder: [{ id, folder, folders, files, part }], at most MAX_LAYERS of them,
// with each large group split by clustering its imports (see planGroundedLayers for the split
// the docs model makes). purposeOf(file) returns its purpose, for the clustering.
function groupFiles(files, importsOf = () => [], purposeOf = () => '') {
  const steps = splitSteps(folderGroups(files, importsOf), importsOf);
  let step = steps.next();
  while (!step.done) step = steps.next(clusterParts(step.value.group, step.value.maxParts, importsOf, purposeOf));
  return finishGroups(step.value);
}

// A sentence from the purposes of the files most of the project imports, for a part of a folder
// the plan gives no description: "Calls the local Ollama server, records the run's state, and
// runs git commands." importers(file) is how many files import it.
function purposeSentence(files, purposeOf, importers = () => 0) {
  const purpose = (f) => String(purposeOf(f) || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const clauses = [];
  for (const file of files.filter((f) => purpose(f)).sort((a, b) => importers(b) - importers(a) || a.localeCompare(b))) {
    // A verb or an article starts a clause in lowercase; a name such as "Ollama" keeps its case.
    const clause = purpose(file).replace(/^(?:A|An|The|[A-Z][a-z]{2,}s)\b/, (w) => w.toLowerCase());
    if (!clauses.includes(clause)) clauses.push(clause);
    if (clauses.length === 3) break;
  }
  if (!clauses.length) return '';
  const body = clauses.length < 3 ? clauses.join(' and ') : `${clauses.slice(0, -1).join(', ')}, and ${clauses[2]}`;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
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

// A part's description, from its folder summaries: the first of its shallowest folders that has
// one, so it is about the whole part, then the folder with the most of its files.
function partDescription(files, folders) {
  const counts = new Map();
  for (const file of files) counts.set(dirOf(file), (counts.get(dirOf(file)) || 0) + 1);
  const dirs = [...counts].sort((a, b) => segments(a[0]).length - segments(b[0]).length || b[1] - a[1] || a[0].localeCompare(b[0]));
  return dirs.map(([dir]) => folders.get(dir)).find(Boolean) || '';
}

const GROUP_SCHEMA = { type: 'object', properties: { sentence: { type: 'string' } }, required: ['sentence'] };
const GROUP_SENTENCE_WORDS = 30;

// The description of a part that groups several (see foldParts in parts.js): what it holds, by
// their names, such as "Holds the project's 3 packages: Common, Element, and Math.", and at
// most one sentence from the docs model that sums up their descriptions (see
// groupSentenceProblem). members: [{ name, description, package }].
async function groupDescription(part, members, { call, folders = new Map(), contextTokens, promptChars = 4000, styleRules = '', errors = [], useModel = true }) {
  const kind = members.every((m) => m.package) ? 'packages' : 'parts';
  const names = members.map((m) => m.name);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names[names.length - 1]}` : names[0];
  const holds = `Holds the project's ${members.length} ${kind}: ${listed}.`;
  const described = members.filter((m) => m.description);
  if (!useModel || !call || !described.length) return holds;
  const system = `You write one sentence that sums up what a group of ${kind} does together, from their descriptions only. Use no Markdown and no links. ${styleRules}`.trim();
  const user = `Write one sentence of at most ${GROUP_SENTENCE_WORDS} words that sums up what these ${kind} do together. Do not repeat one description; say what they share.\n\n${described.map((m) => `- ${m.name}: ${m.description}`).join('\n')}`.slice(0, Math.max(0, promptChars - system.length - 1));
  let sentence = '';
  try {
    const content = await call(`describe ${part.folder}`, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      format: GROUP_SCHEMA,
      options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: 80 },
    });
    const answer = JSON.parse(content);
    sentence = answer && typeof answer.sentence === 'string' ? answer.sentence.trim().replace(/\s+/g, ' ') : '';
  } catch (err) {
    errors.push(`layers: the request to describe ${part.folder}/ failed (${String(err.message).slice(0, 200)})`);
    return holds;
  }
  const problem = groupSentenceProblem(sentence, described, folders);
  if (problem) {
    errors.push(`layers: the sentence describing ${part.folder}/ was dropped: ${problem}`);
    return holds;
  }
  return `${holds} ${sentence}`;
}

// Why a sentence does not sum up the members' descriptions, or '': it must be one plain
// sentence, say nothing their names and descriptions do not, be about two or more of them (or
// the one), and repeat no single description or folder summary.
function groupSentenceProblem(sentence, members, folders = new Map()) {
  if (!sentence) return 'it is empty';
  if (!/^[A-Z][^.!?]*\.$/.test(sentence) || /[`*#|<>[\]_]|https?:/.test(sentence)) return 'it is not one plain sentence';
  if (sentence.split(/\s+/).length > GROUP_SENTENCE_WORDS) return 'it is too long';
  const material = new Set(terms(members.map((m) => `${m.name} ${m.description}`).join('\n')));
  if (!grounded(sentence, material)) return 'it says what the descriptions do not';
  const own = new Set(terms(sentence));
  const about = members.filter((m) => terms(m.description).some((t) => own.has(t))).length;
  if (about < Math.min(2, members.length)) return 'it is about only one of them';
  if (copiesPurpose(sentence, [...members.map((m) => m.description), ...folders.values()])) return 'it repeats one description';
  return '';
}

// A document's files and its sub-documents' files (see partDocuments in parts.js).
const docFiles = (doc) => [...doc.files, ...doc.subs.flatMap(docFiles)];

// Plans a large project's documents (see parts.js): a document for each top-level part, named
// after its package or folder, and its sub-documents, named after their packages and
// subfolders, at most MAX_DEPTH deep. The model names no document: it only divides one still
// too big, within its own folder, and sums up a part that groups several, while the part
// documents keep PART_DOC_MINUTES each before the deadline; after that, a document is divided
// by clustering. Returns { layers }, each document before its sub-documents, which have part
// set to the names of the documents above them, joined by "/".
async function planPartLayers({ files, packages, folders, purposeOf, importsOf, importedBy, divide, describeGroup, taken, splits, deadline, now }) {
  const parts = topParts(files, packages);
  for (const part of parts) taken.add(part.name.toLowerCase());
  const modelUntil = deadline - parts.length * PART_DOC_MINUTES * 60000;
  const layers = [];
  let subCount = 0;
  // Adds the layers of docs, the sub-documents of the document whose names, down from its part,
  // are `above`.
  const addDocs = async (docs, above, aboveName) => {
    const entries = [];
    for (const doc of docs) {
      const description = doc.package ? partDescription(docFiles(doc), folders) : '';
      if (!doc.divide) {
        entries.push({ name: doc.name, description, files: doc.files, doc });
        continue;
      }
      const group = { folder: doc.folder, folders: [doc.folder], files: doc.files };
      const maxParts = Math.min(MAX_PARTS, Math.max(2, Math.ceil(doc.files.length / SUB_ABOVE)));
      const pieces = await divide(group, maxParts, { useModel: now() < modelUntil, reason: 'the time left went to the part documents', noun: 'documents' });
      if (pieces.length < 2) {
        entries.push({ name: doc.name, description, files: doc.files });
        continue;
      }
      for (const piece of pieces) {
        // A piece the model did not name is named after its folder and its most central file,
        // and a piece of a document's own files after that document.
        const name = piece.name || `${doc.rest ? aboveName : doc.name} ${partWord(piece.files, importsOf)}`;
        entries.push({ name, description: piece.description || purposeSentence(piece.files, purposeOf, importedBy), files: piece.files });
      }
    }
    // Names are unique within a document, never its own, and never hold "/".
    const used = new Set();
    for (const entry of entries) {
      entry.name = entry.name.replace(/\//g, ' ').trim();
      const base = entry.name;
      for (let n = 2; used.has(entry.name.toLowerCase()) || entry.name.toLowerCase() === aboveName.toLowerCase(); n++) entry.name = `${base} ${n}`;
      used.add(entry.name.toLowerCase());
    }
    for (const { doc, ...entry } of entries) {
      layers.push({ ...entry, part: above });
      subCount++;
      if (doc && doc.subs.length) await addDocs(doc.subs, `${above}/${entry.name}`, entry.name);
    }
  };
  let packageCount = 0;
  for (const part of parts) {
    const { own, subs } = partDocuments(part);
    const at = layers.length;
    await addDocs(subs, part.name, part.name);
    let description = partDescription(part.files, folders);
    if (part.folded) {
      // A part of several is described by them, never by one of its folders' summaries.
      const members = layers.slice(at).filter((l) => l.part === part.name);
      const isPackage = new Map(part.folded.map((m) => [m.name.toLowerCase(), m.package]));
      description = await describeGroup(part, members.map((m) => ({ name: m.name, description: m.description, package: Boolean(isPackage.get(m.name.toLowerCase())) })), { useModel: now() < modelUntil });
    }
    layers.splice(at, 0, { name: part.name, description, files: own });
    packageCount += part.folded ? part.folded.filter((m) => m.package).length : Number(part.package);
  }
  splits.unshift(`the project is documented as ${parts.length} parts (${packageCount} ${packageCount === 1 ? 'package' : 'packages'}) with ${subCount} ${subCount === 1 ? 'sub-document' : 'sub-documents'}`);
  return { layers };
}

// Plans layers: { layers: [{ name, description, files }] }, for normalizeLayers in docs.js.
// call(label, request) sends one request to the docs model. A large group is split by the docs
// model (see split.js), or by clustering its imports when the model's answers break the rules;
// splits gets one line for each, saying which.
// A large project (see parts.js) is planned by planPartLayers, and each layer then has part, the
// names of the documents above it, when it is a sub-document. allFiles: every tracked path, for finding the
// packages. deadline: the time the layer docs stop starting.
async function planGroundedLayers({ files, allFiles = files, fileInfo, folders = new Map(), readSource = () => null, call, contextTokens, promptChars = 4000, styleRules = '', errors = [], splits = [], deadline = Infinity, now = Date.now }) {
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
  const purposeOf = (f) => (fileInfo.get(f) || {}).summary || '';
  // Every file's purpose in the project: a layer's description may repeat none of them.
  const purposes = files.map(purposeOf).filter(Boolean);
  let importers = null;
  const importedBy = (file) => {
    if (!importers) {
      importers = new Map();
      for (const f of files) for (const target of new Set(importsOf(f))) if (target !== f) importers.set(target, (importers.get(target) || 0) + 1);
    }
    return importers.get(file) || 0;
  };

  const taken = new Set();
  // The parts of a large group: by the docs model, or by clustering its imports when its answers
  // break the rules, or when useModel is false, with the reason why. splits gets a line saying
  // which.
  const divide = async (group, maxParts, { useModel = true, reason = '', noun = 'layers' } = {}) => {
    const supported = (partFiles, name) => supports(groupText({ folders: partFolders(group, partFiles), files: partFiles, partial: true }, fileInfo, folders), name);
    const byModel = useModel
      ? await splitWithModel(group, {
        call, purposeOf, importsOf, maxParts, minSize: MIN_GROUP_FILES, supported, copies: (d) => copiesPurpose(d, purposes), taken,
        contextTokens, promptChars, styleRules, errors,
      })
      : { parts: null, reason };
    const what = `${where(group)} (${group.files.length} files)`;
    let parts = byModel.parts;
    if (parts) {
      parts.forEach((p) => taken.add(p.name.toLowerCase()));
      const placed = byModel.placed ? `, and ${byModel.placed} ${byModel.placed === 1 ? 'file' : 'files'} it left out ${byModel.placed === 1 ? 'was' : 'were'} placed by imports and purposes` : '';
      splits.push(`${what} was split into ${parts.length} ${noun} by the docs model${byModel.attempts > 1 ? ', on its second answer' : ''}${placed}`);
    } else {
      parts = clusterParts(group, maxParts, importsOf, purposeOf);
      splits.push(parts.length > 1
        ? `${what} was split into ${parts.length} ${noun} by clustering its imports, because ${byModel.reason}`
        : `${what} stays one ${noun.replace(/s$/, '')}: ${byModel.reason}, and clustering its imports found no parts`);
    }
    return parts;
  };

  const packages = findPackages(allFiles, readSource);
  if (isLargeProject(files, packages)) {
    const describeGroup = (part, members, { useModel }) => groupDescription(part, members, { call, folders, contextTokens, promptChars, styleRules, errors, useModel });
    return planPartLayers({ files, packages, folders, purposeOf, importsOf, importedBy, divide, describeGroup, taken, splits, deadline, now });
  }

  const steps = splitSteps(folderGroups(files, importsOf), importsOf);
  let step = steps.next();
  while (!step.done) step = steps.next(await divide(step.value.group, step.value.maxParts));
  const groups = finishGroups(step.value);
  // The name a group gets when the model gives it none: its folder's, and for a part of a
  // folder, with its most central file's name, such as "Source Ollama".
  const fallbackName = (group) => (group.part ? `${folderName(group.folder)} ${group.part.word}` : folderName(group.folder));
  // A part with no description is described by its most imported files' purposes.
  const describe = (description, partial, layerFiles) => description || (partial ? purposeSentence(layerFiles, purposeOf, importedBy) : '');
  const order = (ids) => Math.min(...ids.map((id) => Number(id.slice(1))));
  // Parts the model named when it split them are layers already.
  const layers = groups.filter((g) => g.named).map((g) => ({ name: g.named.name, description: g.named.description, files: g.files, at: order([g.id]) }));
  const unnamed = groups.filter((g) => !g.named);
  let answer = null;
  if (unnamed.length) {
    try {
      const content = await call('layers', {
        messages: layersPrompt(unnamed, fileInfo, folders, promptChars, styleRules),
        format: LAYERS_SCHEMA,
        options: { temperature: 0.2, seed: 42, num_ctx: contextTokens, num_predict: 120 + 80 * unnamed.length },
      });
      answer = JSON.parse(content);
    } catch (err) {
      errors.push(`layers: ${err.message}`);
    }
  }
  const byId = new Map(unnamed.map((g) => [g.id, g]));
  const assigned = new Set();
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
    layers.push({ name: grounded ? name : fallbackName(byId.get(members[0])), description: describe(description, merged.partial, merged.files), files: merged.files, at: order(members) });
  }
  for (const group of unnamed) {
    if (!assigned.has(group.id)) layers.push({ name: fallbackName(group), description: describe('', Boolean(group.part), group.files), files: group.files, at: order([group.id]) });
  }
  return { layers: layers.sort((a, b) => a.at - b.at).map(({ name, description, files: layerFiles }) => ({ name, description, files: layerFiles })) };
}

module.exports = { GENERIC_NAMES, LAYERS_SCHEMA, MAX_LAYERS, SPLIT_ABOVE, copiesPurpose, folderName, groupDescription, groupFiles, groupSentenceProblem, layersPrompt, partDescription, planGroundedLayers, purposeSentence, supports };
