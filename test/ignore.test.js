'use strict';

// .docturnalignore: .gitignore-style patterns for paths Docturnal never comments or documents.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listFiles } = require('../src/git');
const { findChanges, ignoreHash } = require('../src/changes');
const { readConfig } = require('../src/config');
const { emptyState } = require('../src/state');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-ignore-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: `${dir}.gitconfig`, GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  fs.rmSync(env.GIT_CONFIG_GLOBAL, { force: true });
  return dir;
}

const CODE = 'export function f() {\n  return 1;\n}\n';

test('.gitignore-style patterns: directories, globs, anchors, **, and negation', () => {
  const dir = repo({
    '.docturnalignore': [
      '# Fixtures are compared byte for byte.',
      'test/fixtures/',
      '*.min.js',
      '!keep.min.js',
      '/root-only.js',
      'vendor/**/gen.js',
      '',
    ].join('\n'),
    'src/app.js': CODE,
    'test/fixtures/payroll.js': CODE,
    'test/fixtures/deep/more.js': CODE,
    'test/app.test.js': CODE,
    'lib/bundle.min.js': CODE,
    'lib/keep.min.js': CODE,
    'root-only.js': CODE,
    'src/root-only.js': CODE,
    'vendor/a/b/gen.js': CODE,
    'vendor/a/b/other.js': CODE,
  });
  try {
    assert.deepStrictEqual(listFiles(dir).sort(), [
      '.docturnalignore',
      'lib/keep.min.js',
      'src/app.js',
      'src/root-only.js',
      'test/app.test.js',
      'vendor/a/b/other.js',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without .docturnalignore, every tracked file is listed', () => {
  const dir = repo({ 'src/app.js': CODE, 'test/fixtures/payroll.js': CODE });
  try {
    assert.deepStrictEqual(listFiles(dir).sort(), ['src/app.js', 'test/fixtures/payroll.js']);
    assert.strictEqual(ignoreHash(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ignored files are never commented, and a change to .docturnalignore counts as a change', () => {
  const dir = repo({ '.docturnalignore': 'generated/\n', 'src/app.js': CODE, 'generated/api.js': CODE });
  try {
    const config = readConfig({});
    const first = findChanges(dir, config, emptyState());
    assert.deepStrictEqual(first.toComment.map((e) => e.path), ['src/app.js']);

    // The state after that run, recording the files and the .docturnalignore it saw.
    const previous = {
      ...emptyState(),
      commentLevel: 'medium',
      ignoreHash: first.ignoreHash,
      files: Object.fromEntries(first.entries.map((e) => [e.path, { hash: e.hash }])),
    };
    assert.strictEqual(findChanges(dir, config, previous).ignoreChanged, false);

    // Only a comment changes: still a change.
    fs.writeFileSync(path.join(dir, '.docturnalignore'), '# Generated code.\ngenerated/\n');
    const edited = findChanges(dir, config, previous);
    assert.strictEqual(edited.ignoreChanged, true);
    assert.deepStrictEqual(edited.toComment, []);

    // Ignoring src/ makes its file count as deleted.
    fs.writeFileSync(path.join(dir, '.docturnalignore'), 'generated/\nsrc/\n');
    assert.deepStrictEqual(findChanges(dir, config, previous).deleted, ['src/app.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
