'use strict';

// Works out per-line facts the comment engine needs: which lines are blank, comments,
// imports, or declarations, and which lines start inside a string, template literal,
// JSX, or block comment (where an inserted comment would change the program).

const ts = require('typescript');
const { analyzePython } = require('./python');

const SCRIPT_KINDS = {
  JS: [ts.ScriptKind.JS, 'js'],
  JSX: [ts.ScriptKind.JSX, 'jsx'],
  TS: [ts.ScriptKind.TS, 'ts'],
  TSX: [ts.ScriptKind.TSX, 'tsx'],
};

// Splits text into lines, keeping each line's own ending so the file can be rebuilt exactly.
function splitLines(text) {
  const lines = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    lines.push({ text: text.slice(last, match.index), eol: match[0] });
    last = re.lastIndex;
  }
  if (last < text.length) lines.push({ text: text.slice(last), eol: '' });
  return lines;
}

function lineStarts(lines) {
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.text.length + line.eol.length;
  }
  return starts;
}

// Index of the line containing pos.
function lineIndexAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function baseInfo(lines) {
  return lines.map((line) => ({
    blank: line.text.trim() === '',
    commentOnly: false,
    hasComment: false,
    unsafeStart: false,
    isImport: false,
    isDeclaration: false,
  }));
}

