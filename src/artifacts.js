'use strict';

// Deletes the artifacts of a parallel run once its finish job is done. They hold the plan and
// the workers' results, which include changed source files, so they are removed rather than
// left for their one-day retention. Needs the workflow's actions: write permission.

const GITHUB_COM_API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

// Returns the number of artifacts deleted. Never throws: a failure is a warning, since the
// artifacts expire after one day anyway.
async function deleteRunArtifacts({ env = process.env, token, fetchFn = fetch, log = console.log, prefix = 'docturnal-' }) {
  const api = (env.GITHUB_API_URL || GITHUB_COM_API).replace(/\/+$/, '');
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!repository || !runId || !token) {
    log("::warning::Docturnal could not delete this run's artifacts: the repository, run, or token is unknown. They expire after one day.");
    return 0;
  }
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'docturnal-action',
    ...(api === GITHUB_COM_API ? { 'x-github-api-version': API_VERSION } : {}),
  };
  try {
    const list = await fetchFn(`${api}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, { headers });
    if (!list.ok) throw new Error(`listing them returned ${list.status}`);
    const { artifacts = [] } = await list.json();
    let deleted = 0;
    for (const artifact of artifacts.filter((a) => typeof a.name === 'string' && a.name.startsWith(prefix))) {
      const res = await fetchFn(`${api}/repos/${repository}/actions/artifacts/${artifact.id}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw new Error(`deleting ${artifact.name} returned ${res.status}`);
      deleted++;
    }
    log(`Docturnal: deleted ${deleted} artifact${deleted === 1 ? '' : 's'} of this run`);
    return deleted;
  } catch (err) {
    log(`::warning::Docturnal could not delete this run's artifacts (${err.message}). They expire after one day. Give the workflow "actions: write" permission so they are deleted at once.`);
    return 0;
  }
}

if (require.main === module) {
  deleteRunArtifacts({ token: process.env.INPUT_GITHUB_TOKEN });
}

module.exports = { deleteRunArtifacts };
