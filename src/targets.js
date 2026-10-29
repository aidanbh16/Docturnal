'use strict';

// Where comments go, chosen by code before any model is asked. The parsers list the spots
// that need one: functions, methods, classes, and exported declarations with no comment
// directly above them, and complex blocks (nesting 3 levels deep, regular expressions,
// bitwise math, magic numbers other than 0, 1, and -1, and long boolean conditions). They are
// ranked, exported and widely used declarations first, then by size and complexity, and only
// as many are kept as the comment level leaves room for in the file, counting the comments
// already there. The model then writes one comment per target, and never chooses a line.

const ts = require('typescript');

const { lineStarts, lineIndexAt } = require('./analyze');
const { runHelper } = require('./python');

// A block's score: what it holds that a reader needs explained. Medium level asks for blocks
// that score at least MEDIUM_BLOCK_SCORE, heavy for every block.
const FEATURE_SCORES = { nested: 2, regex: 2, bitwise: 2, condition: 2, magic: 1 };
const MEDIUM_BLOCK_SCORE = 2;
// At medium, a declaration that is neither exported nor used elsewhere is still a target when
// it is at least this long; at low, only when it is at least LOW_LINES long.
const MEDIUM_LINES = 15;
const LOW_LINES = 30;
// A condition with at least this many logical operators (4 parts) is long, and so is one with
// 2 operators and more than LONG_CONDITION_CHARS characters.
const LONG_CONDITION_OPERATORS = 3;
const LONG_CONDITION_CHARS = 80;
// Control statements this deep, counted within their function, are a nested block.
const NESTED_DEPTH = 3;

const CONTROL_KINDS = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.TryStatement,
]);
const STATEMENT_KINDS = new Set([
  ...CONTROL_KINDS, ts.SyntaxKind.Block, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.CaseBlock,
]);
const LIST_PARENTS = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.CaseClause, ts.SyntaxKind.DefaultClause]);
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);
const BITWISE_KINDS = new Set([
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
const LOGICAL_KINDS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
// Exported declarations that are not functions or classes, which medium and heavy level comment.
const TYPE_KINDS = new Set([ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration]);

// The features of one statement, without its nested statements and block-bodied functions,
// which are statements of their own: { regex, bitwise, magic: [numbers], operators, conditionChars }.
function emptyFeatures() {
  return { regex: false, bitwise: false, magic: [], operators: 0, conditionChars: 0 };
}

function isNumberLiteral(node) {
  return ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand));
}

// A statement that only names a number, such as `const padding = 8;`, is its own explanation.
function namesANumber(node) {
  return ts.isVariableStatement(node) && node.declarationList.declarations.every((d) => d.initializer && isNumberLiteral(d.initializer));
}

function scriptFeatures(statement, sf) {
  const found = emptyFeatures();
  if (namesANumber(statement)) return found;
  const visit = (node) => {
    if (node !== statement && (STATEMENT_KINDS.has(node.kind) || (FUNCTION_KINDS.has(node.kind) && node.body && ts.isBlock(node.body)))) return;
    if (ts.isRegularExpressionLiteral(node)) found.regex = true;
    else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') found.regex = true;
    else if (ts.isBinaryExpression(node) && BITWISE_KINDS.has(node.operatorToken.kind)) found.bitwise = true;
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.TildeToken) found.bitwise = true;
    else if (ts.isNumericLiteral(node)) {
      const value = Number(node.text.replace(/_/g, ''));
      if (value !== 0 && value !== 1 && !found.magic.includes(node.getText(sf))) found.magic.push(node.getText(sf));
    }
    if (ts.isBinaryExpression(node) && LOGICAL_KINDS.has(node.operatorToken.kind)) {
      found.operators++;
      // The whole condition: the outermost logical expression.
      if (!(ts.isBinaryExpression(node.parent) && LOGICAL_KINDS.has(node.parent.operatorToken.kind))) {
        found.conditionChars = Math.max(found.conditionChars, node.getText(sf).length);
      }
    }
    ts.forEachChild(node, visit);
  };
  // A control statement's own head only: its nested statements are visited on their own.
  ts.forEachChild(statement, visit);
  return found;
}

