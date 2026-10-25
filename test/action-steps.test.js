'use strict';

// Which steps of action.yml run in each mode: the default (app) mode, a self-hosted runner,
// and an Ollama server of your own. Reads each step's `if:` and evaluates it the way GitHub
// Actions does, for the contexts each mode has.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ACTION = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

// The steps under runs.steps: { name, if, uses, env }.
function steps() {
  const out = [];
  const lines = ACTION.split('\n');
  let current = null;
  let inEnv = false;
  for (const line of lines.slice(lines.indexOf('  steps:') + 1)) {
    const start = line.match(/^ {4}- name: (.+)$/);
    if (start) {
      current = { name: start[1], env: {} };
      out.push(current);
      inEnv = false;
      continue;
    }
    if (!current) continue;
    const field = line.match(/^ {6}(if|uses|id): (.+)$/);
    if (field) current[field[1]] = field[2];
    if (/^ {6}env:$/.test(line)) inEnv = true;
    else if (/^ {6}\S/.test(line)) inEnv = false;
    const env = inEnv && line.match(/^ {8}([A-Z_]+): (.+)$/);
    if (env) current.env[env[1]] = env[2];
  }
  return out;
}

// A small evaluator for the expressions action.yml uses: context paths, 'strings', ==, !=,
// &&, ||, and parentheses. Missing values are '', as in GitHub Actions.
function evaluate(expression, context) {
  const tokens = expression.replace(/\balways\(\)/g, "'always'").match(/'[^']*'|==|!=|&&|\|\||\(|\)|[\w.-]+/g);
  let i = 0;
  const value = (token) => {
    if (token === "'always'") return true;
    if (token.startsWith("'")) return token.slice(1, -1);
    return token.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : ''), context);
  };
  const primary = () => {
    if (tokens[i] === '(') {
      i++;
      const v = or();
      i++;
      return v;
    }
    return value(tokens[i++]);
  };
  const comparison = () => {
    let left = primary();
    while (tokens[i] === '==' || tokens[i] === '!=') {
      const op = tokens[i++];
      const right = primary();
      left = op === '==' ? left === right : left !== right;
    }
    return left;
  };
  const and = () => {
    let left = comparison();
    while (tokens[i] === '&&') {
      i++;
      const right = comparison();
      left = left ? right : left;
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (tokens[i] === '||') {
      i++;
      const right = and();
      left = left || right;
    }
    return left;
  };
  return or();
}

// The steps that run in a mode, on a night with changes.
function running({ environment = 'github-hosted', ollamaUrl = '', version = '0.40.11', mode = 'all', hasWork = 'true', changed = 'true' } = {}) {
  const context = {
    steps: { precheck: { outputs: { changed } }, ollama: { outputs: { version } }, run: { outputs: { 'has-work': hasWork } } },
    inputs: { 'ollama-url': ollamaUrl, mode },
    runner: { environment },
  };
  return steps().filter((s) => !s.if || Boolean(evaluate(s.if, context)));
}

const names = (list) => list.map((s) => s.name);
const usesCache = (list) => list.filter((s) => (s.uses || '').startsWith('actions/cache'));

test('the default mode runs the same steps as before Docturnal for teams', () => {
  assert.deepStrictEqual(names(running()), [
    'Check for changes',
    'Select models',
    'Restore Ollama models cache',
    'Find the Ollama version',
    'Restore Ollama install cache',
    'Install Ollama',
    'Start Ollama',
    'Pull models',
    'Install dependencies',
    'Run Docturnal',
  ]);
  // A night with no changes runs only the check.
  const quiet = steps().filter((s) => !s.if || evaluate(s.if, { steps: { precheck: { outputs: { changed: 'false' } } }, inputs: { 'ollama-url': '' }, runner: { environment: 'github-hosted' } }));
  assert.deepStrictEqual(names(quiet), ['Check for changes']);
});

test('a self-hosted runner never uses actions/cache or the version check, but installs and starts Ollama itself', () => {
  const selfHosted = running({ environment: 'self-hosted', version: '' });
  assert.deepStrictEqual(usesCache(selfHosted), []);
  assert.deepStrictEqual(names(selfHosted), [
    'Check for changes', 'Select models', 'Install Ollama', 'Start Ollama', 'Pull models', 'Install dependencies', 'Run Docturnal',
  ]);
  assert.strictEqual(usesCache(running()).length, 2);
});

