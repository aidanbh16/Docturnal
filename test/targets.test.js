'use strict';

// Where comments go, chosen by code: on excalidraw-like files, exported functions are picked,
// commented ones are skipped, complex blocks are found, and the level's limits hold, so a
// comment written for a target is never dropped for its place, the level, or the gap.

const test = require('node:test');
const assert = require('node:assert');

const { LEVELS, PER_RUN, applyProposals, chooseTargets, planTargets, prepareFile } = require('../src/comments');
const { languageById, languageForPath } = require('../src/languages');
const { findPython } = require('../src/python');
const { fileStructure } = require('../src/structure');
const { parsedTargets } = require('../src/targets');
const { excalidrawFiles } = require('./excalidraw-files');

const FILES = excalidrawFiles();
const plan = (file, level, text = FILES[file]) => planTargets({ path: file, text, level, exportNames: fileStructure(file, text, languageForPath(file)).exports });
const linesOf = (text) => text.split('\n');

// The comment-only line directly above a line, if any (counted from 1).
function commentAbove(lines, line) {
  let i = line - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  return i >= 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[i]) ? lines[i] : null;
}

test('exported functions are picked, and a function with a comment of its own never is', () => {
  const file = 'packages/excalidraw/clients.ts';
  const lines = linesOf(FILES[file]);
  const { targets } = plan(file, 'heavy');
  const declared = lines.map((l, i) => ({ l, line: i + 1 })).filter(({ l }) => /^export (const \w+ = |function |class )/.test(l));
  const documented = declared.filter(({ line }) => commentAbove(lines, line));
  assert.ok(documented.length > 0 && documented.length < declared.length);
  const at = new Set(targets.map((t) => t.line));
  for (const { line } of documented) assert.ok(!at.has(line), `line ${line} already has a comment`);
  for (const { line } of declared.filter((d) => !documented.includes(d))) assert.ok(at.has(line), `line ${line}: ${lines[line - 1]}`);
  // At medium, the exported ones come first and are named as exported.
  const medium = plan(file, 'medium').targets.filter((t) => t.what !== 'block');
  assert.ok(medium.length > 0 && medium.every((t) => t.exported), JSON.stringify(medium.map((t) => [t.name, t.exported])));
});

test('complex blocks are found: nesting, regular expressions, bitwise math, magic numbers, and long conditions', () => {
  const file = 'packages/element/src/snapping.ts';
  const text = FILES[file];
  const lines = linesOf(text);
  const ctx = prepareFile({ text, language: languageForPath(file), level: 'heavy' });
  const blocks = parsedTargets(ctx).blocks;
  const at = (code) => blocks.find((b) => lines[b.line - 1].trim().startsWith(code));
  assert.deepStrictEqual(at('if (Math.abs(corner.x - element.x)').features, ['nested 3 levels deep']);
  // The {6} is part of the regular expression, not a number in the code.
  assert.deepStrictEqual(at('const match = /^#([0-9a-f]{6})$/i').features, ['a regular expression']);
  assert.deepStrictEqual(at('return ((rgb >> 16) & 0xff)').features, ['bitwise math', 'the numbers 16, 0xff, 0.299, 8, and more']);
  assert.deepStrictEqual(at('if (element.type === "arrow" && !element.isDeleted').features, ['a condition with 4 parts', 'the number 2']);
  assert.deepStrictEqual(at('return Math.round(scaled / step) * step').features, ['the numbers 1000, 60']);
  // A statement that only names a number, a small helper, and a plain line are not blocks.
  assert.strictEqual(at('const width = x2 - x1;'), undefined);
  assert.strictEqual(at('const toKey'), undefined);
  // Each block knows the function it is in.
  assert.strictEqual(at('return ((rgb >> 16) & 0xff)').in.startsWith('getLuminance'), true);
});

