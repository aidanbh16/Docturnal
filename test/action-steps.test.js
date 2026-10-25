'use strict';

// Which steps of action.yml run, from each step's if:, evaluated the way GitHub Actions does.

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

// The steps that run, on a night with changes or without.
function running({ changed = 'true' } = {}) {
  const context = { steps: { precheck: { outputs: { changed } } } };
  return steps().filter((s) => !s.if || Boolean(evaluate(s.if, context)));
}

const names = (list) => list.map((s) => s.name);

test('a night with changes runs every step, and a night without runs only the check', () => {
  assert.deepStrictEqual(names(running()), [
    'Check for changes',
    'Select models',
    'Restore Ollama models cache',
    'Find the pinned Ollama release',
    'Restore Ollama install cache',
    'Install Ollama',
    'Start Ollama',
    'Pull models',
    'Install dependencies',
    'Run Docturnal',
  ]);
  assert.deepStrictEqual(names(running({ changed: 'false' })), ['Check for changes']);
});

test('Ollama listens on loopback only, and the run talks to it there', () => {
  const start = steps().find((s) => s.name === 'Start Ollama');
  assert.strictEqual(start.env.OLLAMA_HOST, '127.0.0.1:11434');
  const run = steps().find((s) => s.name === 'Run Docturnal');
  assert.strictEqual(run.env.OLLAMA_HOST, '${{ steps.ollama-server.outputs.host }}');
});

test('every action action.yml uses is pinned to a full commit SHA, with its version in a comment', () => {
  const references = [...ACTION.matchAll(/^\s*uses:\s*(.+)$/gm)].map((m) => m[1]);
  assert.strictEqual(references.length, 2);
  for (const reference of references) assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, reference);
});

test('Ollama is pinned: no install script, no latest-version lookup, no service, no sudo', () => {
  const code = ACTION.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(code, /install\.sh|releases\/latest|systemctl|sudo/);
  const find = steps().find((s) => s.name === 'Find the pinned Ollama release');
  const version = find.env.OLLAMA_VERSION.replace(/'/g, '');
  const pins = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pins', 'ollama.json'), 'utf8'));
  assert.ok(pins[version], `pins/ollama.json has checksums for the pinned version ${version}`);
  for (const arch of ['amd64', 'arm64']) assert.match(pins[version][arch].sha256, /^[0-9a-f]{64}$/);
  // The install cache key names the version and the checksum.
  assert.match(ACTION, /key: docturnal-ollama-install-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ steps\.ollama\.outputs\.key \}\}\n/);
  // Every pulled model is verified before the run.
  assert.match(ACTION, /node "\$GITHUB_ACTION_PATH\/src\/verify-models\.js" \$verify\n/);
});