test('with ollama-url, nothing installs, starts, caches, or pulls Ollama on the runner, and the server is checked first', () => {
  for (const environment of ['github-hosted', 'self-hosted']) {
    assert.deepStrictEqual(names(running({ environment, ollamaUrl: 'http://ollama.internal:11434' })), [
      'Check for changes', 'Select models', 'Check the Ollama server', 'Install dependencies', 'Run Docturnal',
    ]);
  }
});

test('the run talks to ollama-url when it is set, and to the local server otherwise', () => {
  const run = steps().find((s) => s.name === 'Run Docturnal');
  const host = run.env.OLLAMA_HOST.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  assert.strictEqual(evaluate(host, { inputs: { 'ollama-url': 'http://ollama.internal:11434' }, steps: { 'ollama-server': { outputs: { host: '127.0.0.1:11434' } } } }), 'http://ollama.internal:11434');
  assert.strictEqual(evaluate(host, { inputs: { 'ollama-url': '' }, steps: { 'ollama-server': { outputs: { host: '127.0.0.1:11434' } } } }), '127.0.0.1:11434');
  // The local server's address: port 11434 on GitHub-hosted runners, as before.
  assert.match(ACTION, /if \[ "\$GITHUB_HOSTED" = "true" \]; then\n {10}export OLLAMA_HOST=127\.0\.0\.1:11434\n/);
  // The new inputs default to the app's behavior.
  for (const [input, value] of [['open-pr', "'false'"], ['ollama-url', "''"], ['allow-public-ollama', "'false'"], ['pull-models', "'true'"]]) {
    assert.match(ACTION, new RegExp(`\\n  ${input}:\\n[\\s\\S]*?\\n    default: ${value}\\n`), input);
  }
});

test('the plan job checks for changes and plans the work, with no models, and uploads the plan only when there is work', () => {
  assert.deepStrictEqual(names(running({ mode: 'plan' })), ['Check for changes', 'Install dependencies', 'Run Docturnal', 'Upload the plan']);
  assert.deepStrictEqual(names(running({ mode: 'plan', hasWork: 'false' })), ['Check for changes', 'Install dependencies', 'Run Docturnal']);
});

test('a work job downloads the plan, sets up its models, does its shard, and uploads its results', () => {
  assert.deepStrictEqual(names(running({ mode: 'work' })), [
    'Check for changes', 'Download the plan', 'Select models', 'Restore Ollama models cache', 'Find the Ollama version', 'Restore Ollama install cache',
    'Install Ollama', 'Start Ollama', 'Pull models', 'Install dependencies', 'Run Docturnal', 'Upload the work results',
  ]);
  const upload = steps().find((s) => s.name === 'Upload the work results');
  assert.match(ACTION, /name: docturnal-shard-\$\{\{ inputs\.shard \}\}\n {8}path: \$\{\{ runner\.temp \}\}\/docturnal-results\/shard-\$\{\{ inputs\.shard \}\}\.json\n {8}retention-days: 1\n/);
  assert.strictEqual(upload.uses, 'actions/upload-artifact@v7');
});

test('the cleanup job only deletes the artifacts: no download, models, or run', () => {
  assert.deepStrictEqual(names(running({ mode: 'cleanup', changed: 'false' })), ['Check for changes', "Delete the run's artifacts"]);
});

test('the finish job downloads everything, finishes, and always deletes the artifacts', () => {
  const finish = names(running({ mode: 'finish' }));
  assert.deepStrictEqual(finish.slice(0, 3), ['Check for changes', 'Download the plan', 'Download the work results']);
  assert.deepStrictEqual(finish.slice(-2), ['Run Docturnal', "Delete the run's artifacts"]);
  // The deletion runs even when the finish fails.
  assert.strictEqual(steps().find((s) => s.name === "Delete the run's artifacts").if, "always() && (inputs.mode == 'finish' || inputs.mode == 'cleanup')");
  assert.match(ACTION, /name: docturnal-plan\n {8}path: \$\{\{ runner\.temp \}\}\/docturnal-plan\n {8}retention-days: 1\n/);
});
