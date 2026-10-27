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
