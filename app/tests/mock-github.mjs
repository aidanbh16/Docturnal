// An in-memory stand-in for the GitHub REST API calls the app makes.
//
// In tests: const gh = createMockGitHub(); pass gh.fetch to the handler, then inspect gh.state.
// As a server for `wrangler dev`:
//   node tests/mock-github.mjs --serve --port 8788
// Each request is printed as one line, so you can see what the Worker did.

import http from 'node:http';

export function createMockGitHub({
  repos = ['octo/hello'],
  defaultBranch = 'main',
  protectedBranches = [],
  files = {},
  dispatchNotFound = 0,
  failPulls = false,
  failPuts = 0,
  // Workflow runs that have not finished: [{ repo, status }], status in_progress, queued, or pending.
  runs = [],
  // codes: OAuth code -> user token, each usable once like GitHub's; installations: user
  // token -> installations it can access; clientSecret: when set, the only accepted secret;
  // authorizeAs: the user token that the authorize page issues new codes for.
  oauth = { codes: {}, installations: {} },
} = {}) {
  const state = {
    repos: new Map(),
    calls: [],
    dispatches: [],
    pulls: [],
    nextPull: 1,
    runs: [...runs],
    // The X-GitHub-Api-Version header of each REST call, or null when it had none.
    apiVersions: [],
  };
  for (const fullName of repos) {
    state.repos.set(fullName, {
      defaultBranch,
      protected: new Set(protectedBranches),
      branches: new Map([[defaultBranch, 'sha-base']]),
      files: new Map(Object.entries(files)),
    });
  }
  let notFoundLeft = dispatchNotFound;
  let putFailuresLeft = failPuts;

  // Like GitHub, answers a request on the closing-down 2022-11-28 version (the default
  // without the header) with Deprecation and Sunset headers, which Octokit turns into a warning.
  let currentVersion = null;
  const json = (status, body) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(currentVersion === '2026-03-10' ? {} : { deprecation: '@1773100800', sunset: 'Fri, 10 Mar 2028 00:00:00 GMT' }),
      },
    });
  const fileKey = (branch, path) => `${branch}:${path}`;

  async function handle(method, url, body, headers = {}) {
    const { pathname, searchParams } = new URL(url);
    state.calls.push(`${method} ${pathname}`);
    currentVersion = headers['x-github-api-version'] ?? null;
    if (!pathname.startsWith('/login/')) state.apiVersions.push(currentVersion);

    if (method === 'POST' && pathname === '/login/oauth/access_token') {
      state.codeExchanges = (state.codeExchanges ?? 0) + 1;
      if (!body.client_id || !body.client_secret || (oauth.clientSecret && body.client_secret !== oauth.clientSecret)) {
        return json(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
      }
      const token = oauth.codes[body.code];
      // GitHub answers 200 with an error for a wrong, used, or expired code.
      if (!token) return json(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
      delete oauth.codes[body.code];
      return json(200, { access_token: token, token_type: 'bearer' });
    }
    // A user who already approved the app: GitHub sends them straight back with a new code.
    if (method === 'GET' && pathname === '/login/oauth/authorize' && oauth.authorizeAs) {
      const code = `code-${(state.issuedCodes = (state.issuedCodes ?? 0) + 1)}`;
      oauth.codes[code] = oauth.authorizeAs;
      const back = new URL(searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      if (searchParams.get('state')) back.searchParams.set('state', searchParams.get('state'));
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (method === 'GET' && pathname === '/user/installations') {
      const token = String(headers.authorization || '').replace(/^Bearer /, '');
      const installations = oauth.installations[token];
      if (!installations) return json(401, { message: 'Bad credentials' });
      return json(200, { total_count: installations.length, installations });
    }

    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(pathname)) {
      return json(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: 'selected' });
    }

    const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!match) return json(404, { message: 'Not Found' });
    const fullName = `${match[1]}/${match[2]}`;
    // Octokit encodes slashes inside parameters (heads%2Fmain), as GitHub accepts.
    const rest = decodeURIComponent(match[3] || '');
    const repo = state.repos.get(fullName);
    if (!repo) return json(404, { message: 'Not Found' });

    if (method === 'GET' && rest === '') {
      return json(200, { full_name: fullName, name: match[2], owner: { login: match[1] }, default_branch: repo.defaultBranch });
    }

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const path = contents[1];
      if (method === 'GET') {
        const branch = searchParams.get('ref') || repo.defaultBranch;
        const content = repo.files.get(fileKey(branch, path));
        if (content === undefined) return json(404, { message: 'Not Found' });
        return json(200, { type: 'file', path, sha: 'sha-file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      if (method === 'PUT') {
        if (putFailuresLeft > 0) {
          putFailuresLeft--;
          return json(502, { message: 'Server Error' });
        }
        const branch = body.branch || repo.defaultBranch;
        if (repo.protected.has(branch)) {
          return json(409, { message: 'Repository rule violations found\n\nChanges must be made through a pull request.' });
        }
        if (!repo.branches.has(branch)) return json(404, { message: 'Branch not found' });
        if (repo.files.has(fileKey(branch, path)) && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
        repo.files.set(fileKey(branch, path), Buffer.from(body.content, 'base64').toString('utf8'));
        return json(201, { content: { path, sha: 'sha-new' }, commit: { sha: 'sha-commit', message: body.message } });
      }
    }

    const ref = rest.match(/^\/git\/ref\/heads\/(.+)$/);
    if (method === 'GET' && ref) {
      const branch = ref[1];
      if (!repo.branches.has(branch)) return json(404, { message: 'Not Found' });
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: repo.branches.get(branch), type: 'commit' } });
    }
    const resetRef = rest.match(/^\/git\/refs\/heads\/(.+)$/);
    if (method === 'PATCH' && resetRef) {
      const branch = resetRef[1];
      if (!repo.branches.has(branch)) return json(422, { message: 'Reference does not exist' });
      if (!body.force) return json(422, { message: 'Update is not a fast forward' });
      // Moving the branch to the default branch's commit gives it the default branch's files.
      repo.branches.set(branch, body.sha);
      for (const key of [...repo.files.keys()]) if (key.startsWith(`${branch}:`)) repo.files.delete(key);
      for (const [key, value] of [...repo.files]) {
        const [fromBranch, ...pathParts] = key.split(':');
        if (fromBranch === repo.defaultBranch) repo.files.set(fileKey(branch, pathParts.join(':')), value);
      }
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const branch = body.ref.replace(/^refs\/heads\//, '');
      if (repo.branches.has(branch)) return json(422, { message: 'Reference already exists' });
      repo.branches.set(branch, body.sha);
      for (const [key, value] of [...repo.files]) {
        const [fromBranch, ...pathParts] = key.split(':');
        if (fromBranch === repo.defaultBranch) repo.files.set(fileKey(branch, pathParts.join(':')), value);
      }
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }

    const dispatch = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/);
    if (method === 'POST' && dispatch) {
      if (notFoundLeft > 0) {
        notFoundLeft--;
        return json(404, { message: 'Not Found' });
      }
      const workflow = repo.files.get(fileKey(body.ref, `.github/workflows/${dispatch[1]}`));
      if (workflow === undefined) return json(404, { message: 'Not Found' });
      const inputs = body.inputs || {};
      if (Object.keys(inputs).length && !/workflow_dispatch:\s*\n\s+inputs:/.test(workflow)) {
        return json(422, { message: `Unexpected inputs provided: ${JSON.stringify(Object.keys(inputs))}` });
      }
      state.dispatches.push({ repo: fullName, workflow: dispatch[1], ref: body.ref, inputs });
      // Version 2026-03-10 answers 200 with the run details; 2022-11-28 answers 204.
      if (currentVersion !== '2026-03-10') return json(204);
      const id = 1000 + state.dispatches.length;
      return json(200, { workflow_run_id: id, run_url: `https://api.github.com/repos/${fullName}/actions/runs/${id}`, html_url: `https://github.com/${fullName}/actions/runs/${id}` });
    }

    const runsList = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/);
    if (method === 'GET' && runsList) {
      const status = searchParams.get('status');
      const found = state.runs.filter((r) => r.repo === fullName && (!status || r.status === status));
      return json(200, { total_count: found.length, workflow_runs: found.map((r, i) => ({ id: i + 1, status: r.status })) });
    }

    if (rest === '/pulls' && method === 'GET') {
      const head = searchParams.get('head');
      const wanted = searchParams.get('state') || 'open';
      return json(200, state.pulls.filter((p) => p.repo === fullName && (wanted === 'all' || p.state === wanted) && (!head || `${match[1]}:${p.head}` === head)));
    }
    if (rest === '/pulls' && method === 'POST') {
      if (failPulls) return json(502, { message: 'Server Error' });
      const pr = { repo: fullName, number: state.nextPull++, state: 'open', title: body.title, head: body.head, base: body.base, body: body.body };
      state.pulls.push(pr);
      return json(201, { ...pr, html_url: `https://github.com/${fullName}/pull/${pr.number}` });
    }
    const pull = rest.match(/^\/pulls\/(\d+)$/);
    if (pull && method === 'PATCH') {
      const pr = state.pulls.find((p) => p.repo === fullName && p.number === Number(pull[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      Object.assign(pr, body.body === undefined ? {} : { body: body.body });
      return json(200, pr);
    }

    return json(404, { message: `Mock has no route for ${method} ${pathname}` });
  }

  async function mockFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return handle(method, url, body, headers);
  }

  return { fetch: mockFetch, state, handle };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv.includes('--serve')) {
  const port = Number(argValue('--port', '8788'));
  const gh = createMockGitHub({ repos: (argValue('--repos', 'octo/hello')).split(',') });
  http
    .createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const response = await gh.handle(req.method, `http://localhost${req.url}`, raw ? JSON.parse(raw) : {}, req.headers);
        const text = await response.text();
        console.log(`${req.method} ${req.url} -> ${response.status}`);
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(text);
      });
    })
    .listen(port, '127.0.0.1', () => console.log(`Mock GitHub API listening on http://127.0.0.1:${port}`));
}
