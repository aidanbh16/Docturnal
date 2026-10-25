'use strict';

// A synthetic project of 1,000 source files in 50 folders: the first documentation run makes
// about one model call per folder, not per file, and writes every layer doc and the README
// within the 90-minute budget. Time is simulated from token counts, at speeds estimated for a
// 4-core GitHub-hosted runner on CPU; the benchmark line of a real run confirms them.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { startMockOllama } = require('./mock-ollama');
const { gitRepo } = require('./git-repo');

// Tokens per second, and the answer length assumed for each kind of call.
const SPEEDS = {
  'comment-model': { prompt: 90, output: 13, load: 30 },
  'docs-model': { prompt: 30, output: 6, load: 30 },
};
const CHARS_PER_TOKEN = 3;
const DOC_ANSWER_TOKENS = 700;
const CONTEXT_TOKENS = 8192;

function project() {
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

test('a 1,000-file first run: about one model call per folder, and every doc written within 90 minutes', { timeout: 600000 }, async () => {
  const { run } = require('../src/main');
  const mock = await startMockOllama();
  const repo = gitRepo();
  try {
    repo.commit(project(), 'A large project');
    const cwd = repo.clone();
    const start = Date.parse('2026-10-24T00:00:00Z');
    let clock = start;
    const loaded = new Set();
    const calls = [];
    const chat = async (request) => {
      const prompt = (request.messages || []).map((m) => m.content).join('\n');
      const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
      const content = (await res.json()).message.content;
      const speed = SPEEDS[request.model];
      const isDoc = /documentation page/.test(prompt);
      const answer = isDoc ? DOC_ANSWER_TOKENS : Math.max(content.length / CHARS_PER_TOKEN, (request.options && request.options.num_predict) || 0);
      let seconds = prompt.length / CHARS_PER_TOKEN / speed.prompt + answer / speed.output;
      if (!loaded.has(request.model)) {
        loaded.add(request.model);
        seconds += speed.load;
      }
      clock += seconds * 1000;
      calls.push({ model: request.model, kind: request.messages[0].content.slice(0, 30), promptTokens: prompt.length / CHARS_PER_TOKEN });
      return content;
    };
    const logs = [];
    const result = await run({
      cwd,
      env: { ...repo.gitEnv, BASE_BRANCH: 'main', INPUT_COMMENT_LEVEL: 'medium', INPUT_TIME_BUDGET_MINUTES: '90', INPUT_CONTEXT_TOKENS: String(CONTEXT_TOKENS), INPUT_SELECTED_COMMENT_MODEL: 'comment-model', INPUT_SELECTED_DOCS_MODEL: 'docs-model', PUSH: 'false' },
      chat,
      now: () => clock,
      log: (l) => logs.push(l),
    });

    const folderCalls = calls.filter((c) => c.kind.startsWith('You describe one folder'));
    // One call per folder (each holds 20 files, under the 40 a call may take): 50, not 1,000.
    assert.strictEqual(folderCalls.length, 50);
    // Every prompt fits the context, with room for the answer.
    for (const call of calls) assert.ok(call.promptTokens < CONTEXT_TOKENS - 500, `${call.kind}: ${Math.round(call.promptTokens)} tokens`);

    // Everything is read, and the docs are written, within the budget.
    assert.deepStrictEqual(result.leftOver, []);
    const minutes = (clock - start) / 60000;
    assert.ok(minutes <= 90, `took ${minutes.toFixed(1)} simulated minutes`);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.docturnal/state.json'), 'utf8'));
    assert.strictEqual(state.docsComplete, true);
    assert.strictEqual(Object.values(state.files).filter((e) => typeof e.summary === 'string').length, 1000);
    assert.strictEqual(Object.keys(state.folders).length, 50);
    assert.ok(state.layers.length >= 2 && state.layers.length <= 7);
    assert.deepStrictEqual(state.staleDocs, []);
    for (const layer of state.layers) {
      assert.ok(fs.existsSync(path.join(cwd, 'docs', `${layer.slug}.md`)), layer.slug);
    }
    assert.strictEqual(new Set(state.layers.flatMap((l) => l.files)).size, 1000);
    const readme = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');
    assert.match(readme, /## Architecture/);
    assert.doesNotMatch(readme, /Not described yet/);
    // The benchmark line: counts and minutes per phase, never code or file names.
    const benchmark = logs.find((l) => l.startsWith('Docturnal: benchmark: '));
    assert.match(benchmark, /^Docturnal: benchmark: 1000 source files, 50 folders, \d+ model calls \(50 for summaries\); minutes: summaries \d+\.\d, layers \d+\.\d, layer docs \d+\.\d, README \d+\.\d, total \d+\.\d$/);
    console.log(`  ${benchmark}`);
    assert.ok(execFileSync('git', ['log', '--oneline', '-1'], { cwd, env: repo.gitEnv, encoding: 'utf8' }).includes('Docturnal: documentation'));
  } finally {
    await mock.close();
    repo.cleanup();
  }
});
