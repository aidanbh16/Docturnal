'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const docs = require('../src/docs');
const { startMockOllama } = require('./mock-ollama');

const { MARKER } = docs;
const ROCKET = String.fromCodePoint(0x1f680);
const SPARKLES = String.fromCodePoint(0x2728);

const h2s = (doc) => doc.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

// --- Clean-up ---

test('cleans messy model output into a correct doc', () => {
  const raw = [
    "Sure! Here's the documentation for the layer:",
    '',
    '```markdown',
    `# data access ${ROCKET}`,
    '',
    `This layer reads and writes records for the app. ${SPARKLES}`,
    '',
    '## How It Works',
    '',
    'The [record store](store.md) caches rows. See the [project overview](README.md).',
    '',
    '```js',
    '# not a heading',
    'const x = 1;',
    '```',
    '',
    'In conclusion, this layer keeps data access in one place.',
    '```',
    '',
    'Let me know if you want any changes!',
  ].join('\n');

  const doc = docs.cleanDoc(raw, {
    title: 'Data Access',
    docPath: 'docs/data-access.md',
    existingPaths: new Set(['docs/README.md']),
  });

  assert.strictEqual(doc, [
    MARKER,
    '',
    '# Data Access',
    '',
    'This layer reads and writes records for the app.',
    '',
    '## How it works',
    '',
    'The record store caches rows. See the [project overview](README.md).',
    '',
    '```js',
    '# not a heading',
    'const x = 1;',
    '```',
    '',
  ].join('\n'));
});

test('forces one H1, demotes extra H1s, and drops conclusion sections', () => {
  const doc = docs.cleanDoc(
    ['# Wrong Title', 'Intro.', '# Setup Steps:', 'Run it.', '## Conclusion', 'It was great.', '## Next Part', 'More.'].join('\n'),
    { title: 'Right Title' }
  );
  assert.strictEqual(doc, `${MARKER}\n\n# Right Title\n\nIntro.\n\n## Setup steps\n\nRun it.\n\n## Next part\n\nMore.\n`);
});

test('converts headings to sentence case and keeps names', () => {
  assert.strictEqual(docs.sentenceCase('How It Works'), 'How it works');
  assert.strictEqual(docs.sentenceCase('Using The GitHub API'), 'Using the GitHub API');
  assert.strictEqual(docs.sentenceCase('Setting Up Docker'), 'Setting up Docker');
  assert.strictEqual(docs.sentenceCase('Configuring `MAX_SIZE` Limits'), 'Configuring `MAX_SIZE` limits');
  assert.strictEqual(docs.sentenceCase('GETTING STARTED'), 'Getting started');
  assert.strictEqual(docs.sentenceCase('Reading package.json Files'), 'Reading package.json files');
  assert.strictEqual(docs.titleCase('data access for the api'), 'Data Access for the Api');
});

