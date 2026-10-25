'use strict';

// Git operations for the Action. Docturnal only ever pushes to docturnal/update and never
// calls the pull requests API; the GitHub App opens the pull request.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Makes sure a commit is here, fetching the branch it came from when it is not.
function ensureCommit(cwd, sha, branchName) {
  if (tryGit(cwd, ['cat-file', '-e', `${sha}^{commit}`]).ok) return;
  git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
}

// Puts the working tree on the update branch.
// - If origin/docturnal/update exists, check it out and merge the base branch into it.
// - If that merge conflicts, or the branch does not exist, start fresh from the base.
// The jobs of a parallel run pass the commits the plan saw (baseSha, and updateSha, which is
// null when there was no update branch), so every job builds the same tree.
// Returns { base, baseSha, updateSha, mode: 'existing' | 'fresh' | 'new', unmerged }, where
// unmerged counts the update branch's commits that the base does not have: more than 0
// means its pull request is still open.
function prepareBranch(cwd, { base, branch = UPDATE_BRANCH, baseSha: wantedBase, updateSha: wantedUpdate } = {}) {
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
  if (wantedBase) {
    ensureCommit(cwd, wantedBase, baseName);
    baseSha = wantedBase;
  } else if (checkedOut === baseName) {
    baseSha = git(cwd, ['rev-parse', 'HEAD']);
  } else {
    git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`]);
    baseSha = git(cwd, ['rev-parse', `refs/remotes/origin/${baseName}`]);
  }

  let updateSha = null;
  if (wantedUpdate !== undefined) {
    updateSha = wantedUpdate;
    if (updateSha) ensureCommit(cwd, updateSha, branch);
  } else if (remoteBranchExists(cwd, branch)) {
    git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    updateSha = git(cwd, ['rev-parse', `refs/remotes/origin/${branch}`]);
  }
  if (!updateSha) {
    git(cwd, ['checkout', '--quiet', '-B', branch, baseSha]);
    return { base: baseName, baseSha, updateSha: null, mode: 'new', unmerged: 0 };
  }
  const unmerged = Number(git(cwd, ['rev-list', '--count', `${baseSha}..${updateSha}`]));
  git(cwd, ['checkout', '--quiet', '-B', branch, updateSha]);
  const merge = tryGit(cwd, ['merge', '--quiet', '--no-edit', '-m', `Merge ${baseName} into ${branch}`, baseSha], { asBot: true });
  if (merge.ok) {
    // After a squash or rebase merge, the commits are not in the base but their changes are.
    const differs = !tryGit(cwd, ['diff', '--quiet', baseSha, 'HEAD']).ok;
    return { base: baseName, baseSha, updateSha, mode: 'existing', unmerged: differs ? unmerged : 0 };
  }
  tryGit(cwd, ['merge', '--abort']);
  git(cwd, ['checkout', '--quiet', '--force', '-B', branch, baseSha]);
  return { base: baseName, baseSha, updateSha, mode: 'fresh', unmerged: 0 };
}

// The paths in .docturnalignore, at the repository root, are never commented or documented.
const IGNORE_FILE = '.docturnalignore';

// The tracked files, without the ones .docturnalignore matches. git reads the patterns, so
// they work exactly like .gitignore patterns.
function listFiles(cwd) {
  // Regular files only: symlinks (mode 120000) and submodules (160000) are left out by their
  // mode in the index, since a checkout may turn a symlink into a plain file.
  const files = git(cwd, ['ls-files', '-z', '--stage']).split('\0').filter(Boolean)
    .map((line) => /^(\d+) [0-9a-f]+ \d+\t(.*)$/s.exec(line))
    .filter((m) => m && m[1] !== '120000' && m[1] !== '160000')
    .map((m) => m[2]);
  const ignoreFile = path.join(cwd, IGNORE_FILE);
  if (!fs.existsSync(ignoreFile)) return files;
  const ignored = new Set(git(cwd, ['ls-files', '-z', '--cached', '--ignored', `--exclude-from=${ignoreFile}`]).split('\0').filter(Boolean));
  return files.filter((file) => !ignored.has(file));
}

// Stages only the given paths, commits, and force-pushes when `push` is true. With `lease`
// (the commit the branch held when the run started, or null when it did not exist), the push
// replaces the branch only if it still holds that, so a commit a person added during the run,
// or a branch deleted with its closed pull request, is never overwritten.
// Returns { committed, pushed, sha, rejected }.
function commitAndPush(cwd, { paths, message, push = true, branch = UPDATE_BRANCH, lease }) {
  if (!paths.length) return { committed: false, pushed: false, sha: null };
  // -f so that a .gitignore entry cannot keep Docturnal's own files out of the commit.
  git(cwd, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
  if (tryGit(cwd, ['diff', '--cached', '--quiet']).ok) return { committed: false, pushed: false, sha: null };
  git(cwd, ['commit', '--quiet', '-m', message], { asBot: true });
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  if (!push) return { committed: true, pushed: false, sha };
  if (lease === undefined) {
    git(cwd, ['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    return { committed: true, pushed: true, sha };
  }
  const result = tryGit(cwd, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${lease || ''}`, 'origin', `HEAD:refs/heads/${branch}`]);
  if (result.ok) return { committed: true, pushed: true, sha };
  if (!/stale info|rejected/.test(result.error)) throw new Error(`git push failed: ${result.error}`);
  return { committed: true, pushed: false, sha, rejected: true };
}

// Whether a commit has reached the base branch on the remote since it was fetched, for
// example because its pull request was merged while a run was going.
function mergedSince(cwd, sha, baseName) {
  if (!tryGit(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`]).ok) return false;
  return tryGit(cwd, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${baseName}`]).ok;
}

// How many commits touched each file in the last `days` days: recent change activity.
function recentActivity(cwd, days = 90) {
  const counts = new Map();
  // -z keeps paths with spaces or non-ASCII characters exactly as ls-files gives them.
  const result = tryGit(cwd, ['-c', 'core.quotePath=false', 'log', '-z', `--since=${days} days ago`, '--name-only', '--format=']);
  if (!result.ok) return counts;
  for (const file of result.out.split('\0').map((l) => l.replace(/^\n+/, '')).filter(Boolean)) counts.set(file, (counts.get(file) || 0) + 1);
  return counts;
}

module.exports = { BOT_EMAIL, BOT_NAME, IGNORE_FILE, UPDATE_BRANCH, commitAndPush, listFiles, mergedSince, prepareBranch, recentActivity };
