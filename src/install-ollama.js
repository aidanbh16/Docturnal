'use strict';

// Installs the Ollama release that action.yml pins, with no install script, system service,
// or sudo: it downloads the official archive for the runner's architecture from GitHub
// releases, checks its SHA-256 against pins/ollama.json before extracting anything, and
// extracts the binary and the CPU libraries into a folder of the runner's user.
//
//   node src/install-ollama.js key      prints the cache key part: <version>-<sha256>
//   node src/install-ollama.js install  installs into OLLAMA_DIR, or uses a verified cache

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { own } = require('./own');

const PINS_PATH = path.join(__dirname, '..', 'pins', 'ollama.json');
const RELEASES = 'https://github.com/ollama/ollama/releases/download';
const ARCHITECTURES = { x64: 'amd64', arm64: 'arm64' };
// Written next to the install once its archive matched. It only says which archive the
// install came from: an install is trusted only after every file matches pins/ollama.json.
const MARKER = '.docturnal-sha256';
// GPU libraries are most of the archive, and a CPU runner never loads them.
const EXCLUDE = ['lib/ollama/cuda_*', 'lib/ollama/rocm*', 'lib/ollama/vulkan*'];

class InstallError extends Error {}

function readPins(file = PINS_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The pinned archive for a version and a Node.js architecture name.
function pinnedArchive(version, arch, pins = readPins()) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new InstallError(`The Ollama version in action.yml is not a release number: "${version}".`);
  const release = pins[version];
  if (!release) {
    throw new InstallError(`pins/ollama.json has no checksums for Ollama ${version}. Run scripts/update-ollama.sh ${version} and commit the result.`);
  }
  const name = ARCHITECTURES[arch];
  if (!name || !release[name]) throw new InstallError(`Docturnal installs Ollama only on Linux x64 and arm64 runners, not ${arch}.`);
  const { file, sha256, files = {}, links = {} } = release[name];
  if (!/^[\w.-]+$/.test(file) || !/^[0-9a-f]{64}$/.test(sha256)) throw new InstallError(`pins/ollama.json has a malformed entry for Ollama ${version} on ${name}.`);
  if (!files['bin/ollama']) throw new InstallError(`pins/ollama.json has no file hashes for Ollama ${version} on ${name}. Run scripts/update-ollama.sh ${version} and commit the result.`);
  return { version, file, sha256, files, links, url: `${RELEASES}/v${version}/${file}` };
}

// Streams the archive to a file and returns its SHA-256, so it is read only once.
async function download(url, destination, fetchFn = fetch) {
  const response = await fetchFn(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new InstallError(`Could not download ${url}: HTTP ${response.status}.`);
  const hash = crypto.createHash('sha256');
  const hashing = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hashing, fs.createWriteStream(destination));
  return hash.digest('hex');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Checks an install against the pins: exactly the pinned files with their hashes, and the
// pinned links with their targets. Anything else, such as an extra library that Ollama would
// load, fails. Returns null when it matches, or what differs.
function checkInstall(dir, archive) {
  const seen = new Set();
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === MARKER) continue;
      const full = path.join(dir, name);
      if (entry.isSymbolicLink()) {
        // Checks if the symbolic link points to the correct file in the archive.
        if (own(archive.links, name) !== fs.readlinkSync(full)) return `${name} is not the pinned link`;
        seen.add(name);
      } else if (entry.isDirectory()) {
        const problem = walk(name);
        if (problem) return problem;
      } else if (entry.isFile()) {
        if (own(archive.files, name) !== sha256File(full)) return `${name} does not match its pinned hash`;
        seen.add(name);
      } else {
        return `${name} is not a file`;
      }
    }
    return null;
  };
  if (!fs.existsSync(dir)) return 'not installed';
  const problem = walk('');
  if (problem) return problem;
  const missing = [...Object.keys(archive.files), ...Object.keys(archive.links)].filter((name) => !seen.has(name));
  return missing.length ? `${missing[0]} is missing` : null;
}

function extractArchive(archive, destination) {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new InstallError('Installing Ollama needs zstd, which this runner does not have.');
  }
  const args = ['--zstd', '-xf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'];
  for (const pattern of EXCLUDE) args.push(`--exclude=${pattern}`);
  execFileSync('tar', args, { stdio: 'inherit' });
}

// Returns { bin, cached }. Throws InstallError when the archive does not match its checksum;
// nothing is extracted then.
async function installOllama({ version, arch = process.arch, dir, tmp, pins, fetchFn = fetch, extract = extractArchive, log = console.log }) {
  const archive = pinnedArchive(version, arch, pins);
  const bin = path.join(dir, 'bin');
  const marker = path.join(dir, MARKER);
  // A cached install is used only when every file matches the pins, so a tampered cache entry
  // is never run.
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === archive.sha256) {
    const problem = checkInstall(dir, archive);
    if (!problem) {
      log(`Using the cached Ollama ${version}; every file matches its pinned hash.`);
      return { bin, cached: true };
    }
    log(`The cached Ollama does not match its pins (${problem}), so it is installed again.`);
  }
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, archive.file);
  log(`Downloading Ollama ${version} (${archive.file}) from GitHub releases.`);
  let actual;
  try {
    actual = await download(archive.url, file, fetchFn);
    if (actual !== archive.sha256) {
      throw new InstallError(
        `The Ollama archive ${archive.file} does not match the checksum pinned in pins/ollama.json, so it was not installed. ` +
        `Expected SHA-256 ${archive.sha256}, got ${actual}.`,
      );
    }
    log(`Checksum verified: ${archive.sha256}.`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    extract(file, dir);
  } finally {
    fs.rmSync(file, { force: true });
  }
  const problem = checkInstall(dir, archive);
  if (problem) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new InstallError(`The extracted Ollama does not match pins/ollama.json (${problem}), so it was not installed.`);
  }
  fs.writeFileSync(marker, `${archive.sha256}\n`);
  log(`Installed Ollama ${version} in ${dir}.`);
  return { bin, cached: false };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const version = env.OLLAMA_VERSION;
  if (argv[0] === 'key') {
    const archive = pinnedArchive(version, process.arch);
    console.log(`${archive.version}-${archive.sha256}`);
    return;
  }
  if (argv[0] !== 'install') throw new InstallError('Usage: install-ollama.js key | install');
  const dir = env.OLLAMA_DIR;
  if (!dir) throw new InstallError('OLLAMA_DIR is not set.');
  const { bin } = await installOllama({ version, dir, tmp: env.RUNNER_TEMP || require('os').tmpdir() });
  if (env.GITHUB_PATH) fs.appendFileSync(env.GITHUB_PATH, `${bin}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::${err instanceof InstallError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { InstallError, checkInstall, installOllama, pinnedArchive, readPins };