test('keeps web links, anchors, and links to files that exist', () => {
  const doc = docs.cleanDoc(
    'Text [site](https://example.com) [top](#intro) [code](../src/a.js) [gone](../src/b.js) [out](../../x.md) ![img](pic.png)',
    { title: 'T', docPath: 'docs/t.md', existingPaths: new Set(['src/a.js']) }
  );
  assert.match(doc, /\[site\]\(https:\/\/example\.com\) \[top\]\(#intro\) \[code\]\(\.\.\/src\/a\.js\) gone out !\[img\]\(pic\.png\)/);
});

test('leaves a reply alone when its first code block is not a wrapper', () => {
  const raw = '# Title\n\nIntro.\n\n```markdown\n# example\n```\n';
  assert.strictEqual(docs.cleanDoc(raw, { title: 'Title' }), `${MARKER}\n\n# Title\n\nIntro.\n\n\`\`\`markdown\n# example\n\`\`\`\n`);
});

// --- Layer normalization ---

const FILES = [
  'src/api/users.js',
  'src/api/orders.js',
  'src/db/client.js',
  'src/db/models/user.js',
  'src/ui/App.tsx',
  'src/ui/Button.tsx',
];

test('normalizes layers: unknown, duplicate, and missing files, and reserved slugs', () => {
  const layers = docs.normalizeLayers(
    {
      layers: [
        { name: 'request handlers', description: 'Handles HTTP requests. Also more.', files: ['src/api/users.js', './src/api/orders.js', 'src/ghost.js'] },
        { name: 'Data Access', description: 'Talks to the database', files: ['src/db/client.js', 'src/api/users.js'] },
        { name: 'readme', description: 'Renders the interface.', files: ['src/ui/App.tsx'] },
      ],
    },
    FILES
  );
  assert.deepStrictEqual(layers, [
    { name: 'Request Handlers', slug: 'request-handlers', description: 'Handles HTTP requests.', files: ['src/api/orders.js', 'src/api/users.js'] },
    { name: 'Data Access', slug: 'data-access', description: 'Talks to the database.', files: ['src/db/client.js', 'src/db/models/user.js'] },
    { name: 'Readme', slug: 'readme-layer', description: 'Renders the interface.', files: ['src/ui/App.tsx', 'src/ui/Button.tsx'] },
  ]);
});

test('merges layers with the same name and caps the count at seven', () => {
  const merged = docs.normalizeLayers(
    { layers: [{ name: 'Core', description: 'A.', files: ['a.js'] }, { name: 'core', description: 'B.', files: ['b.js'] }, { name: 'Index', description: 'C.', files: ['c.js'] }] },
    ['a.js', 'b.js', 'c.js']
  );
  assert.deepStrictEqual(merged.map((l) => [l.slug, l.files]), [['core', ['a.js', 'b.js']], ['index-layer', ['c.js']]]);

  const many = Array.from({ length: 9 }, (_, i) => ({ name: `Layer ${i}`, description: 'X.', files: [`m${i}/f.js`] }));
  const capped = docs.normalizeLayers({ layers: many }, many.map((l) => l.files[0]));
  assert.strictEqual(capped.length, 7);
  assert.deepStrictEqual(capped.flatMap((l) => l.files).sort(), many.map((l) => l.files[0]).sort());
});

test('falls back to previous layers, then to folders', () => {
  const previous = [{ name: 'Backend', slug: 'backend', description: 'Serves data.', files: ['src/api/users.js', 'src/db/client.js'] }];
  const fromPrevious = docs.normalizeLayers({ layers: [] }, FILES, { previous });
  assert.strictEqual(fromPrevious.length, 1);
  assert.deepStrictEqual(fromPrevious[0].files, [...FILES].sort());

  const byFolder = docs.normalizeLayers(null, FILES);
  assert.deepStrictEqual(byFolder.map((l) => [l.name, l.files.length]), [['Api', 2], ['Db', 2], ['Ui', 2]]);
  assert.strictEqual(byFolder[0].description, 'Code in the `src/api` folder.');
});

test('picks another slug when a person wrote a doc with that name', () => {
  const layers = docs.normalizeLayers({ layers: [{ name: 'API', description: 'X.', files: ['a.js'] }] }, ['a.js'], {
    isTaken: (slug) => slug === 'api',
  });
  assert.strictEqual(layers[0].slug, 'api-2');
});

// --- Assembly ---

const LAYERS = [
  { name: 'Request Handlers', slug: 'request-handlers', description: 'Handles HTTP requests.', files: ['src/api/orders.js', 'src/api/users.js'] },
  { name: 'Data Access', slug: 'data-access', description: 'Talks to the database.', files: ['src/db/client.js'] },
];
const FILE_INFO = new Map([
  ['src/api/orders.js', { summary: 'Defines order routes. Validates input.', symbols: ['listOrders', 'createOrder'] }],
  ['src/api/users.js', { summary: 'Defines user routes | admin only.', symbols: ['getUser'] }],
  ['src/db/client.js', { summary: 'Opens the database pool.', symbols: ['pool'] }],
]);

test('layer doc has the sections in order with generated tables and links', () => {
  const raw = [
    '# Handlers',
    'Routes turn requests into calls to the data layer.',
    '## How It Works',
    'Each route validates input first.',
    '## Key Components',
    '- made up by the model',
    '## Overview',
    'The handlers live in `src/api`.',
    '## Error Handling',
    'Errors become JSON responses.',
    '## Configuration',
    'None.',
    '## Responsibilities',
    '- Validate input.',
  ].join('\n');
  const doc = docs.buildLayerDoc(raw, { layer: LAYERS[0], layers: LAYERS, fileInfo: FILE_INFO });

  assert.ok(doc.startsWith(`${MARKER}\n\n# Request Handlers\n\nRoutes turn requests into calls to the data layer.\n\n## Overview`));
  assert.deepStrictEqual(h2s(doc), ['Overview', 'Responsibilities', 'Key components', 'How it works', 'Related layers']);
  assert.match(doc, /\| \[`src\/api\/orders\.js`\]\(\.\.\/src\/api\/orders\.js\) \| Defines order routes\. \| `listOrders`, `createOrder` \|/);
  assert.match(doc, /\| Defines user routes \\\| admin only\. \| `getUser` \|/);
  assert.match(doc, /## How it works\n\nEach route validates input first\.\n\n### Error handling\n\nErrors become JSON responses\./);
  // Layer docs link to each other within docs/, and back to the main document at the root.
  assert.match(doc, /## Related layers\n\n- \[Project README\]\(\.\.\/README\.md\): the overview of the whole project and every layer\.\n- \[Data Access\]\(data-access\.md\): Talks to the database\.\n$/);
  assert.doesNotMatch(doc, /made up by the model/);
});

test('layer doc keeps a real configuration section', () => {
  const raw = '# X\nIntro.\n## Overview\nO.\n## Configuration\nSet `DATABASE_URL` to the connection string.';
  const doc = docs.buildLayerDoc(raw, { layer: LAYERS[1], layers: LAYERS, fileInfo: FILE_INFO });
  assert.deepStrictEqual(h2s(doc), ['Overview', 'Responsibilities', 'Key components', 'Configuration', 'Related layers']);
  // With no responsibilities from the model, they come from the file summaries.
  assert.match(doc, /## Responsibilities\n\n- Opens the database pool\./);
});

const REPO = {
  'package.json': JSON.stringify({
    name: 'shopfront',
    description: 'An online store.',
    scripts: { dev: 'vite', test: 'vitest run' },
    dependencies: { react: '^18.0.0' },
    engines: { node: '>=20' },
  }),
  'yarn.lock': '',
  '.env.example': 'DATABASE_URL=postgres://secret@host/db\nexport API_KEY=abc123\n# comment\n',
  'README.md': '# Shopfront\n\nRun `yarn dev`.\n',
  'src/api/orders.js': 'export function listOrders() {}\n',
  'src/api/users.js': 'export function getUser() {}\n',
  'src/db/client.js': 'export const pool = {};\n',
  'node_modules/react/index.js': '',
};
const repoRead = (store) => (p) => (Object.prototype.hasOwnProperty.call(store, p) ? store[p] : null);

test('collects project facts without .env values', () => {
  const facts = docs.collectProjectFacts(repoRead(REPO), Object.keys(REPO));
  assert.strictEqual(facts.name, 'shopfront');
  assert.deepStrictEqual(facts.scripts, { dev: 'vite', test: 'vitest run' });
  assert.deepStrictEqual(facts.packageManagers, ['yarn']);
  assert.deepStrictEqual(facts.envVars, ['DATABASE_URL', 'API_KEY']);
  assert.doesNotMatch(JSON.stringify(facts), /secret|abc123/);
});

// --- End to end ---

function mockHandler(body) {
  if (body.format) {
    return {
      layers: [
        { name: 'API', description: 'Handles HTTP requests.', files: ['src/api/orders.js', 'src/api/users.js'] },
        { name: 'Data Access', description: 'Talks to the database.', files: ['src/db/client.js'] },
      ],
    };
  }
  const prompt = body.messages[1].content;
  if (prompt.includes('main documentation page')) return '# Shopfront\nShopfront sells things.\n## Overview\nIt is a store.';
  const name = prompt.match(/for the "([^"]+)" layer/)[1];
  return `# ${name}\nThe ${name} layer.\n## Overview\nDetails.\n## How it works\nSteps.`;
}

test('generateDocs plans layers, writes docs, respects human docs, and regenerates only changed layers', async () => {
  const mock = await startMockOllama(mockHandler);
  try {
    const store = { ...REPO, 'docs/api.md': '# API notes written by hand\n' };
    const files = ['src/api/orders.js', 'src/api/users.js', 'src/db/client.js'].map((p) => ({
      path: p,
      summary: FILE_INFO.get(p).summary,
      symbols: FILE_INFO.get(p).symbols,
    }));
    const first = await docs.generateDocs({ files, allFiles: Object.keys(store), readFile: repoRead(store), model: 'docs', host: mock.host });

    assert.deepStrictEqual(first.errors, []);
    assert.deepStrictEqual(first.layers.map((l) => l.slug), ['api-2', 'data-access']);
    // Only layer docs go in docs/; the main document is README.md, planned by readme.js.
    assert.deepStrictEqual(first.docs.map((d) => d.path), ['docs/api-2.md', 'docs/data-access.md']);
    assert.strictEqual(first.readmeNeeded, true);
    assert.strictEqual(first.projectName, 'shopfront');
    for (const doc of first.docs) assert.ok(docs.hasMarker(doc.content), doc.path);
    assert.strictEqual(mock.requests[0].model, 'docs');
    assert.match(mock.requests[0].messages[0].content, /Never invent APIs/);
    assert.ok(mock.requests.every((r) => r.messages[0].content.includes(docs.STYLE_RULES)));

    // Second night: only src/db/client.js changed.
    for (const doc of first.docs) store[doc.path] = doc.content;
    const before = mock.requests.length;
    const second = await docs.generateDocs({
      files,
      allFiles: Object.keys(store),
      readFile: repoRead(store),
      model: 'docs',
      host: mock.host,
      previousLayers: first.layers,
      changedFiles: new Set(['src/db/client.js']),
    });
    assert.deepStrictEqual(second.docs.map((d) => d.path), ['docs/data-access.md']);
    // The set of files is the same, so the layers are reused without asking the model.
    assert.strictEqual(second.replanned, false);
    assert.strictEqual(mock.requests.length - before, 1);

    // An earlier version's docs/README.md is removed only when it has the marker.
    store['docs/README.md'] = `${MARKER}\n\n# Shopfront\n`;
    const third = await docs.generateDocs({ files, allFiles: Object.keys(store), readFile: repoRead(store), model: 'docs', host: mock.host });
    assert.deepStrictEqual(third.removed, ['docs/README.md']);
    store['docs/README.md'] = '# Our own docs index\n';
    const fourth = await docs.generateDocs({ files, allFiles: Object.keys(store), readFile: repoRead(store), model: 'docs', host: mock.host });
    assert.deepStrictEqual(fourth.removed, []);
    assert.ok(!fourth.docs.some((d) => d.path === 'docs/README.md'));
  } finally {
    await mock.close();
  }
});

test('writeDocs never overwrites or deletes a doc without the marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-docs-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/human.md'), '# Mine\n');
    fs.writeFileSync(path.join(root, 'docs/old.md'), `${MARKER}\n\n# Old\n`);
    fs.writeFileSync(path.join(root, 'docs/kept.md'), '# Also mine\n');
    const content = `${MARKER}\n\n# New\n`;
    const result = docs.writeDocs({
      root,
      docs: [{ path: 'docs/human.md', content }, { path: 'docs/new.md', content }],
      removed: ['docs/old.md', 'docs/kept.md'],
    });
    assert.deepStrictEqual(result.written, ['docs/new.md']);
    assert.deepStrictEqual(result.skipped.map((s) => s.path), ['docs/human.md']);
    assert.deepStrictEqual(result.deleted, ['docs/old.md']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/human.md'), 'utf8'), '# Mine\n');
    assert.ok(fs.existsSync(path.join(root, 'docs/kept.md')));
    assert.throws(() => docs.writeDocs({ root, docs: [{ path: 'docs/x.md', content: '# no marker' }] }), /without the Docturnal marker/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
