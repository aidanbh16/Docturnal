'use strict';

// A layer doc's Configuration section, computed from the code, never written by a model: the
// environment variables its files read, the action inputs they read, and the configuration
// files they name or that sit in their folders. A layer that reads none has no section.

const path = require('path');

const { LEXER_TOKENS: T, languageForPath } = require('./languages');
const { pythonEnvNames } = require('./python');

// Ways code reads an environment variable, for languages without a parser. They run on the
// code with its comments blanked, so a name in a comment is never listed.
const ENV_PATTERNS = [
  /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /env::var\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /\bENV\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
// Python's tokens, for when its own parser is not available.
const PYTHON_TOKENS = [T.tripleDq, T.tripleSq, T.dq, T.sq, T.hashLine];
// Configuration files by name: when one sits in a layer's folder, or the folder above, it
// configures that layer.
const CONFIG_FILE = /^(wrangler\.(toml|json|jsonc)|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.env\.example|pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml|[\w-]+\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|\.babelrc|\.npmrc)$/;
// A file name in a string literal, such as 'settings.json' or "config/app.toml".
const NAMED_FILE = /['"`]((?:[\w.-]+\/)*[\w.-]+\.(?:json|jsonc|ya?ml|toml|ini|cfg|conf|env))['"`]/g;

// The text with every comment blanked and strings kept, using the language's lexer tokens.
function withoutComments(text, tokens, lineBlocks = []) {
  // Loaded here, not at the top: it loads typescript, and the pre-check must run without it.
  const { matchToken } = require('./analyze');
  const out = [];
  let state = null;
  for (const line of text.split('\n')) {
    if (state && state.kind === 'lineBlock') {
      if (state.close.test(line)) state = null;
      out.push('');
      continue;
    }
    const lineBlock = !state && lineBlocks.find((b) => b.open.test(line));
    if (lineBlock) {
      if (!lineBlock.close.test(line)) state = { kind: 'lineBlock', close: lineBlock.close };
      out.push('');
      continue;
    }
    let kept = '';
    let pos = 0;
    while (pos < line.length) {
      if (state) {
        const inString = state.kind === 'string';
        const escaped = Boolean(state.escape) && line[pos] === state.escape;
        const closes = !escaped && line.startsWith(state.close, pos);
        const step = escaped ? 2 : closes ? state.close.length : 1;
        if (inString) kept += line.slice(pos, pos + step);
        if (closes) state = null;
        pos += step;
        continue;
      }
      const found = matchToken(tokens, line, pos);
      if (!found) {
        kept += line[pos++];
        continue;
      }
      const { token, match } = found;
      if (token.kind === 'line') break;
      const close = typeof token.close === 'function' ? token.close(match) : token.close;
      if (token.kind === 'block') {
        state = { kind: 'block', close };
        kept += ' ';
      } else {
        if (token.kind === 'string') state = { kind: 'string', close, escape: token.escape, multiline: token.multiline };
        kept += match[0];
      }
      pos += match[0].length;
    }
    if (state && state.kind === 'string' && !state.multiline) state = null;
    out.push(kept);
  }
  return out.join('\n');
}

// JavaScript and TypeScript, from the syntax tree: process.env.X, import.meta.env.X, and an
// env object or binding (such as a Worker's env.X or c.env.X), by property or by a quoted key,
// and names taken from one by destructuring. Also the string literals, for file names and
// INPUT_ variables, and whether the code calls getInput.
function scanScript(file, text, language) {
  const ts = require('typescript');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind[language.scriptKind]);
  const envVars = new Set();
  const strings = [];
  let callsGetInput = false;
  const envKind = (node) => {
    const t = node.getText(source).replace(/\s+/g, '');
    if (t === 'process.env' || t === 'import.meta.env') return 'process';
    return /(^|\.)env$/.test(t) ? 'env' : null;
  };
  // A bare env object can be anything, so its names need three characters, as in API_KEY.
  const add = (name, kind) => {
    if (ENV_NAME.test(name) && (kind === 'process' || name.length >= 3)) envVars.add(name);
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const kind = envKind(node.expression);
      if (kind) add(node.name.text, kind);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const kind = envKind(node.expression);
      if (kind) add(node.argumentExpression.text, kind);
    } else if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const kind = envKind(node.initializer);
      if (kind) {
        for (const element of node.name.elements) {
          const key = element.propertyName || element.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) add(key.text, kind);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (name === 'getInput') callsGetInput = true;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { envVars, code: strings.map((s) => `'${s}'`).join('\n'), callsGetInput };
}

// Every other language: the patterns, on the code with its comments blanked. Python's names
// come from its own syntax tree when Python is there.
function scanOther(text, language) {
  const isPython = language && language.verifier === 'python';
  const tokens = isPython ? PYTHON_TOKENS : (language && language.tokens) || [];
  const code = tokens.length ? withoutComments(text, tokens, (language && language.lineBlocks) || []) : text;
  let envVars = null;
  if (isPython && /environ|getenv/.test(code)) {
    try {
      envVars = pythonEnvNames(text);
    } catch {
      envVars = null;
    }
  }
  if (!envVars) envVars = ENV_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[1]));
  return { envVars: new Set(envVars), code, callsGetInput: /\bgetInput\(/.test(code) };
}

function scanFile(file, text) {
  const language = languageForPath(file);
  if (language && language.verifier === 'typescript') {
    try {
      return scanScript(file, text, language);
    } catch {
      return { envVars: new Set(), code: '', callsGetInput: false };
    }
  }
  return scanOther(text, language);
}

// The input names an action.yml at the repository root declares.
function actionInputs(read) {
  const text = read('action.yml') || read('action.yaml');
  if (!text) return [];
  const block = /^inputs:\s*\n((?:(?:[ \t].*)?\n)*)/m.exec(`${text}\n`);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

// layerFiles: the layer's source paths. read(path) returns a file's text, or null.
// allFiles: every tracked path. Returns { envVars, inputs, files }.
function layerConfiguration(layerFiles, read, allFiles) {
  const envVars = new Set();
  const named = new Set();
  let readsInputs = false;
  for (const file of layerFiles) {
    const text = read(file);
    if (typeof text !== 'string') continue;
    const scan = scanFile(file, text);
    for (const name of scan.envVars) envVars.add(name);
    if (scan.callsGetInput || /\bINPUT_/.test(scan.code) || [...scan.envVars].some((n) => n.startsWith('INPUT_'))) readsInputs = true;
    for (const m of scan.code.matchAll(NAMED_FILE)) named.add(path.posix.basename(m[1]));
  }
  const inputs = readsInputs ? actionInputs(read) : [];
  // Inputs reach the code as INPUT_ variables; they are listed once, as inputs.
  for (const name of [...envVars]) if (name.startsWith('INPUT_') && inputs.length) envVars.delete(name);
  const folders = new Set(layerFiles.map((f) => path.posix.dirname(f)));
  const near = new Set([...folders, ...[...folders].map((d) => path.posix.dirname(d))]);
  const files = new Set();
  for (const file of allFiles) {
    const base = path.posix.basename(file);
    const dir = path.posix.dirname(file);
    if (CONFIG_FILE.test(base) && near.has(dir)) files.add(file);
    // A file the code names, found in the repository. Lockfiles and the configuration files
    // above are not counted by name, and package.json only in the layer's own folders.
    else if (named.has(base) && !CONFIG_FILE.test(base) && !/lock/i.test(base) && (base !== 'package.json' || folders.has(dir))) files.add(file);
  }
  return { envVars: [...envVars].sort(), inputs: inputs.sort(), files: [...files].sort() };
}

// The section's Markdown, or '' when the layer reads no configuration.
function configurationSection({ envVars, inputs, files }) {
  const code = (list) => list.map((x) => `\`${x}\``).join(', ');
  const lines = [];
  if (envVars.length) lines.push(`- Environment variables: ${code(envVars)}.`);
  if (inputs.length) lines.push(`- Action inputs: ${code(inputs)}.`);
  if (files.length) lines.push(`- Configuration files: ${code(files)}.`);
  return lines.join('\n');
}

module.exports = { actionInputs, configurationSection, layerConfiguration, scanFile, withoutComments };
