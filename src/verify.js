'use strict';

// Proves that inserting comments did not change the program.

const ts = require('typescript');
const { verifyPython } = require('./python');

const TS_FILE_NAMES = { JS: 'file.js', JSX: 'file.jsx', TS: 'file.ts', TSX: 'file.tsx' };
const SCRIPT_KINDS = { JS: ts.ScriptKind.JS, JSX: ts.ScriptKind.JSX, TS: ts.ScriptKind.TS, TSX: ts.ScriptKind.TSX };

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Splits into raw lines, each keeping its own line ending.
function rawLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [];
}

// Removes the lines we inserted and requires the exact original back.
function rebuildsOriginal(original, candidate, insertedIndices) {
  const skip = new Set(insertedIndices);
  const rebuilt = rawLines(stripBom(candidate)).filter((_, i) => !skip.has(i)).join('');
  return rebuilt === stripBom(original);
}

function transpile(text, fileName) {
  return ts.transpileModule(text, {
    fileName,
    reportDiagnostics: false,
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      isolatedModules: true,
      sourceMap: false,
    },
  }).outputText;
}

// The syntax tree without positions or comments. This also covers type-only code,
// which transpiling erases.
function shape(text, fileName, scriptKind) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const out = [];
  const visit = (node) => {
    out.push(node.kind);
    if (node.kind !== ts.SyntaxKind.SourceFile && typeof node.text === 'string') out.push(node.text);
    if (typeof node.rawText === 'string') out.push(node.rawText);
    ts.forEachChild(node, visit);
    out.push(-1);
  };
  visit(sf);
  return { tree: JSON.stringify(out), errors: sf.parseDiagnostics.length };
}

function makeTypeScriptChecker(original, language) {
  const fileName = TS_FILE_NAMES[language.scriptKind];
  const scriptKind = SCRIPT_KINDS[language.scriptKind];
  const expectedOutput = transpile(original, fileName);
  const expectedShape = shape(original, fileName, scriptKind);
  return (candidate) => {
    if (transpile(candidate, fileName) !== expectedOutput) return false;
    const candidateShape = shape(candidate, fileName, scriptKind);
    return candidateShape.tree === expectedShape.tree && candidateShape.errors <= expectedShape.errors;
  };
}

// candidates: [{ text, inserted }] where inserted lists the line indices we added.
// Returns one boolean per candidate.
function verifyCandidates(language, original, candidates) {
  const results = candidates.map((c) => rebuildsOriginal(original, c.text, c.inserted));
  if (language.verifier === 'typescript') {
    const check = makeTypeScriptChecker(original, language);
    return results.map((ok, i) => ok && check(candidates[i].text));
  }
  if (language.verifier === 'python') {
    const pending = candidates.filter((_, i) => results[i]);
    if (!pending.length) return results;
    let parsed;
    try {
      parsed = verifyPython(stripBom(original), pending.map((c) => stripBom(c.text)));
    } catch {
      return results.map(() => false);
    }
    let next = 0;
    return results.map((ok) => ok && parsed[next++] === true);
  }
  return results;
}

module.exports = { rebuildsOriginal, verifyCandidates };