// The labels and score of a statement's features, or null when it has none.
function describeFeatures(found, depth) {
  const features = [];
  let score = 0;
  if (depth >= NESTED_DEPTH) {
    features.push(`nested ${depth} levels deep`);
    score += FEATURE_SCORES.nested;
  }
  if (found.regex) {
    features.push('a regular expression');
    score += FEATURE_SCORES.regex;
  }
  if (found.bitwise) {
    features.push('bitwise math');
    score += FEATURE_SCORES.bitwise;
  }
  const long = found.operators >= LONG_CONDITION_OPERATORS || (found.operators >= 2 && found.conditionChars > LONG_CONDITION_CHARS);
  if (long) {
    features.push(`a condition with ${found.operators + 1} parts`);
    score += FEATURE_SCORES.condition;
  }
  if (found.magic.length) {
    const shown = found.magic.slice(0, 4);
    features.push(`the ${found.magic.length === 1 ? 'number' : 'numbers'} ${shown.join(', ')}${found.magic.length > shown.length ? ', and more' : ''}`);
    score += FEATURE_SCORES.magic + (found.magic.length >= 3 ? 1 : 0);
  }
  return features.length ? { features, score } : null;
}

// JavaScript and TypeScript: the complex blocks inside functions, and the exported types,
// interfaces, enums, and constants. Lines are counted from 1.
function scriptTargets(body, lines, language) {
  const kind = { JS: ts.ScriptKind.JS, JSX: ts.ScriptKind.JSX, TS: ts.ScriptKind.TS, TSX: ts.ScriptKind.TSX }[language.scriptKind];
  const sf = ts.createSourceFile('file', body, ts.ScriptTarget.Latest, true, kind);
  const starts = lineStarts(lines);
  const lineOf = (pos) => lineIndexAt(starts, pos) + 1;
  // A statement can take a comment only when it starts its line.
  const startsLine = (node) => {
    const start = node.getStart(sf);
    const line = lineOf(start);
    return starts[line - 1] + lines[line - 1].text.search(/\S/) === start ? line : null;
  };
  const blocks = [];
  const exported = [];
  const isExported = (node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node, depth, fn) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : fn;
      ts.forEachChild(node, (child) => visit(child, 0, name || fn || 'an anonymous function'));
      return;
    }
    if (node.parent === sf && TYPE_KINDS.has(node.kind) && isExported(node) && node.name) {
      exported.push({ line: lineOf(node.getStart(sf)), end: lineOf(node.end - 1), name: node.name.text, what: 'type' });
    } else if (node.parent === sf && ts.isVariableStatement(node) && isExported(node)) {
      const names = node.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text);
      if (names.length) exported.push({ line: lineOf(node.getStart(sf)), end: lineOf(node.end - 1), name: names[0], what: 'constant' });
    }
    let next = depth;
    const inList = node.parent && (LIST_PARENTS.has(node.parent.kind) || (CONTROL_KINDS.has(node.parent.kind) && STATEMENT_KINDS.has(node.kind) && !ts.isBlock(node)));
    if (fn && STATEMENT_KINDS.has(node.kind) && !ts.isBlock(node) && node.kind !== ts.SyntaxKind.CaseBlock && inList) {
      // An else-if continues its if: it adds no depth.
      const elseIf = ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
      if (CONTROL_KINDS.has(node.kind) && !elseIf) next = depth + 1;
      const described = node.kind === ts.SyntaxKind.FunctionDeclaration || node.kind === ts.SyntaxKind.ClassDeclaration
        ? null
        : describeFeatures(scriptFeatures(node, sf), CONTROL_KINDS.has(node.kind) && !elseIf ? next : 0);
      const line = described && startsLine(node);
      if (line) blocks.push({ line, end: lineOf(Math.max(node.getStart(sf), node.end - 1)), in: fn, ...described });
    }
    ts.forEachChild(node, (child) => visit(child, next, fn));
  };
  visit(sf, 0, null);
  return { blocks, exported };
}

