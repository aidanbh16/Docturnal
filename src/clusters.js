'use strict';

// Splits a large group of files into a few clusters, so one big flat folder such as src/ gets
// a layer for each of its parts. Files are linked by their imports (a file many others import,
// such as a shared client, links each of them less), and by a word their names share
// (install-ollama.js and ollama.js) and the terms their purposes share, for files no other file
// imports, such as a script that action.yml runs. The clusters come from merging the pair of
// clusters that raises the graph's modularity the most, until no merge raises it; then a cluster
// smaller than the minimum joins its best neighbor, and while there are too many, the best pair
// merges. Everything is sorted first, so the same files always give the same clusters.

const path = require('path');

const { terms } = require('./grounding');

const IMPORT_WEIGHT = 1;
const NAME_WEIGHT = 1;
// Per term two purposes share, up to PURPOSE_MAX.
const PURPOSE_WEIGHT = 0.25;
const PURPOSE_MAX = 1;
// A term in more than one purpose in this many links nothing.
const COMMON_TERM_SHARE = 8;
// Words of file names that say nothing about what a file does.
const NAME_NOISE = new Set(['index', 'main', 'utils', 'util', 'helpers', 'helper', 'common', 'types', 'lib', 'test', 'tests', 'spec', 'mod', 'init']);

function nameWords(file) {
  return new Set(path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !NAME_NOISE.has(w)));
}

// files: the group's paths. importsOf(file): the project files it imports. purposeOf(file): its
// purpose, or ''. Returns an array of clusters (arrays of paths), or [files] when the group
// cannot be split into at least two clusters of minSize files.
function clusterFiles(files, { importsOf = () => [], purposeOf = () => '', maxClusters = 4, minSize = 3 } = {}) {
  const sorted = [...files].sort();
  const n = sorted.length;
  const most = Math.min(maxClusters, Math.floor(n / minSize));
  if (most < 2) return [sorted];
  const index = new Map(sorted.map((f, i) => [f, i]));
  // weight[i] is a Map(j -> weight) for j !== i, symmetric.
  const weight = sorted.map(() => new Map());
  const link = (i, j, w) => {
    if (i === j || !w) return;
    weight[i].set(j, (weight[i].get(j) || 0) + w);
    weight[j].set(i, (weight[j].get(i) || 0) + w);
  };
  // Import pairs, and how many files import each file: a file most others import, such as a
  // shared client, links each of them less, so it does not pull them all into one cluster.
  const edges = [];
  const importers = sorted.map(() => 0);
  sorted.forEach((file, i) => {
    for (const j of new Set(importsOf(file).map((t) => index.get(t)))) {
      if (j === undefined || j === i) continue;
      importers[j]++;
      edges.push([i, j]);
    }
  });
  const pairs = new Map();
  for (const [i, j] of edges) {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    // A file imported by k files links each of them with weight 1/k.
    pairs.set(key, Math.max(pairs.get(key) || 0, IMPORT_WEIGHT / importers[j]));
  }
  for (const [key, w] of pairs) {
    const [i, j] = key.split(',').map(Number);
    link(i, j, w);
  }
  const names = sorted.map(nameWords);
  // A term in many purposes, such as the project's name, links nothing.
  const termSets = sorted.map((f) => new Set(terms(purposeOf(f) || '')));
  const spread = new Map();
  for (const set of termSets) for (const t of set) spread.set(t, (spread.get(t) || 0) + 1);
  const purposes = termSets.map((set) => new Set([...set].filter((t) => spread.get(t) <= Math.max(2, n / COMMON_TERM_SHARE))));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ([...names[i]].some((w) => names[j].has(w))) link(i, j, NAME_WEIGHT);
      let shared = 0;
      for (const t of purposes[i]) if (purposes[j].has(t)) shared++;
      link(i, j, Math.min(PURPOSE_MAX, shared * PURPOSE_WEIGHT));
    }
  }
  const total = weight.reduce((sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0), 0);
  if (!total) return [sorted];

  // Clusters: { members, degree, links: Map(cluster id -> weight) }.
  const clusters = new Map();
  sorted.forEach((_, i) => {
    const degree = [...weight[i].values()].reduce((a, b) => a + b, 0);
    clusters.set(i, { members: [i], degree, links: new Map(weight[i]) });
  });
  // The change in modularity from merging clusters a and b.
  const gain = (a, b) => {
    const between = clusters.get(a).links.get(b) || 0;
    return 2 * (between / total - (clusters.get(a).degree / total) * (clusters.get(b).degree / total));
  };
  const merge = (a, b) => {
    const into = clusters.get(a);
    const from = clusters.get(b);
    into.members.push(...from.members);
    into.degree += from.degree;
    for (const [c, w] of from.links) {
      if (c === a) continue;
      into.links.set(c, (into.links.get(c) || 0) + w);
      const other = clusters.get(c).links;
      other.set(a, (other.get(a) || 0) + w);
      other.delete(b);
    }
    into.links.delete(b);
    clusters.delete(b);
  };
  // The best partner for each pair, by gain, then by the weight between them, then the smaller
  // cluster, then the lower id.
  const better = (x, y) => x.gain - y.gain || x.between - y.between || y.size - x.size || y.key - x.key;
  // linked: only pairs with a link between them, the only ones a merge can gain from.
  const bestPair = (candidates, linked = false) => {
    let best = null;
    for (const a of candidates) {
      for (const b of linked ? clusters.get(a).links.keys() : clusters.keys()) {
        if (a === b) continue;
        const option = { a, b, gain: gain(a, b), between: clusters.get(a).links.get(b) || 0, size: clusters.get(b).members.length, key: Math.min(a, b) * n + Math.max(a, b) };
        if (!best || better(option, best) > 0) best = option;
      }
    }
    return best;
  };
  for (;;) {
    const best = bestPair([...clusters.keys()], true);
    if (!best || best.gain <= 1e-12) break;
    merge(Math.min(best.a, best.b), Math.max(best.a, best.b));
  }
  // Clusters too small join their best neighbor, smallest first.
  for (;;) {
    const small = [...clusters].filter(([, c]) => c.members.length < minSize)
      .sort(([a, x], [b, y]) => x.members.length - y.members.length || a - b);
    if (!small.length || clusters.size <= 1) break;
    const best = bestPair([small[0][0]]);
    merge(Math.min(best.a, best.b), Math.max(best.a, best.b));
  }
  while (clusters.size > most) {
    const best = bestPair([...clusters.keys()]);
    merge(Math.min(best.a, best.b), Math.max(best.a, best.b));
  }
  if (clusters.size < 2) return [sorted];
  return [...clusters.values()]
    .map((c) => c.members.sort((a, b) => a - b).map((i) => sorted[i]))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

module.exports = { clusterFiles };
