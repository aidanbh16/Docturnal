'use strict';

// Which comments in a file Docturnal wrote itself. Each comment Docturnal inserts is recorded
// in the state as its exact text and a hash of the code line under it. On a later run, a
// comment whose text still matches a record is Docturnal's: it may be checked again,
// replaced, or removed. A comment a person edited no longer matches, so it is theirs and is
// never touched.

const crypto = require('crypto');

function anchorHash(lineText) {
  return crypto.createHash('sha256').update(lineText.trim()).digest('hex').slice(0, 16);
}

// commentLines: the comment's lines as inserted; anchorText: the code line under it.
function recordFor(commentLines, anchorText) {
  return { text: commentLines.map((line) => line.trim()).join('\n'), anchor: anchorHash(anchorText) };
}

function isRecord(record) {
  return Boolean(record) && typeof record.text === 'string' && record.text !== '' && typeof record.anchor === 'string';
}

// lines: [{ text }]; info: per-line analysis with blank and commentOnly.
// Returns [{ start, end, anchor, record }] with line indices: the comment runs start..end
// that are Docturnal's, and the code line directly under each. A run is a whole block of
// comment lines directly above a code line, so a person's line added to it makes it theirs.
// When the same text appears more than once, the run whose code line matches the hash wins.
function findOwned(lines, info, records = []) {
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!info[i].commentOnly || (i > 0 && info[i - 1].commentOnly)) continue;
    let end = i;
    while (end + 1 < lines.length && info[end + 1].commentOnly) end++;
    const next = end + 1;
    if (next < lines.length && !info[next].blank) {
      runs.push({
        start: i,
        end,
        anchor: next,
        text: lines.slice(i, end + 1).map((line) => line.text.trim()).join('\n'),
        hash: anchorHash(lines[next].text),
      });
    }
    i = end;
  }

  const owned = [];
  const usedRuns = new Set();
  const usedRecords = new Set();
  const claim = (sameAnchor) => {
    records.forEach((record, r) => {
      if (usedRecords.has(r) || !isRecord(record)) return;
      const run = runs.find((candidate) => !usedRuns.has(candidate) && candidate.text === record.text &&
        (!sameAnchor || candidate.hash === record.anchor));
      if (!run) return;
      usedRuns.add(run);
      usedRecords.add(r);
      owned.push({ start: run.start, end: run.end, anchor: run.anchor, record });
    });
  };
  claim(true);
  claim(false);
  return owned.sort((a, b) => a.start - b.start);
}

// Records as read from the state file: only well-formed ones are kept.
function cleanRecords(value) {
  return Array.isArray(value) ? value.filter(isRecord).map(({ text, anchor }) => ({ text, anchor })) : [];
}

module.exports = { anchorHash, cleanRecords, findOwned, recordFor };
