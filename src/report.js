'use strict';

// Builds .docturnal/last-run.md, which the GitHub App uses as the pull request description.

// Rejections that protect the code. The rest only keep the comment level and placement tidy.
const SAFETY_REASON = /^(inside a string|shebang|tool directive|verification failed|cannot analyze|PHP file|contains \?>|JSDoc tag|mentions AI|emoji)/;
const MAX_REJECTION_ROWS = 100;

const VERIFIERS = { typescript: 'Yes (TypeScript)', python: 'Yes (Python)' };

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// processed: [{ path, verifier, added, rejections }]
// docs: { updated: [{ path, fallback }], removed: [path], pending: [{ path, reason }] }
// leftOver: [{ path, reason }]
// models: { comment, docs, fallback, fallbackUsed, level }
function buildReport({ processed = [], docs = { updated: [], removed: [], pending: [] }, leftOver = [], models }) {
  const added = processed.reduce((sum, f) => sum + f.added, 0);
  const commented = processed.filter((f) => f.added > 0).length;

  const summary = [];
  if (added) summary.push(`adds ${plural(added, 'comment')} to ${plural(commented, 'file')}`);
  if (docs.updated.length) summary.push(`updates ${plural(docs.updated.length, 'doc')}`);
  if (docs.removed.length) summary.push(`removes ${plural(docs.removed.length, 'doc')}`);
  const what = summary.length ? `This pull request ${summary.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'This pull request updates Docturnal\'s records of your code.';
  const lines = ['# Docturnal update', '', `${what} Review the changes, then merge the pull request to keep them.`];

  if (processed.length) {
    lines.push('', '## Comments added', '', '| File | Comments added | Checked by a parser |', '| --- | --- | --- |');
    for (const file of processed) {
      lines.push(`| \`${cell(file.path)}\` | ${file.added} | ${VERIFIERS[file.verifier] || 'No, placement rules only'} |`);
    }
  }

  if (docs.updated.length || docs.removed.length) {
    lines.push('', '## Docs', '');
    for (const doc of docs.updated) lines.push(`- Updated \`${doc.path}\`${doc.fallback ? ' (written with the fallback model)' : ''}`);
    for (const doc of docs.removed) lines.push(`- Removed \`${doc}\` because its layer no longer exists`);
  }

  const rejected = [];
  let otherCount = 0;
  for (const file of processed) {
    for (const r of file.rejections || []) {
      if (SAFETY_REASON.test(r.reason)) rejected.push({ path: file.path, line: r.line, reason: r.reason });
      else otherCount++;
    }
  }
  if (rejected.length || otherCount) {
    lines.push('', '## Comments rejected by the safety check', '');
    if (rejected.length) {
      lines.push('| File | Line | Reason |', '| --- | --- | --- |');
      for (const r of rejected.slice(0, MAX_REJECTION_ROWS)) {
        lines.push(`| \`${cell(r.path)}\` | ${Number.isInteger(r.line) ? r.line : '-'} | ${cell(r.reason)} |`);
      }
      if (rejected.length > MAX_REJECTION_ROWS) lines.push('', `${rejected.length - MAX_REJECTION_ROWS} more are not shown.`);
    } else {
      lines.push('No comments were rejected by the safety check.');
    }
    if (otherCount) lines.push('', `${plural(otherCount, 'other proposed comment')} ${otherCount === 1 ? 'was' : 'were'} left out to keep the comment level and placement rules.`);
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

module.exports = { buildReport };
