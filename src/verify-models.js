'use strict';

// Checks each pulled model's digest, as the Ollama server reports it in /api/tags, against
// pins/models.json, so a model that changed on the registry never runs over your code. With
// OLLAMA_MODELS set, it also checks the files on disk: the manifest must hash to the pinned
// digest, and each file it names must hash to its own digest, so a models folder restored from
// a tampered cache is never loaded.
//
//   node src/verify-models.js <model> [<model> ...]   with OLLAMA_HOST, and OLLAMA_MODELS, set

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const PINS_PATH = path.join(__dirname, '..', 'pins', 'models.json');

class ModelDigestError extends Error {}

function readPins(file = PINS_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);
const bareDigest = (digest) => String(digest || '').replace(/^sha256:/, '').toLowerCase();

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// The manifest and every blob of a pinned model, in Ollama's models folder.
async function verifyFiles(modelsDir, name, pinned) {
  const [model, tag] = name.split(':');
  const namespace = model.includes('/') ? model : `library/${model}`;
  const manifestPath = path.join(modelsDir, 'manifests', 'registry.ollama.ai', ...namespace.split('/'), tag);
  let manifest;
  try {
    manifest = fs.readFileSync(manifestPath);
  } catch {
    throw new ModelDigestError(`${name} has no manifest in the models folder.`);
  }
  const manifestDigest = crypto.createHash('sha256').update(manifest).digest('hex');
  if (manifestDigest !== bareDigest(pinned)) throw new ModelDigestError(`The manifest of ${name} in the models folder does not match the digest pinned in pins/models.json, so Docturnal does not run it.`);
  const { config, layers = [] } = JSON.parse(manifest.toString('utf8'));
  let bytes = 0;
  for (const layer of [config, ...layers]) {
    const digest = bareDigest(layer && layer.digest);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new ModelDigestError(`The manifest of ${name} names a file without a SHA-256 digest.`);
    const blob = path.join(modelsDir, 'blobs', `sha256-${digest}`);
    let actual;
    try {
      actual = await sha256File(blob);
    } catch {
      throw new ModelDigestError(`A file of ${name} is missing from the models folder.`);
    }
    if (actual !== digest) throw new ModelDigestError(`A file of ${name} in the models folder does not match its digest, so Docturnal does not run it. Expected ${digest}, got ${actual}.`);
    bytes += fs.statSync(blob).size;
  }
  return bytes;
}

async function verifyModels({ host, models, modelsDir, pins = readPins(), fetchFn = fetch, log = console.log }) {
  const response = await fetchFn(`http://${host}/api/tags`);
  if (!response.ok) throw new ModelDigestError(`Could not list the models on the Ollama server: HTTP ${response.status}.`);
  const listed = (await response.json()).models || [];
  for (const model of [...new Set(models)]) {
    const name = withTag(model);
    const pinned = pins[name];
    if (!pinned) throw new ModelDigestError(`${name} has no pinned digest in pins/models.json, so Docturnal does not run it.`);
    const entry = listed.find((m) => withTag(m.name || m.model || '') === name);
    if (!entry) throw new ModelDigestError(`${name} is not on the Ollama server after the pull.`);
    const actual = bareDigest(entry.digest);
    if (actual !== bareDigest(pinned)) {
      throw new ModelDigestError(
        `${name} does not match the digest pinned in pins/models.json, so Docturnal does not run it. ` +
        `Expected ${bareDigest(pinned)}, got ${actual || 'none'}. If the model was updated on purpose, run scripts/update-ollama.sh and commit the new digest.`,
      );
    }
    if (modelsDir) {
      const bytes = await verifyFiles(modelsDir, name, pinned);
      log(`Model verified: ${name} (${actual.slice(0, 12)}), and its files (${(bytes / 1e9).toFixed(1)} GB).`);
    } else {
      log(`Model verified: ${name} (${actual.slice(0, 12)}).`);
    }
  }
}

if (require.main === module) {
  verifyModels({ host: process.env.OLLAMA_HOST, models: process.argv.slice(2).filter(Boolean), modelsDir: process.env.OLLAMA_MODELS || undefined }).catch((err) => {
    console.error(`::error::${err instanceof ModelDigestError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { ModelDigestError, readPins, verifyFiles, verifyModels };
