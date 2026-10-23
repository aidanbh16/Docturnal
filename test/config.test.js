'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { readConfig, ConfigError } = require('../src/config');

test('uses defaults when no inputs are set', () => {
  const config = readConfig({});
  assert.strictEqual(config.commentLevel, 'medium');
  assert.strictEqual(config.docsDir, 'docs');
  assert.strictEqual(config.path, '.');
  assert.deepStrictEqual(config.exclude, []);
  assert.deepStrictEqual(config.extensions, []);
  assert.strictEqual(config.contextTokens, 8192);
  assert.strictEqual(config.timeBudgetMinutes, 90);
  assert.strictEqual(config.model, 'auto');
  assert.strictEqual(config.docsModel, 'auto');
});

test('parses lists and numbers', () => {
  const config = readConfig({
    INPUT_EXCLUDE: 'vendor/**, dist/**\n*.min.js',
    INPUT_EXTENSIONS: '.JS,ts',
    INPUT_CONTEXT_TOKENS: '4096',
  });
  assert.deepStrictEqual(config.exclude, ['vendor/**', 'dist/**', '*.min.js']);
  assert.deepStrictEqual(config.extensions, ['js', 'ts']);
  assert.strictEqual(config.contextTokens, 4096);
});

test('rejects an invalid comment-level with a clear message', () => {
  assert.throws(
    () => readConfig({ INPUT_COMMENT_LEVEL: 'wrong' }),
    (err) => err instanceof ConfigError &&
      err.message === 'Invalid comment-level "wrong". Use one of: low, medium, heavy, off.'
  );
});

test('rejects bad numbers and paths outside the repo', () => {
  assert.throws(() => readConfig({ INPUT_TIME_BUDGET_MINUTES: '0' }), ConfigError);
  assert.throws(() => readConfig({ INPUT_CONTEXT_TOKENS: 'lots' }), ConfigError);
  assert.throws(() => readConfig({ INPUT_DOCS_DIR: '../elsewhere' }), ConfigError);
  assert.throws(() => readConfig({ INPUT_PATH: '/etc' }), ConfigError);
});
