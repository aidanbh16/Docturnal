'use strict';

// Lists what the Ollama install uses from a release archive (.tar.zst): every file under
// bin/ and lib/ollama/ except the GPU libraries, with its SHA-256, and every symbolic link
// with its target. scripts/update-ollama.sh stores this in pins/ollama.json, and the Action
// checks an install, including one restored from the cache, against it.
//
//   node scripts/archive-hashes.js <archive.tar.zst>

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const GPU = /^lib\/ollama\/(cuda_|rocm|vulkan)/;

function wanted(name) {
  return (name.startsWith('bin/') || name.startsWith('lib/ollama/')) && !GPU.test(name);
}

function field(header, start, length) {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

// Reads a tar stream: { files: { path: sha256 }, links: { path: target } }.
function hashTar(stream) {
  return new Promise((resolve, reject) => {
    const files = {};
    const links = {};
    let buffer = Buffer.alloc(0);
    let entry = null;
    let longName = null;
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (entry) {
          const take = Math.min(entry.remaining, buffer.length);
          if (entry.hash) entry.hash.update(buffer.subarray(0, take));
          if (entry.collect) entry.collect.push(buffer.subarray(0, take));
          buffer = buffer.subarray(take);
          entry.remaining -= take;
          if (entry.remaining > 0) return;
          if (entry.hash) files[entry.name] = entry.hash.digest('hex');
          if (entry.collect) longName = Buffer.concat(entry.collect).toString('utf8').replace(/\0.*$/s, '');
          const padding = (512 - (entry.size % 512)) % 512;
          entry = { padding };
        }
        if (entry && entry.padding !== undefined) {
          if (buffer.length < entry.padding) return;
          buffer = buffer.subarray(entry.padding);
          entry = null;
        }
        if (buffer.length < 512) return;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((b) => b === 0)) continue;
        const prefix = field(header, 345, 155);
        let name = longName || (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        longName = null;
        name = name.replace(/^\.\//, '');
        const size = parseInt(field(header, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156]);
        if (type === 'L') {
          entry = { name, size, remaining: size, collect: [] };
        } else if ((type === '0' || type === '\0') && wanted(name)) {
          entry = { name, size, remaining: size, hash: crypto.createHash('sha256') };
        } else {
          if ((type === '2' || type === '1') && wanted(name)) links[name] = field(header, 157, 100);
          entry = { name, size, remaining: size };
        }
        if (size === 0) {
          if (entry.hash) files[name] = entry.hash.digest('hex');
          entry = null;
        }
      }
    });
    stream.on('end', () => resolve({ files, links }));
    stream.on('error', reject);
  });
}

async function hashArchive(file) {
  if (typeof zlib.createZstdDecompress !== 'function') throw new Error('This needs Node.js 22.15 or later, for zstd.');
  return hashTar(fs.createReadStream(file).pipe(zlib.createZstdDecompress()));
}

if (require.main === module) {
  hashArchive(process.argv[2]).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { hashArchive, hashTar, wanted };
