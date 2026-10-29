'use strict';

// An unexpected error while working on one file or one document skips only that file or
// document for this run. The log names the error, never code or comment text: quoted parts of
// the message, where a parser or JSON.parse puts the text it read, are left out.

const INTERNAL_ERROR = 'skipped this run, internal error';
const MAX_MESSAGE = 160;

// "TypeError: function is not iterable", from an error or anything thrown.
function describeInternal(err) {
  const name = err && typeof err.name === 'string' && /^\w{1,40}$/.test(err.name) ? err.name : 'Error';
  const raw = err && typeof err.message === 'string' ? err.message : String(err);
  const message = raw.split(/\r?\n/)[0]
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '...')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, MAX_MESSAGE);
  return message ? `${name}: ${message}` : name;
}

// The log line for a file or document skipped this run: "<file>: skipped this run, internal
// error (TypeError: ...)".
function internalErrorLine(what, err) {
  return `${what}: ${INTERNAL_ERROR} (${describeInternal(err)})`;
}

module.exports = { INTERNAL_ERROR, describeInternal, internalErrorLine };