test('each level keeps to its limits: room, gap, and the kinds of targets it takes', () => {
  for (const [file, text] of Object.entries(FILES)) {
    const lines = linesOf(text);
    for (const level of ['low', 'medium', 'heavy']) {
      const rules = LEVELS[level];
      const p = plan(file, level);
      const info = p.ctx.analysis.info;
      const codeLines = info.filter((li) => !li.blank && !li.commentOnly).length;
      const lineTargets = p.targets.filter((t) => t.kind === 'line');
      // Line comments: no more than the room the comments already there leave.
      const existing = lines.filter((l, i) => /^\s*(\/\/|\/\*\*)/.test(l) && !(rules.blocks && /^export/.test(lines[i + (l.trim() === '/**' ? 3 : 1)] || ''))).length;
      assert.ok(lineTargets.length <= Math.max(1, Math.round(codeLines / rules.linesPerComment)) - existing || lineTargets.length === 0, `${file} ${level}: ${lineTargets.length} line targets`);
      // Apart by the level's gap, constants at heavy aside.
      const spaced = lineTargets.filter((t) => !(rules.blocks && t.what === 'constant')).map((t) => t.line).sort((a, b) => a - b);
      for (let i = 1; i < spaced.length; i++) assert.ok(spaced[i] - spaced[i - 1] >= rules.minGap, `${file} ${level}: lines ${spaced[i - 1]} and ${spaced[i]}`);
      // No target has a comment directly above it.
      for (const t of p.targets) assert.strictEqual(commentAbove(lines, t.line), null, `${file} ${level}: line ${t.line}`);
      if (level === 'low') assert.ok(p.targets.every((t) => t.what !== 'block' && t.what !== 'type' && t.what !== 'constant'), `${file}: low takes declarations only`);
      // At most the level's cap of new comments in one run; the rest wait for a later batch.
      assert.ok(p.targets.length <= PER_RUN[level], `${file} ${level}: ${p.targets.length}`);
      if (p.more) assert.strictEqual(p.targets.length, PER_RUN[level], `${file} ${level}`);
      if (level === 'heavy' && !p.more) {
        // Every function, class, method, and component without a comment gets a block comment.
        const symbols = info.map((li, i) => (li.symbol ? i + 1 : 0)).filter((l) => l && !commentAbove(lines, l));
        const blocks = new Set(p.targets.filter((t) => t.kind === 'block').map((t) => t.line));
        for (const line of symbols) assert.ok(blocks.has(line), `${file}: line ${line}`);
      }
      if (level === 'medium') assert.ok(p.targets.filter((t) => t.what === 'block').every((t) => t.score >= 2), `${file}: medium takes the most complex blocks`);
    }
  }
});

test('a comment written for each target is never dropped for its place, the level, or the gap', () => {
  for (const [file, text] of Object.entries(FILES)) {
    for (const level of ['low', 'medium', 'heavy']) {
      const { targets } = plan(file, level);
      const proposals = targets.map((t) => ({ line: t.line, text: 'Keeps bounds in scene units, since zoom changes.', kind: t.kind }));
      const result = applyProposals({ text, language: languageForPath(file), level, proposals });
      assert.deepStrictEqual(result.stats.dropped.placement, {}, `${file} ${level}`);
      assert.deepStrictEqual(result.stats.dropped.density, {}, `${file} ${level}`);
      assert.strictEqual(result.added, targets.length, `${file} ${level}`);
      // Each comment sits directly above the line it was written for.
      const out = linesOf(result.text);
      const original = linesOf(text);
      let shift = 0;
      for (const t of [...targets].sort((a, b) => a.line - b.line)) {
        const at = out.indexOf(original[t.line - 1], t.line - 1 + shift);
        assert.ok(/^\s*(\/\/|\*\/)/.test(out[at - 1]), `${file} ${level}: above line ${t.line}`);
        shift = at - t.line + 1;
      }
    }
  }
});

test('Python: functions and classes from ast, public names, and complex blocks', { skip: !findPython() }, () => {
  const text = [
    'import re',
    '',
    'PATTERN = re.compile(r"^#[0-9a-f]{6}$")',
    '',
    '',
    'def luminance(color):',
    '    match = PATTERN.match(color)',
    '    rgb = int(match.group(0)[1:], 16)',
    '    return ((rgb >> 16) & 0xFF) * 0.299',
    '',
    '',
    'def _private(rows):',
    '    for row in rows:',
    '        for cell in row:',
    '            if cell and cell.value and not cell.hidden and cell.kind == "number":',
    '                yield cell',
    '',
    '',
    '# Already documented.',
    'def documented():',
    '    return re.sub(r"\\s+", " ", "a  b")',
    '',
  ].join('\n');
  const p = planTargets({ path: 'colors.py', text, level: 'heavy' });
  const byLine = new Map(p.targets.map((t) => [t.line, t]));
  assert.strictEqual(byLine.get(6).what, 'function');
  assert.strictEqual(byLine.get(6).exported, true);
  assert.strictEqual(byLine.get(12).exported, false);
  assert.ok(!byLine.has(20), 'documented() has a comment');
  const blocks = parsedTargets(p.ctx).blocks;
  const features = (line) => (blocks.find((b) => b.line === line) || {}).features;
  assert.deepStrictEqual(features(9), ['bitwise math', 'the numbers 16, 255, 0.299']);
  assert.deepStrictEqual(features(15), ['nested 3 levels deep', 'a condition with 4 parts']);
  assert.deepStrictEqual(features(21), ['a regular expression']);
});

