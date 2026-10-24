'use strict';

// Docturnal for teams, without the app: after the Action pushes docturnal/update, it opens the
// pull request itself, or updates the open one. Used only when open-pr is "true"; in the
// default mode the GitHub App opens the pull request and the Action never calls this API.

const fs = require('fs');
const path = require('path');

const { LAST_RUN_PATH } = require('./state');

const UPDATE_PR_TITLE = 'Docturnal: comments and documentation';
// GitHub limits a pull request body to 65,536 characters.
const MAX_BODY = 64000;
const FALLBACK_BODY = 'Docturnal added comments to your code and updated your documentation. Review the changes, then merge this pull request to keep them.';
// The API version the app uses on GitHub.com. GitHub Enterprise Server gets its default.
const GITHUB_COM_API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

class PullRequestError extends Error {}

// The pull request body: last-run.md, with no settings link, since there is no app.
function pullRequestBody(root) {
  let body;
  try {
    body = fs.readFileSync(path.join(root, LAST_RUN_PATH), 'utf8');
  } catch {
    body = '';
  }
  if (!body.trim()) return FALLBACK_BODY;
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\nThe rest of this description is in \`${LAST_RUN_PATH}\`.`;
  return body;
}

// A one-line explanation of a refused request, naming the setting to change.
function refusal(status, message, repository) {
  if (status === 403 && /not permitted to create or approve pull requests/i.test(message)) {
    const owner = repository.split('/')[0];
    return `Docturnal pushed docturnal/update, but GitHub Actions is not allowed to create pull requests in ${repository}. ` +
      `Turn on "Allow GitHub Actions to create and approve pull requests" in the repository's Settings > Actions > General > Workflow permissions; ` +
      `if it is greyed out, turn it on first in the ${owner} organization's Settings > Actions > General.`;
  }
  if (status === 403 && /resource not accessible by integration/i.test(message)) {
    return `Docturnal pushed docturnal/update, but the token cannot open pull requests in ${repository}. ` +
      'Add "pull-requests: write" to the permissions in the workflow file.';
  }
  return `Docturnal pushed docturnal/update, but GitHub refused the pull request request with ${status}: ${message}`;
}

// Opens the pull request from docturnal/update into base, or updates the open one's body.
// env supplies GITHUB_API_URL and GITHUB_REPOSITORY, as on any runner, including GitHub
// Enterprise Server. Returns { number, action: 'opened' | 'updated' }.
async function openOrUpdatePullRequest({ root, base, token, env = process.env, fetchFn = fetch }) {
  const api = (env.GITHUB_API_URL || GITHUB_COM_API).replace(/\/+$/, '');
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) throw new PullRequestError('GITHUB_REPOSITORY is not set, so Docturnal cannot open the pull request.');
  if (!token) throw new PullRequestError('github-token is empty, so Docturnal cannot open the pull request.');
  const owner = repository.split('/')[0];
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'docturnal-action',
    ...(api === GITHUB_COM_API ? { 'x-github-api-version': API_VERSION } : {}),
  };
  const call = async (method, route, body) => {
    const res = await fetchFn(`${api}/repos/${repository}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; the status says enough.
    }
    if (!res.ok) throw new PullRequestError(refusal(res.status, (data && data.message) || text.slice(0, 200), repository));
    return data;
  };

  const body = pullRequestBody(root);
  const open = await call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:docturnal/update`)}`);
  if (Array.isArray(open) && open.length) {
    await call('PATCH', `/pulls/${open[0].number}`, { body });
    return { number: open[0].number, action: 'updated' };
  }
  const created = await call('POST', '/pulls', { title: UPDATE_PR_TITLE, head: 'docturnal/update', base, body });
  return { number: created.number, action: 'opened' };
}

module.exports = { PullRequestError, UPDATE_PR_TITLE, openOrUpdatePullRequest, pullRequestBody, refusal };
