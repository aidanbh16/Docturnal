'use strict';

// Builds .docturnal/last-run.md, which the GitHub App uses as the pull request description.

const MAX_REJECTION_ROWS = 100;

// What happened to proposed comments, by category, in report order.
const DROP_LABELS = {
  placement: 'dropped by placement rules',
  length: 'dropped by the length limit',
  density: 'dropped by the density limit',
  inaccurate: 'inaccurate',
  restates: 'restates the code',
  safety: 'rejected by the safety check',
  off: 'skipped because the comment level is off',
};

const VERIFIERS = { typescript: 'Yes (TypeScript)', python: 'Yes (Python)' };

// File names, headings, and layer names come from the repository, and this text becomes a
// pull request description under the app's name. code() puts a name in a code span its own
// backticks cannot end; plainText() escapes Markdown, mentions, and autolinks.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

function code(text, { table = false } = {}) {
  let value = String(text).replace(CONTROL, ' ');
  if (table) value = value.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

function plainText(text) {
  return String(text)
    .replace(CONTROL, ' ')
    .replace(/[\\`*_[\]<>#!|~]/g, '\\$&')
    .replace(/@/g, '&#64;')
    .replace(/:\/\//g, ':&#47;&#47;')
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}&#46;`);
}

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

// One file's proposals as counts, for example "proposed 3, 1 restates the code, 1 inaccurate,
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
//   readme: { updated, notReadded, fallback } with section headings, or null }
const DOCS_TITLE = 'Docturnal: documentation';
const UPDATE_TITLE = 'Docturnal: comments and documentation';

// The pull request's title: documentation only until it holds comments.
function pullRequestTitle(pending) {
  return pending.docs && !pending.changed.length && !pending.batch ? DOCS_TITLE : UPDATE_TITLE;
}

const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]);

// The progress section that opens every pull request: how far the documentation and the
// comments have come, what this pull request holds, and what comes next.
// p: { docsComplete, summarized, documentable, layers, level, commented, commentable,
//      existingCode, pending, backlogLeft, nextBatch, batchSize, timeLimit: { minutes, private } }
function progressLines(p) {
  const lines = ['## Progress', ''];
  // Docs left by the time budget, such as a large project's sub-documents after its part
  // documents, are written on the next run.
  lines.push(!p.docsComplete
    ? `- **Documentation:** in progress, ${p.summarized} of ${plural(p.documentable, 'file')} read. The rest follow on the next run.`
    : p.docsWaiting
      ? `- **Documentation:** every file is read, and ${plural(p.layers, 'layer document')} and the README are written. ${plural(p.docsWaiting, 'more document')} ${p.docsWaiting === 1 ? 'follows' : 'follow'} on the next run.`
      : `- **Documentation:** complete, with ${plural(p.layers, 'layer document')} and the README.`);
  lines.push(p.level === 'off'
    ? '- **Comments:** off. Docturnal only keeps the documentation up to date.'
    : `- **Comments:** ${p.commented} of ${plural(p.commentable, 'file')} commented at the ${p.level} level.`);

  const holds = [];
  if (p.pending.docs) holds.push('documentation for the whole project');
  if (p.pending.changed.length) holds.push(`comments on ${plural(p.pending.changed.length, 'new or changed file')}`);
  if (p.pending.batch) {
    const where = p.pending.batch.layers.length ? ` in the ${listOf(p.pending.batch.layers.map(plainText))} ${p.pending.batch.layers.length === 1 ? 'layer' : 'layers'}` : '';
    holds.push(`batch ${p.pending.batch.number} of existing code, ${plural(p.pending.batch.files.length, 'file')}${where}`);
  }
  lines.push(`- **This pull request:** ${holds.length ? listOf(holds) : 'updates to the documentation'}.`);

  let next;
  if (!p.docsComplete) next = 'the rest of the documentation.';
  else if (p.level === 'off') next = 'documentation updates when your code changes.';
  else if (p.existingCode === 'none') next = 'comments on new and changed code only. Existing code is not commented; the "Existing code" setting changes that.';
  else if (p.backlogLeft === 0) next = 'comments on new and changed code. Every existing file is commented.';
  else if (p.pending.batch) next = `batch ${p.nextBatch} of existing code, after you merge or close this pull request. ${plural(p.backlogLeft, 'existing file')} ${p.backlogLeft === 1 ? 'is' : 'are'} left.`;
  else next = `comments on existing code in batches of up to ${p.batchSize} files, starting with batch ${p.nextBatch} and the most important files. ${plural(p.backlogLeft, 'existing file')} ${p.backlogLeft === 1 ? 'is' : 'are'} left.`;
  lines.push(`- **Next:** ${next}`);
  // A private repository's runs count toward its owner's Actions minutes, so its nights are
  // shorter, as the settings choose.
  if (p.timeLimit) {
    lines.push(p.timeLimit.private
      ? `- **Time limit:** ${plural(p.timeLimit.minutes, 'minute')} a night, the limit for private repositories. You can change it in the settings.`
      : `- **Time limit:** ${plural(p.timeLimit.minutes, 'minute')} a night.`);
  }
  return lines;
}

