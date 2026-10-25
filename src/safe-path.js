'use strict';

// Docturnal reads and writes a few paths by name: README.md, docs/, .docturnal/, and
// project files such as package.json. A repository can commit any of them as a symbolic
// link, which would make a run read or write outside the repository. These paths are used
// only when neither they nor a folder above them is a link.

const fs = require('fs');
const path = require('path');

// True when `relative` (a path inside root, with / separators) and every folder above it are
// not symbolic links. A path that does not exist yet is plain if its existing folders are.
function isPlainPath(root, relative) {
  const parts = relative.split('/').filter(Boolean);
  if (parts.includes('..')) return false;
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return true;
    }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

class LinkError extends Error {}

// For Docturnal's own files: a link there has no use, so the run stops and says why.
function requirePlainPath(root, relative) {
  if (!isPlainPath(root, relative)) {
    throw new LinkError(`${relative} is a symbolic link, or is inside one. Docturnal does not follow links for its own files; replace it with a regular file or folder.`);
  }
}

module.exports = { LinkError, isPlainPath, requirePlainPath };
