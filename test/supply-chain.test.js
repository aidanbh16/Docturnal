'use strict';

// The pinned Ollama install and the model digests: what runs in users' repositories must
// match what the repository pins, or the run fails before any code reaches it.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { InstallError, installOllama, pinnedArchive, readPins } = require('../src/install-ollama');
const { ModelDigestError, verifyModels } = require('../src/verify-models');
const { startMockOllama } = require('./mock-ollama');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const archiveFetch = (body, calls = []) => async (url) => {
  calls.push(url);
  return new Response(body, { status: 200 });
};

describe('the pinned Ollama install', () => {
  const official = Buffer.from('the official Ollama archive');
  // What the install uses from the archive, with the hashes update-ollama.sh records.
  const contents = { files: { 'bin/ollama': sha256(Buffer.from('binary')), 'lib/ollama/libggml-cpu-x64.so': sha256(Buffer.from('cpu')) }, links: {} };
  const entry = (file) => ({ file, sha256: sha256(official), ...contents });
  const pins = { '0.40.11': { amd64: entry('ollama-linux-amd64.tar.zst'), arm64: entry('ollama-linux-arm64.tar.zst') } };
  // Stands in for tar: writes what the real archive has.
  const fakeExtract = (extracted, binary = 'binary') => (archive, dir) => {
    extracted.push(fs.readFileSync(archive));
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib', 'ollama'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'ollama'), binary);
    fs.writeFileSync(path.join(dir, 'lib', 'ollama', 'libggml-cpu-x64.so'), 'cpu');
  };
  const symlinks = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-link-'));
    try {
      fs.symlinkSync('target', path.join(dir, 'link'));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  const needsLinks = symlinks ? false : 'this system cannot create symbolic links';

  it('downloads the archive for the runner from GitHub releases, verifies it, and only then extracts it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
    const calls = [];
    const extracted = [];
    const logs = [];
    try {
      const result = await installOllama({ version: '0.40.11', arch: 'arm64', dir: path.join(dir, 'install'), tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official, calls), extract: fakeExtract(extracted), log: (l) => logs.push(l) });
      assert.deepStrictEqual(calls, ['https://github.com/ollama/ollama/releases/download/v0.40.11/ollama-linux-arm64.tar.zst']);
      assert.deepStrictEqual(extracted, [official]);
      assert.strictEqual(result.cached, false);
      assert.ok(logs.includes(`Checksum verified: ${sha256(official)}.`));
      // The archive itself is not kept.
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
      // The next run uses the cached install without downloading.
      const again = await installOllama({ version: '0.40.11', arch: 'arm64', dir: path.join(dir, 'install'), tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official, calls), extract: fakeExtract(extracted), log: () => {} });
      assert.strictEqual(again.cached, true);
      assert.strictEqual(calls.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered archive fails clearly, and nothing is extracted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
    const extracted = [];
    try {
      const tampered = Buffer.from('the official Ollama archive, with a backdoor');
      await assert.rejects(
        installOllama({ version: '0.40.11', arch: 'x64', dir: path.join(dir, 'install'), tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(tampered), extract: fakeExtract(extracted), log: () => {} }),
        (err) => err instanceof InstallError &&
          err.message === `The Ollama archive ollama-linux-amd64.tar.zst does not match the checksum pinned in pins/ollama.json, so it was not installed. Expected SHA-256 ${sha256(official)}, got ${sha256(tampered)}.`,
      );
      assert.deepStrictEqual(extracted, []);
      assert.strictEqual(fs.existsSync(path.join(dir, 'install', 'bin', 'ollama')), false);
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cached install from another archive is not used', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
    const calls = [];
    try {
      fs.mkdirSync(path.join(dir, 'install', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'install', 'bin', 'ollama'), 'old binary');
      fs.writeFileSync(path.join(dir, 'install', '.docturnal-sha256'), `${'0'.repeat(64)}\n`);
      const result = await installOllama({ version: '0.40.11', arch: 'x64', dir: path.join(dir, 'install'), tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official, calls), extract: fakeExtract([]), log: () => {} });
      assert.strictEqual(result.cached, false);
      assert.strictEqual(calls.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered cache entry, with the right marker but a changed binary or an extra library, is never run', async () => {
    for (const tamper of [
      (install) => fs.writeFileSync(path.join(install, 'bin', 'ollama'), 'backdoored binary'),
      (install) => fs.writeFileSync(path.join(install, 'lib', 'ollama', 'libggml-cpu-evil.so'), 'loaded by Ollama'),
      (install) => fs.rmSync(path.join(install, 'lib', 'ollama', 'libggml-cpu-x64.so')),
    ]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
      const calls = [];
      const logs = [];
      try {
        const install = path.join(dir, 'install');
        await installOllama({ version: '0.40.11', arch: 'x64', dir: install, tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official), extract: fakeExtract([]), log: () => {} });
        tamper(install);
        const result = await installOllama({ version: '0.40.11', arch: 'x64', dir: install, tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official, calls), extract: fakeExtract([]), log: (l) => logs.push(l) });
        assert.strictEqual(result.cached, false);
        assert.strictEqual(calls.length, 1);
        assert.ok(logs.some((l) => /^The cached Ollama does not match its pins (.+), so it is installed again.$/.test(l)), logs.join('\n'));
        assert.strictEqual(fs.readFileSync(path.join(install, 'bin', 'ollama'), 'utf8'), 'binary');
        assert.ok(!fs.existsSync(path.join(install, 'lib', 'ollama', 'libggml-cpu-evil.so')));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('an archive whose files do not match their pinned hashes is not installed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
    try {
      await assert.rejects(
        installOllama({ version: '0.40.11', arch: 'x64', dir: path.join(dir, 'install'), tmp: path.join(dir, 'tmp'), pins, fetchFn: archiveFetch(official), extract: fakeExtract([], 'other binary'), log: () => {} }),
        /The extracted Ollama does not match pins\/ollama\.json \(bin\/ollama does not match its pinned hash\), so it was not installed\./,
      );
      assert.ok(!fs.existsSync(path.join(dir, 'install')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks symbolic links in the install against their pinned targets', { skip: needsLinks }, () => {
    const { checkInstall } = require('../src/install-ollama');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ollama-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'ollama'), 'binary');
      fs.symlinkSync('../bin/ollama', path.join(dir, 'link'));
      const archive = { files: { 'bin/ollama': sha256(Buffer.from('binary')) }, links: { link: '../bin/ollama' } };
      assert.strictEqual(checkInstall(dir, archive), null);
      fs.rmSync(path.join(dir, 'link'));
      fs.symlinkSync('/usr/lib/evil.so', path.join(dir, 'link'));
      assert.strictEqual(checkInstall(dir, archive), 'link is not the pinned link');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a version without checksums, or another architecture, fails clearly', () => {
    assert.throws(() => pinnedArchive('0.99.0', 'x64', pins), /pins\/ollama\.json has no checksums for Ollama 0\.99\.0\. Run scripts\/update-ollama\.sh 0\.99\.0 and commit the result\./);
    assert.throws(() => pinnedArchive('0.40.11', 'ia32', pins), /only on Linux x64 and arm64 runners, not ia32/);
    assert.throws(() => pinnedArchive('latest', 'x64', pins), /not a release number/);
  });

  it('the repository pins the version action.yml names, for both architectures, with every file the install uses', () => {
    const action = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const version = /OLLAMA_VERSION: '(\d+\.\d+\.\d+)'/.exec(action)[1];
    for (const arch of ['x64', 'arm64']) {
      const archive = pinnedArchive(version, arch, readPins());
      assert.match(archive.url, new RegExp(`^https://github\\.com/ollama/ollama/releases/download/v${version.replace(/\./g, '\\.')}/ollama-linux-(amd64|arm64)\\.tar\\.zst$`));
      assert.match(archive.sha256, /^[0-9a-f]{64}$/);
      assert.match(archive.files['bin/ollama'], /^[0-9a-f]{64}$/);
      assert.ok(Object.keys(archive.files).some((f) => /^lib\/ollama\/libggml-cpu/.test(f)));
      assert.ok(!Object.keys(archive.files).some((f) => /cuda|rocm|vulkan/.test(f)));
    }
  });
});

describe('the model pins', () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pins', 'models.json'), 'utf8'));
  const { pinFromManifest } = require('../scripts/update-models');
  const { verifyFiles } = require('../src/verify-models');
  const digest = (buffer) => `sha256:${sha256(buffer)}`;

  // A small model as the registry serves it, and the pin update-models.js makes from it.
  const blobs = {
    config: Buffer.from('{"model_family":"qwen2"}'),
    model: Buffer.from('model weights'),
    template: Buffer.from('{{ .Prompt }}'),
    license: Buffer.from('Apache License 2.0'),
  };
  const layer = (kind) => ({ mediaType: `application/vnd.ollama.image.${kind}`, digest: digest(blobs[kind]), size: blobs[kind].length });
  const registryManifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: digest(blobs.config), size: blobs.config.length },
    layers: [layer('model'), layer('template'), layer('license')],
  }));
  const pin = pinFromManifest(registryManifest);
  const expectedList = Object.values(blobs).map(digest).sort().join(', ');

  // A models folder as Ollama leaves it: the saved manifest is written differently from the
  // registry's (key order, spacing, an extra field), with the same blobs.
  function modelsFolder({ layers = [layer('model'), layer('template'), layer('license')], write = blobs } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-models-'));
    const manifestDir = path.join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'blobs'));
    const saved = { layers, config: { digest: digest(blobs.config), mediaType: 'application/vnd.docker.container.image.v1+json', size: blobs.config.length }, schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', from: 'saved by Ollama' };
    fs.writeFileSync(path.join(manifestDir, '3b'), JSON.stringify(saved, null, 1));
    for (const [kind, content] of Object.entries(write)) fs.writeFileSync(path.join(dir, 'blobs', digest(blobs[kind]).replace(':', '-')), content);
    return dir;
  }
  async function rejectsWith(dir, pattern) {
    try {
      await assert.rejects(verifyFiles(dir, 'qwen2.5-coder:3b', pin), (err) => {
        assert.ok(err instanceof ModelDigestError);
        assert.match(err.message, pattern);
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('every model Docturnal picks is pinned by the digest of each blob its registry manifest names', () => {
    const { COMMENT_MODEL, DOCS_MODEL, FALLBACK_DOCS_MODEL } = require('../src/models');
    for (const model of [COMMENT_MODEL, DOCS_MODEL, FALLBACK_DOCS_MODEL]) {
      const kinds = pinned[model].blobs.map((b) => b.kind);
      assert.deepStrictEqual(kinds.slice(0, 2), ['config', 'model'], model);
      for (const blob of pinned[model].blobs) assert.match(blob.digest, /^sha256:[0-9a-f]{64}$/);
    }
  });

  it('update-models.js pins every blob of a registry manifest, with its kind and size', () => {
    assert.deepStrictEqual(pin.blobs.map((b) => [b.kind, b.digest, b.size]), [
      ['config', digest(blobs.config), blobs.config.length],
      ['model', digest(blobs.model), blobs.model.length],
      ['template', digest(blobs.template), blobs.template.length],
      ['license', digest(blobs.license), blobs.license.length],
    ]);
    assert.strictEqual(pin.manifest, digest(registryManifest));
  });

  it('a saved manifest whose bytes differ from the registry\'s, with the right blobs, passes', async () => {
    const dir = modelsFolder();
    try {
      const saved = fs.readFileSync(path.join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder', '3b'));
      assert.notStrictEqual(digest(saved), pin.manifest);
      assert.strictEqual(await verifyFiles(dir, 'qwen2.5-coder:3b', pin), Object.values(blobs).reduce((n, b) => n + b.length, 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a wrong layer digest fails, naming the model and the expected and actual digests', async () => {
    const other = Buffer.from('other weights');
    const wrong = { mediaType: 'application/vnd.ollama.image.model', digest: digest(other), size: other.length };
    await rejectsWith(modelsFolder({ layers: [wrong, layer('template'), layer('license')] }), new RegExp(
      `^The blobs of qwen2\\.5-coder:3b in the models folder do not match pins/models\\.json, so Docturnal does not run it\\. ` +
      `Expected ${expectedList}; actual ${[digest(blobs.config), digest(other), digest(blobs.template), digest(blobs.license)].sort().join(', ')}\\. ` +
      `Missing: ${digest(blobs.model)}\\. Not pinned: ${digest(other)}\\.$`,
    ));
  });

  it('a missing layer fails, naming what is missing', async () => {
    await rejectsWith(modelsFolder({ layers: [layer('model'), layer('template')] }), new RegExp(
      `Expected ${expectedList}; actual ${[digest(blobs.config), digest(blobs.model), digest(blobs.template)].sort().join(', ')}\\. Missing: ${digest(blobs.license)}\\.$`,
    ));
  });

  it('an extra layer fails, naming what is not pinned', async () => {
    const adapter = Buffer.from('an adapter');
    const extra = { mediaType: 'application/vnd.ollama.image.adapter', digest: digest(adapter), size: adapter.length };
    await rejectsWith(modelsFolder({ layers: [layer('model'), layer('template'), layer('license'), extra] }), new RegExp(
      `Expected ${expectedList}; actual ${[...Object.values(blobs).map(digest), digest(adapter)].sort().join(', ')}\\. Not pinned: ${digest(adapter)}\\.$`,
    ));
  });

  it('a tampered blob, as a poisoned cache would have, fails with the expected and actual digests', async () => {
    const tampered = Buffer.from('tampered weights');
    await rejectsWith(modelsFolder({ write: { ...blobs, model: tampered } }), new RegExp(
      `^The model file of qwen2\\.5-coder:3b does not match its digest, so Docturnal does not run it\\. Expected ${digest(blobs.model)}, got ${digest(tampered)}\\.$`,
    ));
  });

  it('a missing blob file fails, naming the expected digest', async () => {
    const { license, ...rest } = blobs;
    await rejectsWith(modelsFolder({ write: rest }), new RegExp(`^The license file of qwen2\\.5-coder:3b is missing from the models folder, so Docturnal does not run it\\. Expected ${digest(license)}\\.$`));
  });

  it('a pulled model is checked through the server and the models folder, and one not pulled, or not pinned, fails', async () => {
    const dir = modelsFolder();
    const mock = await startMockOllama(undefined, { models: [{ name: 'qwen2.5-coder:3b', digest: 'anything: the saved manifest\'s hash is not checked' }] });
    const logs = [];
    try {
      await verifyModels({ host: mock.host, models: ['qwen2.5-coder:3b'], modelsDir: dir, pins: { 'qwen2.5-coder:3b': pin }, log: (l) => logs.push(l) });
      assert.deepStrictEqual(logs, [`Model verified: qwen2.5-coder:3b, 4 files (0.0 GB), weights ${digest(blobs.model).slice(7, 19)}.`]);
      await assert.rejects(verifyModels({ host: mock.host, models: ['qwen2.5-coder:7b'], modelsDir: dir, pins: { 'qwen2.5-coder:7b': pin }, log: () => {} }), /qwen2\.5-coder:7b is not on the Ollama server after the pull\./);
      await assert.rejects(verifyModels({ host: mock.host, models: ['other:1b'], modelsDir: dir, pins: {}, log: () => {} }), /other:1b has no pinned blobs in pins\/models\.json, so Docturnal does not run it\./);
      await assert.rejects(verifyModels({ host: mock.host, models: ['qwen2.5-coder:3b'], pins: { 'qwen2.5-coder:3b': pin }, log: () => {} }), /OLLAMA_MODELS is not set/);
    } finally {
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
