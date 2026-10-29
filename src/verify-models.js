'use strict';

// Checks each pulled model against pins/models.json before any code reaches it. Ollama saves
// its own copy of a model's manifest, whose bytes differ from the registry's, so the manifest
// is read only for the blobs it references:
// - the set of blob digests (config and every layer: weights, template, system prompt,
//   parameters, license, and so on) must equal the pinned set exactly, and
// - every blob file in the models folder must hash to its digest, which also catches a models
//   folder restored from a tampered cache.
// A mismatch fails with the model's name and the expected and actual digests.
//
//   node src/verify-models.js <model> [<model> ...]   with OLLAMA_HOST and OLLAMA_MODELS set

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const PINS_PATH = path.join(__dirname, '..', 'pins', 'models.json');
const DIGEST = /^sha256:[0-9a-f]{64}$/;

class ModelDigestError extends Error {}

// Reads pins data from a file, returning parsed JSON.
function readPins(file = PINS_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return `sha256:${hash.digest('hex')}`;
}

// Where Ollama saves a model's manifest.
function manifestPath(modelsDir, name) {
  const [model, tag] = name.split(':');
  const namespace = model.includes('/') ? model : `library/${model}`;
  return path.join(modelsDir, 'manifests', 'registry.ollama.ai', ...namespace.split('/'), tag);
}

// The blob digests a saved manifest references: its config and every layer.
function referencedDigests(manifest) {
  return [manifest.config, ...(Array.isArray(manifest.layers) ? manifest.layers : [])].map((blob) => (blob && typeof blob.digest === 'string' ? blob.digest : String(blob && blob.digest)));
}

// Compares the digests a saved manifest names with the pin. Ollama 0.40 also keeps the
// registry manifest itself as a blob, so the pinned manifest digest is the one extra allowed;
// its file is then hashed like every other blob. Returns { expected, missing, extra,
// manifestBlob }, where manifestBlob is that extra blob to hash, or null.
function compareBlobs(pin, actual) {
  const expected = pin.blobs.map((b) => b.digest);
  const missing = expected.filter((d) => !actual.includes(d));
  const manifestBlob = DIGEST.test(pin.manifest || '') && actual.includes(pin.manifest) && !expected.includes(pin.manifest)
    ? { kind: 'manifest', digest: pin.manifest }
    : null;
  const extra = actual.filter((d) => !expected.includes(d) && !(manifestBlob && d === manifestBlob.digest));
  return { expected, missing, extra, manifestBlob };
}

const describe = (digests) => (digests.length ? [...digests].sort().join(', ') : 'none');

// Checks one model's files in the models folder against its pin. Returns the total size of
// its blobs.
async function verifyFiles(modelsDir, name, pin) {
  if (!pin || !Array.isArray(pin.blobs) || !pin.blobs.length || !pin.blobs.every((b) => DIGEST.test(b.digest))) {
    throw new ModelDigestError(`${name} has no pinned blobs in pins/models.json, so Docturnal does not run it. Run node scripts/update-models.js ${name} and commit the result.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath(modelsDir, name), 'utf8'));
  } catch {
    throw new ModelDigestError(`${name} has no readable manifest in the models folder, so Docturnal does not run it.`);
  }
  const actual = referencedDigests(manifest);
  const { expected, missing, extra, manifestBlob } = compareBlobs(pin, actual);
  if (missing.length || extra.length || new Set(actual).size !== actual.length) {
    throw new ModelDigestError(
      `The blobs of ${name} in the models folder do not match pins/models.json, so Docturnal does not run it. ` +
      `Expected ${describe(expected)}; actual ${describe(actual)}.` +
      `${missing.length ? ` Missing: ${describe(missing)}.` : ''}${extra.length ? ` Not pinned: ${describe(extra)}.` : ''}`,
    );
  }
  let bytes = 0;
  for (const blob of manifestBlob ? [...pin.blobs, manifestBlob] : pin.blobs) {
    const file = path.join(modelsDir, 'blobs', blob.digest.replace(':', '-'));
    let hash;
    try {
      hash = await sha256File(file);
    } catch {
      throw new ModelDigestError(`The ${blob.kind || 'blob'} file of ${name} is missing from the models folder, so Docturnal does not run it. Expected ${blob.digest}.`);
    }
    if (hash !== blob.digest) {
      throw new ModelDigestError(`The ${blob.kind || 'blob'} file of ${name} does not match its digest, so Docturnal does not run it. Expected ${blob.digest}, got ${hash}.`);
    }
    bytes += fs.statSync(file).size;
  }
  return bytes;
}

async function verifyModels({ host, models, modelsDir, pins = readPins(), fetchFn = fetch, log = console.log }) {
  if (!modelsDir) throw new ModelDigestError('OLLAMA_MODELS is not set, so the model files cannot be checked.');
  const response = await fetchFn(`http://${host}/api/tags`);
  if (!response.ok) throw new ModelDigestError(`Could not list the models on the Ollama server: HTTP ${response.status}.`);
  const listed = (await response.json()).models || [];
  for (const model of [...new Set(models)]) {
    const name = withTag(model);
    if (!pins[name]) throw new ModelDigestError(`${name} has no pinned blobs in pins/models.json, so Docturnal does not run it.`);
    if (!listed.some((m) => withTag(m.name || m.model || '') === name)) throw new ModelDigestError(`${name} is not on the Ollama server after the pull.`);
    const bytes = await verifyFiles(modelsDir, name, pins[name]);
    const weights = pins[name].blobs.find((b) => b.kind === 'model') || pins[name].blobs[0];
    log(`Model verified: ${name}, ${pins[name].blobs.length} files (${(bytes / 1e9).toFixed(1)} GB), weights ${weights.digest.slice(7, 19)}.`);
  }
}

if (require.main === module) {
  verifyModels({ host: process.env.OLLAMA_HOST, models: process.argv.slice(2).filter(Boolean), modelsDir: process.env.OLLAMA_MODELS || undefined }).catch((err) => {
    console.error(`::error::${err instanceof ModelDigestError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { ModelDigestError, compareBlobs, readPins, referencedDigests, verifyFiles, verifyModels };
