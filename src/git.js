'use strict';

// Git operations for the Action. Docturnal only ever pushes to docturnal/update and never
// calls the pull requests API; the GitHub App opens the pull request.

const { execFileSync } = require('child_process');

const UPDATE_BRANCH = 'docturnal/update';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

// Commits and merges always use the bot identity, even when GIT_AUTHOR_* is set in the environment.
const BOT_ENV = {
  GIT_AUTHOR_NAME: BOT_NAME,
  GIT_AUTHOR_EMAIL: BOT_EMAIL,
  GIT_COMMITTER_NAME: BOT_NAME,
  GIT_COMMITTER_EMAIL: BOT_EMAIL,
};

function git(cwd, args, { input, asBot = false } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    env: asBot ? { ...process.env, ...BOT_ENV } : process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  }).trimEnd();
}

function tryGit(cwd, args, options) {
  try {
    return { ok: true, out: git(cwd, args, options) };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).trim() };
  }
}

function currentBranch(cwd) {
  const result = tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return result.ok ? result.out : '';
}

function remoteBranchExists(cwd, branch) {
  return tryGit(cwd, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).ok;
}

// Puts the working tree on the update branch.
// - If origin/docturnal/update exists, check it out and merge the base branch into it.
// - If that merge conflicts, or the branch does not exist, start fresh from the base.
// Returns { base, baseSha, mode: 'existing' | 'fresh' | 'new' }.
function prepareBranch(cwd, { base, branch = UPDATE_BRANCH } = {}) {
  git(cwd, ['config', 'user.name', BOT_NAME]);
  git(cwd, ['config', 'user.email', BOT_EMAIL]);

  const checkedOut = currentBranch(cwd);
  const baseName = base || checkedOut || process.env.GITHUB_REF_NAME;
  if (!baseName) throw new Error('Cannot tell which branch is the base branch. Set BASE_BRANCH.');
  if (baseName === branch) throw new Error(`The base branch cannot be ${branch}.`);

  // Merging needs history, and actions/checkout fetches only one commit by default.
  if (git(cwd, ['rev-parse', '--is-shallow-repository']) === 'true') {
    git(cwd, ['fetch', '--quiet', '--unshallow', '--no-tags', 'origin']);
  }
  let baseSha;
  if (checkedOut === baseName) {
    baseSha = git(cwd, ['rev-parse', 'HEAD']);
  } else {
    git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`]);
    baseSha = git(cwd, ['rev-parse', `refs/remotes/origin/${baseName}`]);
  }

  if (!remoteBranchExists(cwd, branch)) {
    git(cwd, ['checkout', '--quiet', '-B', branch, baseSha]);
    return { base: baseName, baseSha, mode: 'new' };
  }
  git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  git(cwd, ['checkout', '--quiet', '-B', branch, `refs/remotes/origin/${branch}`]);
  const merge = tryGit(cwd, ['merge', '--quiet', '--no-edit', '-m', `Merge ${baseName} into ${branch}`, baseSha], { asBot: true });
  if (merge.ok) return { base: baseName, baseSha, mode: 'existing' };
  tryGit(cwd, ['merge', '--abort']);
  git(cwd, ['checkout', '--quiet', '--force', '-B', branch, baseSha]);
  return { base: baseName, baseSha, mode: 'fresh' };
}

function listFiles(cwd) {
  return git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
}

// Stages only the given paths, commits, and force-pushes when `push` is true.
// Returns { committed, pushed, sha }.
function commitAndPush(cwd, { paths, message, push = true, branch = UPDATE_BRANCH }) {
  if (!paths.length) return { committed: false, pushed: false, sha: null };
  // -f so that a .gitignore entry cannot keep Docturnal's own files out of the commit.
  git(cwd, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
  if (tryGit(cwd, ['diff', '--cached', '--quiet']).ok) return { committed: false, pushed: false, sha: null };
  git(cwd, ['commit', '--quiet', '-m', message], { asBot: true });
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  if (push) git(cwd, ['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
  return { committed: true, pushed: push, sha };
}

module.exports = { BOT_EMAIL, BOT_NAME, UPDATE_BRANCH, commitAndPush, listFiles, prepareBranch };
