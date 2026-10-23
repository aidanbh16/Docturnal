// The GitHub REST API version the app uses. It lives outside index.ts because Workers treat
// every named export of the entry module as an entrypoint, and a string there stops the
// Worker from starting.

import type { Octokit } from '@octokit/core';

// Without a version header, GitHub uses 2022-11-28, which closes down on 10 March 2028 and
// answers with Deprecation and Sunset headers. The only 2026-03-10 change to an endpoint the
// app uses is that a workflow dispatch answers 200 with the run details instead of 204, and
// the app reads neither.
export const GITHUB_API_VERSION = '2026-03-10';

// An Octokit plugin that names the version on every request.
export function withApiVersion(octokit: Octokit) {
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION;
  });
}