test('one run gives a file at most 3, 8, or 20 new comments, its highest-ranked targets, and a later batch the next ones', () => {
  const file = 'packages/element/src/snapping.ts';
  const text = FILES[file];
  const language = languageForPath(file);
  const exportNames = fileStructure(file, text, language).exports;
  assert.deepStrictEqual(PER_RUN, { low: 3, medium: 8, heavy: 20 });
  for (const level of ['medium', 'heavy']) {
    const p = plan(file, level);
    assert.strictEqual(p.targets.length, PER_RUN[level]);
    // The highest-ranked: ranks 0 to cap - 1 of every target the file has room for.
    const all = chooseTargets(p.ctx, level, { exportNames });
    assert.strictEqual(p.more, all.length - PER_RUN[level]);
    assert.deepStrictEqual(p.targets.map((t) => t.rank).sort((a, b) => a - b), [...Array(PER_RUN[level]).keys()]);
    // The requests ask for them best first.
    assert.deepStrictEqual(p.planned.flatMap((r) => r.targets.map((t) => t.rank)), [...Array(PER_RUN[level]).keys()]);
  }
  // At heavy, block comments on declarations count toward the 20.
  const heavy = plan(file, 'heavy');
  assert.ok(heavy.targets.every((t) => t.kind === 'block'), 'the 20 best at heavy are all declarations here');

  // The next batch: with this run's comments in the file and recorded as Docturnal's, the
  // file's next-ranked targets come up, and none twice.
  const first = plan(file, 'medium');
  const applied = applyProposals({ text, language, level: 'medium', proposals: first.targets.map((t) => ({ line: t.line, text: 'Keeps bounds in scene units, since zoom changes.', kind: t.kind })) });
  assert.strictEqual(applied.added, 8);
  const second = planTargets({ path: file, text: applied.text, level: 'medium', records: applied.records, exportNames });
  assert.strictEqual(second.targets.length, 8);
  const names = (p) => p.targets.map((t) => t.name || `${t.in}:${t.features}`);
  assert.deepStrictEqual(names(second).filter((n) => names(first).includes(n)), []);
  assert.strictEqual(second.more, first.more - 8);
  // Low takes 3.
  assert.strictEqual(plan('packages/excalidraw/clipboard.ts', 'low').targets.length <= 3, true);
});

test('medium takes only the most complex blocks, with room to spare; heavy takes every one', () => {
  const fn = (name, special) => [`function ${name}(values) {`, '  let total = 0;', '  const a = total + 1;', '  const b = a + 1;', special, '  const c = b + 1;', '  const d = c + 1;', '  return { total, d };', '}', ''];
  // Two short private functions: room for 2 comments at medium, and neither is a declaration
  // target there. One has a lone magic number (score 1), the other bitwise math (score 3).
  const text = [...fn('scale', '  const scaled = total * 60;'), ...fn('pack', '  const flags = (b << 2) | 1;')].join('\n');
  const medium = planTargets({ path: 'pack.ts', text, level: 'medium' }).targets;
  assert.deepStrictEqual(medium.map((t) => [t.line, t.what, t.score]), [[15, 'block', 3]]);
  const heavy = planTargets({ path: 'pack.ts', text, level: 'heavy' }).targets;
  assert.deepStrictEqual(heavy.filter((t) => t.what === 'block').map((t) => t.line), [5, 15]);
});

test('a language without a parser: declarations from the patterns, blocks from each line', () => {
  const text = [
    'package color',
    '',
    'func Luminance(rgb int) float64 {',
    '\tr := (rgb >> 16) & 0xff',
    '\treturn float64(r) * 0.299',
    '}',
    '',
  ].join('\n');
  const p = planTargets({ path: 'color.go', text, level: 'heavy' });
  assert.deepStrictEqual(p.targets.map((t) => [t.line, t.what, t.kind]), [[3, 'function', 'block'], [4, 'block', 'line']]);
  assert.deepStrictEqual(p.targets[1].features, ['bitwise math', 'the numbers 16, 0xff']);
  // The language is known by its id too.
  assert.strictEqual(languageById('go').name, 'Go');
});