// Python: the same, from `ast` through the Python helper. Public names are the top-level
// functions and classes not starting with "_", or the names in __all__.
function pythonTargets(body) {
  const result = runHelper({ mode: 'targets', source: body });
  if (!result.ok) return { blocks: [], exported: [], publicNames: [] };
  const blocks = result.blocks.map(([line, end, fn, found]) => {
    const described = describeFeatures({ regex: found.regex, bitwise: found.bitwise, magic: found.magic, operators: found.operators, conditionChars: found.chars }, found.depth);
    return described && { line, end, in: fn, ...described };
  }).filter(Boolean);
  return { blocks, exported: [], publicNames: result.public };
}

// Other languages: patterns on each line of code, with strings blanked and the lines the
// lexer marks as comments or inside a string left out. Nesting comes from indentation.
const CONTROL_LINE = /^(?:\}\s*)?(?:if|for|foreach|while|switch|match|loop|case|unless|until|elif|elsif|else\s+if)\b/;
const REGEX_CALL = /\b(?:Regex|regexp\.(?:MustCompile|Compile)|re\.compile|Pattern\.compile|preg_\w+|NSRegularExpression)\s*\(|=~/;
const BITWISE = / (?:<<|>>>?|&|\||\^) |~\w/;
const NUMBER = /(?<![\w.])-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)(?![\w.])/g;
const LOGICAL = /&&|\|\||\band\b|\bor\b/g;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const NAMED_NUMBER = /^(?:#define|(?:(?:export|pub|public|private|static|final|readonly|const|val|let|var|my|local)\s+)+)?[\w<>[\]]*\s*[A-Za-z_]\w*\s*(?::[^=]+)?=\s*-?\d+(?:\.\d+)?\s*;?$/;

function genericTargets(lines, info) {
  const blocks = [];
  const stack = [];
  let inFunction = null;
  lines.forEach((line, i) => {
    const li = info[i];
    if (li.blank || li.commentOnly || li.unsafeStart) return;
    const indent = line.text.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
    if (li.symbol) {
      inFunction = { name: li.symbol, end: li.symbolEnd === null ? Infinity : li.symbolEnd };
      return;
    }
    if (inFunction && inFunction.end < i) inFunction = null;
    if (!inFunction || li.isDeclaration || li.isImport) return;
    const code = line.text.replace(STRING, '""').trim();
    const control = CONTROL_LINE.test(code);
    const depth = control ? stack.length + 1 : 0;
    if (control) stack.push(indent);
    const found = emptyFeatures();
    found.regex = REGEX_CALL.test(code);
    found.bitwise = BITWISE.test(code);
    found.operators = (code.match(LOGICAL) || []).length;
    found.conditionChars = code.length;
    if (!NAMED_NUMBER.test(code)) {
      for (const [n] of code.matchAll(NUMBER)) if (Number(n) !== 0 && Math.abs(Number(n)) !== 1 && !found.magic.includes(n)) found.magic.push(n);
    }
    const described = describeFeatures(found, depth);
    if (described) blocks.push({ line: i + 1, end: i + 1, in: inFunction.name, ...described });
  });
  return { blocks, exported: [] };
}

// The language's targets before ranking: { blocks, exported, publicNames }.
function parsedTargets(ctx) {
  const { language, body, lines, analysis } = ctx;
  try {
    if (language.verifier === 'typescript') return scriptTargets(body, lines, language);
    if (language.verifier === 'python') return pythonTargets(body);
  } catch {
    // A parser that fails here finds no blocks; the declarations still come from the analysis.
    return { blocks: [], exported: [] };
  }
  return genericTargets(lines, analysis.info);
}

module.exports = { FEATURE_SCORES, LOW_LINES, MEDIUM_BLOCK_SCORE, MEDIUM_LINES, describeFeatures, parsedTargets };