// leftOver: [{ path, reason }]
// skipped: [{ path, reason }], files that were not commented, such as ones with syntax errors
// models: { comment, docs, fallback, fallbackUsed, level }
// title: the pull request's title, the report's first line. progress: see progressLines.
function buildReport({ processed = [], docs = { updated: [], removed: [], pending: [] }, leftOver = [], skipped = [], models, title = UPDATE_TITLE, progress = null, summarized = 0 }) {
  const added = processed.reduce((sum, f) => sum + f.added, 0);
  const commented = processed.filter((f) => f.added > 0).length;

  const summary = [];
  if (added) summary.push(`adds ${plural(added, 'comment')} to ${plural(commented, 'file')}`);
  if (docs.updated.length) summary.push(`updates ${plural(docs.updated.length, 'doc')}`);
  if (docs.readme && docs.readme.updated.length) summary.push('updates the README');
  if (docs.removed.length) summary.push(`removes ${plural(docs.removed.length, 'doc')}`);
  if (summarized && !summary.length) summary.push(`reads ${plural(summarized, 'file')} for the documentation`);
  const what = summary.length ? `The latest run ${summary.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'The latest run updates Docturnal\'s records of your code.';
  const lines = [`# ${title}`, ''];
  if (progress) lines.push(...progressLines(progress), '');
  lines.push(`${what} Review the changes, then merge the pull request to keep them.`);

  if (processed.length) {
    lines.push('', '## Comments added', '', '| File | Comments added | Checked by a parser | Proposed comments |', '| --- | --- | --- | --- |');
    for (const file of processed) {
      const proposals = file.stats ? proposalSummary(file.stats) : '-';
      lines.push(`| ${code(file.path, { table: true })} | ${file.added} | ${VERIFIERS[file.verifier] || 'No, placement rules only'} | ${cell(proposals)} |`);
    }
  }

  if (docs.updated.length || docs.removed.length) {
    lines.push('', '## Docs', '');
    for (const doc of docs.updated) lines.push(`- Updated ${code(doc.path)}${doc.fallback ? ' (written with the fallback model)' : ''}`);
    for (const doc of docs.removed) {
      lines.push(/(^|\/)README\.md$/.test(doc)
        ? `- Removed ${code(doc)} because the main document is now \`README.md\` at the repository root`
        : `- Removed ${code(doc)} because its layer no longer exists`);
    }
  }

  // The README lists sections by heading only, never their text.
  const readme = docs.readme;
  if (readme && (readme.updated.length || readme.notReadded.length)) {
    const list = (items) => items.map((h) => `"${plainText(String(h).replace(/\s+/g, ' ').trim())}"`).join(', ');
    lines.push('', '## README', '');
    if (readme.updated.length) lines.push(`- Updated: ${list(readme.updated)}${readme.fallback ? ' (written with the fallback model)' : ''}`);
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
      lines.push(`| ${code(r.path, { table: true })} | ${Number.isInteger(r.line) ? r.line : '-'} | ${cell(r.reason)} |`);
    }
    if (rejected.length > MAX_REJECTION_ROWS) lines.push('', `${rejected.length - MAX_REJECTION_ROWS} more are not shown.`);
  }

  if (skipped.length) {
    lines.push('', '## Files skipped', '');
    for (const item of skipped) lines.push(`- ${code(item.path)}: skipped, ${item.reason}`);
  }

  const waiting = [...leftOver, ...docs.pending];
  if (waiting.length) {
    lines.push('', '## Left for the next run', '');
    for (const item of waiting) lines.push(`- ${code(item.path)}: ${item.reason}`);
  }

  lines.push('', '## Models', '', `- Comment model: \`${models.comment}\``, `- Docs model: \`${models.docs}\``, `- Comment level: ${models.level}`);
  if (models.fallbackUsed) {
    lines.push(`- The docs model could not load, so docs marked "written with the fallback model" used \`${models.fallback}\`.`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { DOCS_TITLE, UPDATE_TITLE, buildReport, code, plainText, progressLines, proposalSummary, pullRequestTitle };
