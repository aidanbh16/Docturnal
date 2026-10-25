'use strict';

// A scratch git remote with a seed clone, for tests that run the Action against real git.

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const ROOT = path.join(__dirname, '..');

function gitRepo({ branch = 'main' } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-repo-'));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(work, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  // Files keep their exact bytes, CRLF included, on every platform.
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(work, 'remote.git');
  const seed = path.join(work, 'seed');
  git(work, 'init', '-q', '--bare', '-b', branch, remote);
  git(work, 'clone', '-q', remote, seed);
  git(seed, 'checkout', '-q', '-b', branch);
  let clones = 0;
  const repo = {
    work,
    git,
    remote,
    seed,
    gitEnv,
    branch,
    commit(files, message = 'Change code') {
      for (const [file, text] of Object.entries(files)) {
        const full = path.join(seed, file);
        if (text === null) {
          fs.rmSync(full, { force: true });
          continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
      }
      git(seed, 'add', '-A');
      git(seed, 'commit', '-qm', message);
      git(seed, 'push', '-q', 'origin', branch);
    },
    merge() {
      git(seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'docturnal/update');
      git(seed, 'push', '-q', 'origin', branch);
    },
    clone() {
      const dir = path.join(work, `clone-${++clones}`);
      git(work, 'clone', '-q', remote, dir);
      return dir;
    },
    file(ref, file) {
      return execFileSync('git', ['show', `${ref}:${file}`], { cwd: remote, env: { ...gitEnv, MSYS2_ARG_CONV_EXCL: '*' } });
    },
    text(ref, file) {
      return repo.file(ref, file).toString('utf8');
    },
    hasBranch(name) {
      try {
        git(remote, 'rev-parse', '--verify', `refs/heads/${name}`);
        return true;
      } catch {
        return false;
      }
    },
    state() {
      return JSON.parse(repo.text('docturnal/update', '.docturnal/state.json'));
    },
    cleanup() {
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
  return repo;
}

// Runs src/main.js, or another script, in cwd with the mock Ollama server.
async function runAction(repo, cwd, mock, extra = {}, script = 'src/main.js') {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(ROOT, script)], {
      cwd,
      env: {
        ...repo.gitEnv,
        BASE_BRANCH: repo.branch,
        OLLAMA_HOST: mock ? mock.host : '127.0.0.1:1',
        INPUT_COMMENT_LEVEL: 'medium',
        INPUT_SELECTED_COMMENT_MODEL: 'comment-model',
        INPUT_SELECTED_DOCS_MODEL: 'docs-model',
        ...extra,
      },
    });
    return { code: 0, log: stdout, stderr };
  } catch (err) {
    return { code: err.code, log: err.stdout || '', stderr: err.stderr || '' };
  }
}

const fn = (name) => `export function ${name}(x) {\n  return x;\n}\n`;

module.exports = { fn, gitRepo, runAction };
