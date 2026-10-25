'use strict';

// A file's structure, read with parsers instead of a model: what it exports, its functions
// and classes, what it imports, and its leading comment. The documentation pass sends this
// digest, not the code, so one model call can describe a whole folder.

const path = require('path');

const { importSpecifiers } = require('./importance');

const JS_TS = /\.(c|m)?(j|t)sx?$/i;
const MAX_NAMES = 12;
const MAX_LEADING = 200;

// Declarations in other languages, by their usual keywords.
const DECLARATIONS = [
  { kind: 'class', pattern: /^\s*(?:export\s+|public\s+|pub(?:\([^)]*\))?\s+|abstract\s+|final\s+|sealed\s+|data\s+|open\s+)*(?:class|struct|trait|interface|enum|record|protocol|object|module|type)\s+([A-Za-z_]\w*)/ },
  { kind: 'function', pattern: /^\s*(?:export\s+|public\s+|pub(?:\([^)]*\))?\s+|async\s+|static\s+|private\s+|protected\s+|override\s+|suspend\s+|inline\s+)*(?:def|fn|func|fun|function|sub|procedure)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
];

function uniqueNames(names) {
  return [...new Set(names.filter(Boolean))].slice(0, MAX_NAMES);
}

// JavaScript and TypeScript: top-level declarations and exports, from the TypeScript parser.
function jsStructure(file, text) {
  const ts = require('typescript');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const exported = [];
  const functions = [];
  const classes = [];
  const isExported = (node) => (ts.getCombinedModifierFlags ? ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export : 0) !== 0;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.push(statement.name.text);
      if (isExported(statement)) exported.push(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      classes.push(statement.name.text);
      if (isExported(statement)) exported.push(statement.name.text);
    } else if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && isExported(statement)) {
      exported.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) functions.push(declaration.name.text);
        if (isExported(statement)) exported.push(declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.push(element.name.text);
    } else if (ts.isExportAssignment(statement)) {
      exported.push('default');
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      // CommonJS: module.exports = { a, b } or exports.name = ...
      const left = statement.expression.left.getText(source);
      const right = statement.expression.right;
      if (left === 'module.exports' && ts.isObjectLiteralExpression(right)) {
        for (const property of right.properties) if (property.name && ts.isIdentifier(property.name)) exported.push(property.name.text);
      } else {
        const named = left.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
        if (named) exported.push(named[1]);
      }
    }
  }
  return { exports: uniqueNames(exported), functions: uniqueNames(functions), classes: uniqueNames(classes) };
}

function patternStructure(text, language) {
  const functions = [];
  const classes = [];
  const exported = [];
  for (const line of text.split('\n').slice(0, 4000)) {
    for (const { kind, pattern } of DECLARATIONS) {
      const match = line.match(pattern);
      if (!match) continue;
      (kind === 'class' ? classes : functions).push(match[1]);
      // Top-level, public names count as exports: Python's module-level names without a
      // leading underscore, and pub or export declarations elsewhere.
      const topLevel = !/^\s/.test(line);
      if ((topLevel && language && language.id === 'python' && !match[1].startsWith('_')) || /\b(export|pub|public)\b/.test(line)) exported.push(match[1]);
      break;
    }
  }
  return { exports: uniqueNames(exported), functions: uniqueNames(functions), classes: uniqueNames(classes) };
}

const COMMENT_LINE = /^\s*(\/\/+|#+(?!!)|--|;+|%+|\*+(?!\/)|\/\*+|"""|''')\s?/;

// The comment at the top of the file, after a shebang, an encoding line, or "use strict",
// without its markers.
function leadingComment(text) {
  const lines = text.split('\n').slice(0, 40);
  let i = 0;
  while (i < lines.length && (/^#!/.test(lines[i]) || /coding[:=]/.test(lines[i]) || /^\s*['"]use strict['"];?\s*$/.test(lines[i]) || !lines[i].trim())) i++;
  const out = [];
  let inBlock = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && !COMMENT_LINE.test(line)) break;
    if (/^\s*(\/\*|"""|''')/.test(line) && !/(\*\/|"""|''')\s*$/.test(line.trim().slice(3))) inBlock = true;
    if (inBlock && /(\*\/|"""|''')\s*$/.test(line) && !/^\s*(\/\*|"""|''')\s*$/.test(line)) inBlock = false;
    const cleaned = line.replace(COMMENT_LINE, '').replace(/\*+\/\s*$|"""\s*$|'''\s*$/, '').trim();
    if (!cleaned && out.length) break;
    if (cleaned) out.push(cleaned);
  }
  const joined = out.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, MAX_LEADING) : null;
}

// The first line of real code, for a file without a leading comment.
function firstCodeLine(text) {
  for (const line of text.split('\n').slice(0, 60)) {
    const trimmed = line.trim();
    if (trimmed && !COMMENT_LINE.test(line) && !/^['"]use strict['"]/.test(trimmed) && !/^(import|from|require|using|package|#include)\b/.test(trimmed)) return trimmed.slice(0, 100);
  }
  return null;
}

// Returns { exports, functions, classes, imports, leading, firstLine }.
function fileStructure(file, text, language) {
  let names;
  try {
    names = JS_TS.test(file) ? jsStructure(file, text) : patternStructure(text, language);
  } catch {
    names = patternStructure(text, language);
  }
  let imports = [];
  try {
    imports = importSpecifiers(file, text).slice(0, 40);
  } catch {
    // No imports read: the digest just leaves them out.
  }
  const leading = leadingComment(text);
  return { ...names, imports, leading, firstLine: leading ? null : firstCodeLine(text) };
}

// The main names of a file, for its state entry's symbols.
function symbolsOf(structure) {
  return uniqueNames([...structure.exports, ...structure.classes, ...structure.functions]);
}

// A plain description built only from the structure, for a file the model left out.
function structuralSummary(file, structure) {
  if (structure.leading) {
    const sentence = structure.leading.match(/^.*?[.!?](\s|$)/);
    return (sentence ? sentence[0] : structure.leading).trim();
  }
  const names = symbolsOf(structure).slice(0, 4);
  return names.length ? `Defines ${names.map((n) => `\`${n}\``).join(', ')}.` : null;
}

module.exports = { fileStructure, leadingComment, structuralSummary, symbolsOf, basename: (file) => path.posix.basename(file) };
