'use strict';

// Records, for each model in pins/models.json, the digest of every blob its manifest on
// registry.ollama.ai references: the config, the weights, the template, the system prompt,
// the parameters, the license, and so on. The Action requires a pulled model to reference
// exactly these blobs, and every blob file to hash to its digest.
//
//   node scripts/update-models.js                  refreshes every pinned model
//   node scripts/update-models.js qwen2.5-coder:3b  adds or refreshes one model
//
// ollama.com shows the first 12 characters of each layer's digest on the model's page, so you
// can compare them there before you commit.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PINS_PATH = path.join(__dirname, '..', 'pins', 'models.json');
const REGISTRY = 'https://registry.ollama.ai/v2';

// "qwen2.5-coder:3b" -> its manifest URL; a name without a namespace is in "library".
function manifestUrl(name) {
  const [model, tag = 'latest'] = name.split(':');
  const repository = model.includes('/') ? model : `library/${model}`;
  return `${REGISTRY}/${repository}/manifests/${tag}`;
}

const KIND = /^application\/vnd\.ollama\.image\.(.+)$/;

// The pin for one model, from its manifest's bytes.
function pinFromManifest(bytes) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  const blobs = [{ kind: 'config', digest: manifest.config.digest, size: manifest.config.size }];
  for (const layer of manifest.layers || []) {
    const kind = (KIND.exec(layer.mediaType || '') || [])[1] || layer.mediaType || 'layer';
    blobs.push({ kind, digest: layer.digest, size: layer.size });
  }
  for (const blob of blobs) {
    if (!/^sha256:[0-9a-f]{64}$/.test(blob.digest)) throw new Error(`The manifest names a blob without a SHA-256 digest: ${blob.digest}`);
  }
  return {
    // The registry manifest itself, for reference only: Ollama saves its own copy of the
    // manifest, whose bytes differ, so the Action checks the blobs instead.
    manifest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    blobs,
  };
}

async function fetchPin(name, fetchFn = fetch) {
  const response = await fetchFn(manifestUrl(name), { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  if (!response.ok) throw new Error(`${manifestUrl(name)}: HTTP ${response.status}`);
  return pinFromManifest(Buffer.from(await response.arrayBuffer()));
}

async function main(names) {
  const pins = fs.existsSync(PINS_PATH) ? JSON.parse(fs.readFileSync(PINS_PATH, 'utf8')) : {};
  for (const name of names.length ? names : Object.keys(pins)) {
    const pin = await fetchPin(name);
    const before = JSON.stringify(pins[name]);
    pins[name] = pin;
    console.log(`${name}: ${before === JSON.stringify(pin) ? 'unchanged' : 'updated'}, from ${manifestUrl(name)}`);
    for (const blob of pin.blobs) console.log(`  ${blob.kind.padEnd(8)} ${blob.digest} (${blob.size} bytes)`);
  }
  fs.writeFileSync(PINS_PATH, `${JSON.stringify(pins, null, 2)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { fetchPin, manifestUrl, pinFromManifest };