function unwrapExpression(node) {
  while (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

// Functions, classes, and wrapped components such as memo(() => ...) or forwardRef(function ...).
function isFunctionLike(node) {
  node = unwrapExpression(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return true;
  if (ts.isCallExpression(node)) return node.arguments.some(isFunctionLike);
  return false;
}

function isRequireCall(node) {
  node = unwrapExpression(node);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

const UNSAFE_KINDS = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral,
  // Inside JSX, a new line of "// text" would render as text, so whole elements are off limits.
  ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxElement, ts.SyntaxKind.JsxSelfClosingElement, ts.SyntaxKind.JsxFragment,
]);

function analyzeTypeScript(text, lines, language) {
  const [scriptKind, extension] = SCRIPT_KINDS[language.scriptKind];
  const sf = ts.createSourceFile(`file.${extension}`, text, ts.ScriptTarget.Latest, true, scriptKind);
  const starts = lineStarts(lines);
  const lineOf = (pos) => lineIndexAt(starts, pos);
  const info = baseInfo(lines);
  const decoratorTarget = new Map();
  const unsafeRanges = [];
  const commentRanges = [];
  const seenComments = new Set();
  const shebangEnd = text.startsWith('#!') ? lines[0].text.length : 0;

  // Every comment sits in the trivia before some token, so scanning each token's leading
  // trivia finds all of them. JSX text has no trivia; its content only looks like it.
  const collectComments = (pos) => {
    for (const range of ts.getLeadingCommentRanges(text, pos) || []) {
      if (range.pos < shebangEnd || seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      commentRanges.push([range.pos, range.end]);
    }
  };
  const visitTokens = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.JsxText) collectComments(node.pos);
      return;
    }
    children.forEach(visitTokens);
  };
  visitTokens(sf);

  const markLines = (node, field) => {
    for (let l = lineOf(node.getStart(sf)); l <= lineOf(Math.max(node.getStart(sf), node.end - 1)); l++) {
      info[l][field] = true;
    }
  };
  const markDeclaration = (node) => {
    info[lineOf(node.getStart(sf))].isDeclaration = true;
  };

  const walk = (node) => {
    const kind = node.kind;
    if (UNSAFE_KINDS.has(kind)) {
      unsafeRanges.push([node.getStart(sf), node.end]);
    } else if (DECLARATION_KINDS.has(kind)) {
      markDeclaration(node);
    } else if (kind === ts.SyntaxKind.ImportDeclaration || kind === ts.SyntaxKind.ImportEqualsDeclaration) {
      markLines(node, 'isImport');
    } else if (kind === ts.SyntaxKind.ExportDeclaration && node.moduleSpecifier) {
      markLines(node, 'isImport');
    } else if (ts.isVariableStatement(node)) {
      const declarations = node.declarationList.declarations;
      if (declarations.some((d) => d.initializer && isRequireCall(d.initializer))) markLines(node, 'isImport');
      else if (declarations.some((d) => d.initializer && isFunctionLike(d.initializer))) markDeclaration(node);
    } else if (ts.isExpressionStatement(node)) {
      const expr = node.expression;
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFunctionLike(expr.right)) {
        markDeclaration(node);
      } else if (isRequireCall(expr)) {
        markLines(node, 'isImport');
      }
    } else if (ts.isExportAssignment(node) && isFunctionLike(node.expression)) {
      markDeclaration(node);
    } else if ((ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && isFunctionLike(node.initializer)) {
      markDeclaration(node);
    }

    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (decorators && decorators.length) {
      const first = lineOf(decorators[0].getStart(sf));
      const anchor = node.name ? node.name.getStart(sf) : decorators[decorators.length - 1].end;
      for (let l = first + 1; l <= lineOf(anchor); l++) decoratorTarget.set(l + 1, first + 1);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  for (const [s, e] of unsafeRanges.concat(commentRanges)) {
    for (let l = lineOf(s) + 1; l < lines.length && starts[l] < e; l++) info[l].unsafeStart = true;
  }

  commentRanges.sort((a, b) => a[0] - b[0]);
  for (const [s, e] of commentRanges) {
    for (let l = lineOf(s); l <= lineOf(Math.max(s, e - 1)); l++) info[l].hasComment = true;
  }
  const inComment = (pos) => {
    let lo = 0;
    let hi = commentRanges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = commentRanges[mid];
      if (pos < s) hi = mid - 1;
      else if (pos >= e) lo = mid + 1;
      else return true;
    }
    return false;
  };
  lines.forEach((line, l) => {
    if (!info[l].hasComment) return;
    if (info[l].blank) {
      info[l].commentOnly = true;
      return;
    }
    const first = starts[l] + line.text.search(/\S/);
    const last = starts[l] + line.text.trimEnd().length - 1;
    info[l].commentOnly = inComment(first) && inComment(last);
  });

  return { ok: true, info, decoratorTarget, parseErrors: sf.parseDiagnostics.length };
}

function analyzePythonLines(text, lines) {
  if (/\r(?!\n)/.test(text)) {
    return { ok: false, error: 'Python files with bare CR line endings are not supported' };
  }
  let result;
  try {
    result = analyzePython(text);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!result.ok) return { ok: false, error: result.error };

  const info = baseInfo(lines);
  const at = (lineNumber) => info[lineNumber - 1];
  for (const n of result.continued) if (at(n)) at(n).unsafeStart = true;
  for (const n of result.comments) if (at(n)) at(n).hasComment = true;
  for (const n of result.imports) if (at(n)) at(n).isImport = true;
  for (const n of result.declarations) if (at(n)) at(n).isDeclaration = true;
  lines.forEach((line, l) => {
    info[l].commentOnly = !info[l].unsafeStart && line.text.trimStart().startsWith('#');
  });

  const decoratorTarget = new Map();
  for (const [first, defLine] of result.decorated) {
    for (let n = first + 1; n <= defLine; n++) decoratorTarget.set(n, first);
  }
  return { ok: true, info, decoratorTarget };
}

function matchToken(tokens, text, pos) {
  for (const token of tokens) {
    if (token.needsSpaceBefore && pos > 0 && !/\s/.test(text[pos - 1])) continue;
    token.re.lastIndex = pos;
    const match = token.re.exec(text);
    if (match) return { token, match };
  }
  return null;
}

function heredocEnds(lineText, terminator) {
  const trimmed = lineText.trim();
  return trimmed.startsWith(terminator) && /^[\s;,)\].]*$/.test(trimmed.slice(terminator.length));
}

