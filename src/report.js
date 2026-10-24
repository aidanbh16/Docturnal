'use strict';

// Builds .docturnal/last-run.md, which the GitHub App uses as the pull request description.

const MAX_REJECTION_ROWS = 100;

// What happened to proposed comments, by category, in report order.
const DROP_LABELS = {
  placement: 'dropped by placement rules',
  anchor: 'anchor not found',
  length: 'dropped by the length limit',
  density: 'dropped by the density limit',
  inaccurate: 'inaccurate',
  safety: 'rejected by the safety check',
  off: 'skipped because the comment level is off',
};

const VERIFIERS = { typescript: 'Yes (TypeScript)', python: 'Yes (Python)' };

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// A reason without details that could come from the file, such as a parser message.
function shortReason(reason) {
  return reason.replace(/^(cannot analyze file):.*$/s, '$1');
}

// One file's proposals as counts, for example "proposed 3, 1 anchor not found, 1 inaccurate,
// 1 added", then what happened to the comments Docturnal wrote on earlier runs. With reasons,
// each category lists its reasons with counts. It never includes comment text or code.
function proposalSummary(stats, { reasons = false } = {}) {
  const parts = [`proposed ${stats.proposed}`];
  for (const [category, label] of Object.entries(DROP_LABELS)) {
    const counts = Object.entries(stats.dropped[category] || {});
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    if (!total) continue;
    const detail = reasons ? ` (${counts.map(([reason, n]) => `${shortReason(reason)}: ${n}`).join(', ')})` : '';
    parts.push(`${total} ${label}${detail}`);
  }
  parts.push(`${stats.added} added`);
  const summary = parts.join(', ');
  const earlier = stats.earlier;
  if (!earlier) return summary;
  const removed = Object.entries(earlier.removed || {});
  const removedTotal = removed.reduce((sum, [, n]) => sum + n, 0);
  if (!earlier.kept && !removedTotal) return summary;
  const kept = `${earlier.kept} kept${earlier.restyled ? ` (${earlier.restyled} restyled for the level)` : ''}`;
  const gone = removedTotal ? `, ${removedTotal} removed (${removed.map(([reason, n]) => `${shortReason(reason)}: ${n}`).join(', ')})` : '';
  return `${summary}; earlier Docturnal comments: ${kept}${gone}`;
}

// processed: [{ path, verifier, added, rejections, stats }]
// docs: { updated: [{ path, fallback }], removed: [path], pending: [{ path, reason }],
//   readme: { updated, polished, kept, notReadded, fallback } with section headings, or null }
// leftOver: [{ path, reason }]
// models: { comment, docs, fallback, fallbackUsed, level }
function buildReport({ processed = [], docs = { updated: [], removed: [], pending: [] }, leftOver = [], models }) {
  const added = processed.reduce((sum, f) => sum + f.added, 0);
  const commented = processed.filter((f) => f.added > 0).length;

  const summary = [];
  if (added) summary.push(`adds ${plural(added, 'comment')} to ${plural(commented, 'file')}`);
  if (docs.updated.length) summary.push(`updates ${plural(docs.updated.length, 'doc')}`);
  if (docs.readme && (docs.readme.updated.length || docs.readme.polished.length)) summary.push('updates the README');
  if (docs.removed.length) summary.push(`removes ${plural(docs.removed.length, 'doc')}`);
  const what = summary.length ? `This pull request ${summary.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'This pull request updates Docturnal\'s records of your code.';
  const lines = ['# Docturnal update', '', `${what} Review the changes, then merge the pull request to keep them.`];

  if (processed.length) {
    lines.push('', '## Comments added', '', '| File | Comments added | Checked by a parser | Proposed comments |', '| --- | --- | --- | --- |');
    for (const file of processed) {
      const proposals = file.stats ? proposalSummary(file.stats) : '-';
      lines.push(`| \`${cell(file.path)}\` | ${file.added} | ${VERIFIERS[file.verifier] || 'No, placement rules only'} | ${cell(proposals)} |`);
    }
  }

  if (docs.updated.length || docs.removed.length) {
    lines.push('', '## Docs', '');
    for (const doc of docs.updated) lines.push(`- Updated \`${doc.path}\`${doc.fallback ? ' (written with the fallback model)' : ''}`);
    for (const doc of docs.removed) {
      lines.push(/(^|\/)README\.md$/.test(doc)
        ? `- Removed \`${doc}\` because the main document is now \`README.md\` at the repository root`
        : `- Removed \`${doc}\` because its layer no longer exists`);
    }
  }

  // The README lists sections by heading only, never their text.
  const readme = docs.readme;
  if (readme && (readme.updated.length || readme.polished.length || readme.kept.length || readme.notReadded.length)) {
    const list = (items) => items.map((h) => `"${cell(h)}"`).join(', ');
    lines.push('', '## README', '');
    if (readme.updated.length) lines.push(`- Updated: ${list(readme.updated)}${readme.fallback ? ' (written with the fallback model)' : ''}`);
    if (readme.polished.length) lines.push(`- Polished for clarity: ${list(readme.polished)}`);
    if (readme.kept.length) lines.push(`- Kept in your wording: ${list(readme.kept)}`);
    if (readme.notReadded.length) lines.push(`- Not re-added because you removed them: ${list(readme.notReadded)}`);
  }

  // The proposed-comments column covers placement, length, and density. This section lists
  // each rejection that protects the code, by line and reason.
  const rejected = [];
  for (const file of processed) {
    for (const r of file.rejections || []) {
      if (r.category === 'safety') rejected.push({ path: file.path, line: r.line, reason: shortReason(r.reason) });
    }
  }
  if (rejected.length) {
    lines.push('', '## Comments rejected by the safety check', '', '| File | Line | Reason |', '| --- | --- | --- |');
    for (const r of rejected.slice(0, MAX_REJECTION_ROWS)) {
      lines.push(`| \`${cell(r.path)}\` | ${Number.isInteger(r.line) ? r.line : '-'} | ${cell(r.reason)} |`);
    }
    if (rejected.length > MAX_REJECTION_ROWS) lines.push('', `${rejected.length - MAX_REJECTION_ROWS} more are not shown.`);
  }

  const waiting = [...leftOver, ...docs.pending];
  if (waiting.length) {
    lines.push('', '## Left for the next run', '');
    for (const item of waiting) lines.push(`- \`${item.path}\`: ${item.reason}`);
  }

  lines.push('', '## Models', '', `- Comment model: \`${models.comment}\``, `- Docs model: \`${models.docs}\``, `- Comment level: ${models.level}`);
  if (models.fallbackUsed) {
    lines.push(`- The docs model could not load, so docs marked "written with the fallback model" used \`${models.fallback}\`.`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildReport, proposalSummary };
