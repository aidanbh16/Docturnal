'use strict';

// First runs at size, with model time simulated at speeds calibrated from a real runner (see
// speed-model.js): a project like Docturnal's own (72 source files) documents itself in under
// 20 minutes, and a 1,000-file project's first documentation pull request arrives within the
// 90-minute budget. Every docs prompt stays under the fixed size limit.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { startMockOllama } = require('./mock-ollama');
const { gitRepo } = require('./git-repo');
const { simulatedChat } = require('./speed-model');

const CONTEXT_TOKENS = 8192;
// The most characters a docs prompt may have, instructions included, whatever the code's own limit.
const DOC_PROMPT_LIMIT = 4000;

// A source file. commented: a one-sentence leading comment that gives its purpose; long: a
// comment too long to be a purpose; none: no leading comment.
function source(name, comment, i) {
  const header = comment === 'commented' ? `// Handles the ${name} step of a nightly run.\n`
    : comment === 'long' ? `// Reads the ${name} settings, checks them against the stored state, decides what changes, and writes the result back with every rule the step follows:\n// - one\n`
      : '';
  return `${header}import { helper } from './shared';\n\nexport function ${name}(options) {\n  let total = 0;\n  for (let n = 0; n < options.limit; n++) total += n * ${i};\n  return helper(total);\n}\n\nexport const ${name}Limit = ${i + 3};\n`;
}

// Docturnal's own layout: src 29, test 23, app/src 8, app/tests 7, scripts 3, app/scripts 2.
function projectLike72() {
  const files = { 'package.json': JSON.stringify({ name: 'like-docturnal', scripts: { test: 'node --test' } }) };
  const kinds = ['commented', 'long', 'none'];
  const add = (dir, count, offset) => {
    for (let i = 0; i < count; i++) files[`${dir}/mod${String(i).padStart(2, '0')}.js`] = source(`${dir.replace(/\W/g, '')}${i}`, kinds[(i + offset) % 3], i);
    files[`${dir}/shared.js`] = 'export const helper = (x) => x;\n';
  };
  add('src', 28, 0);
  add('test', 22, 1);
  add('app/src', 7, 2);
  add('app/tests', 6, 0);
  add('scripts', 2, 1);
  add('app/scripts', 1, 2);
  return files;
}

function project1000() {
  const files = {};
  const areas = ['api', 'core', 'data', 'ui', 'jobs'];
  for (let folder = 0; folder < 50; folder++) {
    const dir = `src/${areas[folder % areas.length]}/part${String(folder).padStart(2, '0')}`;
    for (let i = 0; i < 20; i++) {
      const name = `mod${String(i).padStart(2, '0')}`;
      if (i % 4 === 3) {
        files[`${dir}/${name}.py`] = `"""Handles ${name} records for ${dir}."""\nimport json\n\n\ndef load_${name}(raw):\n    return json.loads(raw)\n\n\nclass ${name.toUpperCase()}Store:\n    def save(self, item):\n        return item\n`;
      } else {
        const other = `mod${String((i + 1) % 20).padStart(2, '0')}`;
        files[`${dir}/${name}.ts`] = `// Computes ${name} totals for ${dir}.\nimport { helper } from './${other}';\n\nexport interface ${name}Options {\n  limit: number;\n}\n\nexport function run${i}(options: ${name}Options): number {\n  let total = 0;\n  for (let n = 0; n < options.limit; n++) total += n;\n  return total;\n}\n\nexport const helper = (x: number) => x * 2;\n`;
      }
    }
  }
  files['package.json'] = JSON.stringify({ name: 'big-project', scripts: { start: 'node dist/index.js' } }, null, 2);
  return files;
}

async function firstRun(files) {
  const { run } = require('../src/main');
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(files, 'A project');
    const cwd = repo.clone();
    const sim = simulatedChat(mock);
    const logs = [];
    const result = await run({
      cwd,
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '90', INPUT_CONTEXT_TOKENS: String(CONTEXT_TOKENS), INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model', PUSH: 'false' },
      chat: sim.chat,
      now: sim.now,
      log: (l) => logs.push(l),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.docturnal/state.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');
    const docsWritten = state.layers.every((layer) => fs.existsSync(path.join(cwd, 'docs', `${layer.slug}.md`)));
    return { result, state, readme, docsWritten, sim, logs };
  } finally {
    await mock.close();
    repo.cleanup();
  }
}

function checkPromptSizes(sim) {
  for (const call of sim.calls.filter((c) => c.model === 'docs-model')) {
    assert.ok(call.promptChars <= DOC_PROMPT_LIMIT, `${call.label}: ${call.promptChars} characters`);
  }
}

test('a 72-file project like Docturnal\'s: the whole first run in under 20 minutes, with every file described', { timeout: 600000 }, async () => {
  const run = await firstRun(projectLike72());
  const minutes = run.sim.minutes();
  console.log(`  ${run.logs.find((l) => l.startsWith('Docturnal: benchmark: '))}`);
  assert.ok(minutes < 20, `took ${minutes.toFixed(1)} simulated minutes`);
  assert.deepStrictEqual(run.result.leftOver, []);
  const code = Object.entries(run.state.files).filter(([file]) => file.endsWith('.js'));
  assert.strictEqual(code.length, 72);
  assert.ok(code.every(([, entry]) => typeof entry.summary === 'string' && entry.summary.length > 0));
  assert.strictEqual(run.state.docsComplete, true);
  assert.ok(run.docsWritten);
  // Layers from the real folders: the test folders are one layer, and app/scripts joins app/src.
  assert.deepStrictEqual(run.state.layers.map((l) => [...new Set(l.files.map((f) => path.posix.dirname(f)))].sort().join('+')).sort(),
    ['app/scripts+app/src', 'app/tests+test', 'scripts', 'src']);
  checkPromptSizes(run.sim);
});

test('a 1,000-file project: the first documentation pull request within the 90-minute budget', { timeout: 600000 }, async () => {
  const run = await firstRun(project1000());
  const minutes = run.sim.minutes();
  console.log(`  ${run.logs.find((l) => l.startsWith('Docturnal: benchmark: '))}`);
  assert.ok(minutes <= 90, `took ${minutes.toFixed(1)} simulated minutes`);
  const folderCalls = run.sim.calls.filter((c) => /^You describe one folder/.test(c.system));
  // About one call per folder, not one per file.
  assert.ok(folderCalls.length >= 50 && folderCalls.length <= 100, `${folderCalls.length} folder calls`);
  assert.ok(run.docsWritten);
  assert.match(run.readme, /## Architecture/);
  assert.ok(run.state.layers.length >= 2 && run.state.layers.length <= 7);
  checkPromptSizes(run.sim);
});