// A small lexer for languages checked by placement rules only. It tracks strings,
// block comments, and heredocs across lines.
function analyzeGeneric(lines, language) {
  const info = baseInfo(lines);
  const tokens = language.tokens || [];
  const lineBlocks = language.lineBlocks || [];
  let state = null;
  let pendingHeredocs = [];

  lines.forEach((line, l) => {
    const text = line.text;
    const li = info[l];
    li.unsafeStart = state !== null;

    if (state && state.kind === 'heredoc') {
      if (heredocEnds(text, state.queue[0])) {
        state.queue.shift();
        if (!state.queue.length) state = null;
      }
      return;
    }
    if (state && state.kind === 'lineBlock') {
      li.hasComment = true;
      li.commentOnly = true;
      if (state.close.test(text)) state = null;
      return;
    }
    if (!state) {
      const block = lineBlocks.find((b) => b.open.test(text));
      if (block) {
        li.hasComment = true;
        li.commentOnly = true;
        if (!block.close.test(text)) state = { kind: 'lineBlock', close: block.close };
        return;
      }
    }

    let sawComment = state !== null && state.kind === 'block';
    let sawCode = state !== null && state.kind === 'string';
    let pos = 0;
    while (pos < text.length) {
      if (state) {
        if (state.kind === 'string') sawCode = true;
        if (state.escape && text[pos] === state.escape) {
          pos += 2;
          continue;
        }
        if (text.startsWith(state.close, pos)) {
          pos += state.close.length;
          state = null;
          continue;
        }
        pos++;
        continue;
      }
      if (/\s/.test(text[pos])) {
        pos++;
        continue;
      }
      const found = matchToken(tokens, text, pos);
      if (!found) {
        sawCode = true;
        pos++;
        continue;
      }
      const { token, match } = found;
      const close = typeof token.close === 'function' ? token.close(match) : token.close;
      pos += match[0].length;
      if (token.kind === 'line') {
        sawComment = true;
        break;
      } else if (token.kind === 'block') {
        sawComment = true;
        state = { kind: 'block', close };
      } else if (token.kind === 'string') {
        sawCode = true;
        state = { kind: 'string', close, escape: token.escape, multiline: token.multiline };
      } else if (token.kind === 'heredoc') {
        sawCode = true;
        pendingHeredocs.push(token.terminator(match));
      } else {
        sawCode = true;
      }
    }

    if (state && state.kind === 'string' && !state.multiline) state = null;
    if (!state && pendingHeredocs.length) {
      state = { kind: 'heredoc', queue: pendingHeredocs };
      pendingHeredocs = [];
    }
    li.hasComment = sawComment;
    li.commentOnly = sawComment && !sawCode;
  });

  // A line after a backslash continuation belongs to the previous statement (C macros, shell).
  for (let l = 1; l < lines.length; l++) {
    if (!info[l - 1].commentOnly && /\\$/.test(lines[l - 1].text)) info[l].unsafeStart = true;
  }

  let inImportBlock = false;
  lines.forEach((line, l) => {
    const trimmed = line.text.trim();
    if (info[l].unsafeStart || info[l].commentOnly) return;
    if (language.importBlock) {
      if (inImportBlock) {
        info[l].isImport = true;
        if (language.importBlock.close.test(trimmed)) inImportBlock = false;
        return;
      }
      if (language.importBlock.open.test(trimmed)) {
        info[l].isImport = true;
        inImportBlock = true;
        return;
      }
    }
    if ((language.imports || []).some((re) => re.test(trimmed))) info[l].isImport = true;
    else if ((language.declarations || []).some((re) => re.test(trimmed))) info[l].isDeclaration = true;
  });

  return { ok: true, info, decoratorTarget: new Map() };
}

// Returns { ok, error, info[], decoratorTarget } where info is indexed by line - 1 and
// decoratorTarget maps a declaration line to the first decorator line above it.
function analyzeLines(text, lines, language) {
  if (language.verifier === 'typescript') return analyzeTypeScript(text, lines, language);
  if (language.verifier === 'python') return analyzePythonLines(text, lines);
  return analyzeGeneric(lines, language);
}

module.exports = { analyzeLines, lineStarts, splitLines };
