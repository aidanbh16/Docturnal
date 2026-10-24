'use strict';

// A stand-in for the GitHub REST API calls the Action makes with open-pr: listing, opening,
// and updating pull requests.
//
// In tests: startMockGitHubApi({ prefix, refuse }) and pass `url` as GITHUB_API_URL.
//   prefix: a path before /repos, such as /api/v3 on GitHub Enterprise Server.
//   refuse: 'actions' answers like a repository where GitHub Actions may not create pull
//   requests; 'permissions' like a token without pull-requests write.
// As a server for test/e2e.sh:
//   node test/mock-github-api.js --serve --port-file FILE --state-file FILE
// The state file holds the requests and pull requests as JSON, rewritten after each request.

const fs = require('fs');
const http = require('http');

async function startMockGitHubApi({ prefix = '', refuse = null, port = 0, onChange } = {}) {
  const state = { requests: [], pulls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, body, headers: req.headers });
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        if (onChange) onChange(state);
      };
      if (req.headers.authorization !== 'Bearer test-token') return json(401, { message: 'Bad credentials' });
      const match = url.pathname.match(new RegExp(`^${prefix}/repos/([^/]+)/([^/]+)/pulls(?:/(\\d+))?$`));
      if (!match) return json(404, { message: 'Not Found' });
      const repo = `${match[1]}/${match[2]}`;
      if (req.method === 'GET' && !match[3]) {
        const head = url.searchParams.get('head');
        return json(200, state.pulls.filter((p) => p.repo === repo && p.state === url.searchParams.get('state') && `${match[1]}:${p.head}` === head));
      }
      if (req.method === 'POST' && !match[3]) {
        if (refuse === 'actions') return json(403, { message: 'GitHub Actions is not permitted to create or approve pull requests.' });
        if (refuse === 'permissions') return json(403, { message: 'Resource not accessible by integration' });
        const pull = { repo, number: state.pulls.length + 1, state: 'open', title: body.title, head: body.head, base: body.base, body: body.body };
        state.pulls.push(pull);
        return json(201, pull);
      }
      if (req.method === 'PATCH' && match[3]) {
        const pull = state.pulls.find((p) => p.repo === repo && p.number === Number(match[3]));
        if (!pull) return json(404, { message: 'Not Found' });
        Object.assign(pull, body);
        return json(200, pull);
      }
      return json(404, { message: 'Not Found' });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    port: server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (require.main === module && process.argv.includes('--serve')) {
  const stateFile = argValue('--state-file');
  const write = (state) => {
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ requests: state.requests.map(({ headers, ...r }) => r), pulls: state.pulls }, null, 2));
  };
  startMockGitHubApi({ onChange: write }).then((mock) => {
    write(mock.state);
    const portFile = argValue('--port-file');
    if (portFile) fs.writeFileSync(portFile, String(mock.port));
    console.log(`Mock GitHub API listening on ${mock.url}`);
  });
}

module.exports = { startMockGitHubApi };
