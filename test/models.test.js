'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../src/models');

// Real MemTotal values reported by GitHub's standard Linux runners.
const MEMINFO_16GB = `MemTotal:       16365264 kB
MemFree:         7203840 kB
MemAvailable:   14951432 kB
Buffers:          102548 kB
`;
const MEMINFO_8GB = `MemTotal:        8131852 kB
MemFree:         3104208 kB
MemAvailable:    6812004 kB
`;

function fakeReadFile(contents) {
  return (file) => {
    assert.strictEqual(file, '/proc/meminfo');
    return contents;
  };
}

test('parses MemTotal from /proc/meminfo', () => {
  assert.strictEqual(models.parseMemTotal(MEMINFO_16GB), 16365264 * 1024);
  assert.throws(() => models.parseMemTotal('MemFree: 1 kB\n'), /MemTotal not found/);
});

test('16 GB runner uses 7b for docs with no fallback warning', () => {
  const totalMemoryBytes = models.readTotalMemory(fakeReadFile(MEMINFO_16GB));
  const selection = models.selectModels({ totalMemoryBytes, model: 'auto', docsModel: 'auto' });
  assert.strictEqual(selection.commentModel, 'qwen2.5-coder:3b');
  assert.strictEqual(selection.docsModel, 'qwen2.5-coder:7b');
  assert.strictEqual(selection.docsMayFallback, false);
  assert.match(models.formatSummary(selection), /^Docturnal: RAM 15\.6 GiB, comment model qwen2\.5-coder:3b, docs model qwen2\.5-coder:7b$/);
});

test('8 GB runner still uses 7b for docs but marks it as may fall back', () => {
  const totalMemoryBytes = models.readTotalMemory(fakeReadFile(MEMINFO_8GB));
  const selection = models.selectModels({ totalMemoryBytes, model: 'auto', docsModel: 'auto' });
  assert.strictEqual(selection.commentModel, 'qwen2.5-coder:3b');
  assert.strictEqual(selection.docsModel, 'qwen2.5-coder:7b');
  assert.strictEqual(selection.docsMayFallback, true);
  assert.strictEqual(selection.fallbackDocsModel, 'qwen2.5-coder:3b');
  assert.match(models.formatSummary(selection), /RAM 7\.8 GiB.*docs model qwen2\.5-coder:7b \(may fall back to qwen2\.5-coder:3b\)$/);
});

test('empty inputs count as auto', () => {
  const selection = models.selectModels({ totalMemoryBytes: 16 * 1024 ** 3, model: '', docsModel: undefined });
  assert.strictEqual(selection.commentModel, models.COMMENT_MODEL);
  assert.strictEqual(selection.docsModel, models.DOCS_MODEL);
});

test('override inputs replace the automatic choice and skip the fallback flag', () => {
  const selection = models.selectModels({
    totalMemoryBytes: 8 * 1024 ** 3,
    model: ' custom:1b ',
    docsModel: 'custom:3b',
  });
  assert.strictEqual(selection.commentModel, 'custom:1b');
  assert.strictEqual(selection.docsModel, 'custom:3b');
  assert.strictEqual(selection.docsMayFallback, false);
});

test('falls back to os.totalmem when /proc/meminfo is unreadable', () => {
  const missing = () => {
    throw new Error('ENOENT');
  };
  assert.strictEqual(models.readTotalMemory(missing), os.totalmem());
});

test('writes outputs in GITHUB_OUTPUT format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docturnal-'));
  const outputPath = path.join(dir, 'output');
  const selection = models.selectModels({ totalMemoryBytes: 8131852 * 1024, model: 'auto', docsModel: 'auto' });
  models.writeOutputs(selection, outputPath);
  assert.strictEqual(
    fs.readFileSync(outputPath, 'utf8'),
    [
      'comment-model=qwen2.5-coder:3b',
      'docs-model=qwen2.5-coder:7b',
      'docs-may-fallback=true',
      'fallback-docs-model=qwen2.5-coder:3b',
      'ram-gib=7.8',
      '',
    ].join('\n')
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
