'use strict';

// A layer doc's Configuration section, computed from the code, never written by a model: the
// environment variables its files read, the action inputs they read, and the configuration
// files they name or that sit in their folders. A layer that reads none has no section.

const path = require('path');

// Ways code reads an environment variable, by language.
const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
  // An env object or binding, such as a Cloudflare Worker's env.API_KEY.
  /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
  /\benv\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
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
// Configuration files by name: when one sits in a layer's folder, or the folder above, it
// configures that layer.
const CONFIG_FILE = /^(wrangler\.(toml|json|jsonc)|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.env\.example|pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml|[\w-]+\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|\.babelrc|\.npmrc)$/;
// A file name in a string literal, such as 'settings.json' or "config/app.toml".
const NAMED_FILE = /['"`]((?:[\w.-]+\/)*[\w.-]+\.(?:json|jsonc|ya?ml|toml|ini|cfg|conf|env))['"`]/g;

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
    for (const pattern of ENV_PATTERNS) for (const m of text.matchAll(pattern)) envVars.add(m[1]);
    if (/\bINPUT_|\bgetInput\(/.test(text)) readsInputs = true;
    for (const m of text.matchAll(NAMED_FILE)) named.add(path.posix.basename(m[1]));
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

module.exports = { actionInputs, configurationSection, layerConfiguration };
