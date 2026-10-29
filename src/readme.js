'use strict';

// The repository's README.md, the main document. People share it with Docturnal, so it
// carries no Docturnal marker, and Docturnal keeps what people add to it or remove from it.
//
// .docturnal/readme.json saves the README as Docturnal last wrote it, split into sections:
// the intro (the text before the first H2) and one section per H2 heading. Each run compares
// the current README with it, section by section:
// - A saved section that is gone was deleted by a person. Its heading is suppressed and never
//   written again, until a person adds it back.
// - A section that changed, or that is new, belongs to a person. Docturnal keeps it byte for
//   byte, apart from the computed blocks inside it.
// - A section that is unchanged keeps its owner. Docturnal regenerates its own sections.
// Computed blocks (the layers table, the scripts table, the directory tree) sit between
// hidden markers, and are refreshed wherever they are, unless a person removed them.

const fs = require('fs');
const path = require('path');

const docs = require('./docs');
const links = require('./links');
const { isPlainPath, requirePlainPath } = require('./safe-path');
const { hashContent } = require('./state');
const { own } = require('./own');

const README_PATH = 'README.md';
const README_STATE_PATH = '.docturnal/readme.json';
const README_STATE_VERSION = 1;
const MAINTAINED = '<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->';

const BLOCK_TITLES = { layers: 'Layers table', scripts: 'Available scripts table', tree: 'Directory tree' };
const BLOCK_RE = /<!-- docturnal:([a-z]+) -->[\s\S]*?<!-- \/docturnal:\1 -->/g;

// The standard sections, in their standard order. A section whose heading is one of the
// aliases counts as that standard section, so a person's "Installation" is the "Getting
// started" section and Docturnal does not add a second one.
const STANDARD = [
  { id: 'intro', title: null, aliases: ['intro'] },
  { id: 'overview', title: 'Overview', aliases: ['overview', 'introduction', 'about', 'what it does', 'features'] },
  { id: 'architecture', title: 'Architecture', aliases: ['architecture', 'design', 'how it works', 'layers', 'documentation', 'docs'], block: 'layers' },
  { id: 'start', title: 'Getting started', aliases: ['getting started', 'quick start', 'quickstart', 'installation', 'install', 'setup', 'usage', 'running', 'prerequisites', 'development'], block: 'scripts' },
  { id: 'structure', title: 'Project structure', aliases: ['project structure', 'structure', 'directory structure', 'folder structure', 'layout', 'project layout'], block: 'tree' },
];
const BLOCK_HOST = Object.fromEntries(STANDARD.filter((s) => s.block).map((s) => [s.block, s.id]));


// --- Parsing ---

function normalizeHeading(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const baseKey = (key) => key.split('#')[0];

// Splits a README into its parts without losing a byte: joining preamble and the text of
// every part gives back the input (with LF line endings). The preamble is the maintenance
// comment and the blank lines after it.
function parseReadme(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const lines = lf.split('\n');
  const withEol = lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
  let i = 0;
  let preamble = '';
  if (lines[0] !== undefined && lines[0].trim() === MAINTAINED) {
    preamble += withEol[0];
    i = 1;
    while (i < lines.length - 1 && !lines[i].trim()) preamble += withEol[i++];
  }
  const raw = [];
  let current = { heading: null, lines: [] };
  let fence = null;
  for (; i < withEol.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1].slice(0, 3);
      else if (line.trim().startsWith(fence)) fence = null;
    }
    const heading = !fence && !fenceMatch && line.match(/^##(?!#)\s+(.*?)\s*#*\s*$/);
    if (heading) {
      raw.push(current);
      current = { heading: heading[1].trim(), lines: [] };
    }
    current.lines.push(withEol[i]);
  }
  raw.push(current);

  const used = new Map();
  const parts = raw.map((part) => {
    const base = part.heading === null ? 'intro' : normalizeHeading(part.heading) || 'section';
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const text = part.lines.join('');
    return { key: n === 1 ? base : `${base}#${n}`, heading: part.heading, text, empty: !text.trim() };
  });
  return { eol: /\r\n/.test(text) ? '\r\n' : '\n', preamble, parts };
}

// Trailing spaces and blank lines do not count as an edit.
function sectionHash(text) {
  return hashContent(text.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim());
}

function standardOf(key) {
  return STANDARD.find((s) => (s.id === 'intro' ? key === 'intro' : s.aliases.includes(baseKey(key))));
}

function standardIndex(key) {
  const std = standardOf(key);
  return std ? STANDARD.indexOf(std) : -1;
}

// --- Computed blocks ---

function renderBlock(name, content) {
  return `<!-- docturnal:${name} -->\n${content ? `${content}\n` : ''}<!-- /docturnal:${name} -->`;
}

function blocksIn(text) {
  return new Set([...String(text || '').matchAll(BLOCK_RE)].map((m) => m[1]));
}

function refreshBlocks(text, blocks) {
  return text.replace(BLOCK_RE, (match, name) => (Object.hasOwn(blocks, name) ? renderBlock(name, blocks[name]) : match));
}

// --- Generated sections ---

// The longest answer for the README's sections, in tokens.
const README_TOKENS = 450;
// How much of the people's own sections the prompt shows, for context.
const PERSON_TEXT_CHARS = 800;

function readmePrompt({ projectName, layers, facts, personText }) {
  // Each layer with its files, or, when that is too long for the prompt, its folders. In a
  // project of parts, each part with the names of its documents.
  const parts = layers.some((l) => l.part);
  let layerList = parts
    ? layers.filter((l) => !l.part).map((p) => {
      const subs = layers.filter((l) => l.part === p.slug).map((l) => l.name);
      return `- ${p.name}: ${p.description}${subs.length ? ` Documents: ${subs.join(', ')}.` : ''}`;
    }).join('\n')
    : layers.map((l) => `- ${l.name}: ${l.description} Files: ${l.files.join(', ')}`).join('\n') || 'None.';
  if (!parts && layerList.length > 1200) {
    layerList = layers.map((l) => {
      const dirs = [...new Set(l.files.map((f) => path.posix.dirname(f)))];
      return `- ${l.name}: ${l.description} ${l.files.length} files, in ${dirs.slice(0, 8).join(', ')}${dirs.length > 8 ? `, and ${dirs.length - 8} more folders` : ''}.`;
    }).join('\n');
  }
  let content = `Write the main documentation page for ${projectName}.

Use exactly this structure:

# ${projectName}

One paragraph that says what the project is and who it is for.

## Overview

## Architecture

One or two short paragraphs on how the layers below work together. Do not write a table: the table of layers is added separately.

## Getting started

Prerequisites, installation, and how to run the project, using only the commands and settings in the project facts. A table of scripts and a list of environment variables are added separately.

Do not add other sections or any table. A project structure section is added separately.

Layers:
${layerList.slice(0, 1500)}

Project facts:
${docs.describeFacts(facts).slice(0, 600)}
`;
  const system = `You write developer documentation.\n\n${docs.STYLE_RULES}`;
  if (personText) {
    const room = Math.min(PERSON_TEXT_CHARS, docs.DOC_PROMPT_CHARS - system.length - content.length - 100);
    if (room > 0) content += `\nSections that the project's people wrote, for context. Do not repeat them:\n${personText.slice(0, room)}\n`;
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: content.slice(0, docs.DOC_PROMPT_CHARS - system.length) },
  ];
}

// The Architecture section's prose: its first paragraphs, without lists, headings, or code.
const ARCHITECTURE_PARAGRAPHS = 2;

function proseParagraphs(text, count) {
  return text.split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(#|[-*+]\s|\d+[.)]\s|```|~~~|>|<!--)/.test(p))
    .slice(0, count)
    .join('\n\n');
}

// The model's prose for the standard sections: { intro, overview, architecture, start }.
function readmeBodies(raw, { projectName, facts, existingPaths, knownUrls, linkStats }) {
  const cleaned = docs.cleanMarkdown(raw, { title: projectName, docPath: README_PATH, existingPaths, knownUrls, linkStats });
  const { intro, sections } = docs.splitSections(cleaned);
  const bodies = docs.arrangeSections(sections, docs.README_SECTIONS, { extrasInto: 'overview', generated: docs.README_GENERATED });
  const { first, rest } = docs.splitIntro(intro);
  return {
    intro: first || facts.description || '',
    overview: [rest, bodies.get('overview')].filter(Boolean).join('\n\n'),
    architecture: proseParagraphs(bodies.get('architecture') || '', ARCHITECTURE_PARAGRAPHS),
    start: docs.removeSubsections(bodies.get('start') || '', ['available scripts', 'scripts', 'environment variables']),
  };
}

function waitingNote(waiting) {
  if (!waiting.length) return '';
  const shown = waiting.slice(0, 10).map((dir) => `\`${dir}\``).join(', ');
  const more = waiting.length > 10 ? `, and ${waiting.length - 10} more` : '';
  return `Not described yet: ${shown}${more}. The next update adds ${waiting.length === 1 ? 'it' : 'them'}.`;
}

function sectionText(title, body) {
  return `## ${title}\n\n${body.trim()}\n`;
}

// The text of a standard section that Docturnal writes, or null when there is nothing to say.
function standardText(id, { prose, blocks, allowBlock, name, facts }) {
  const block = (blockName) => (allowBlock(blockName) && own(blocks, blockName) ? renderBlock(blockName, blocks[blockName]) : '');
  switch (id) {
    case 'intro':
      return prose.intro ? `# ${name}\n\n${prose.intro.trim()}\n` : `# ${name}\n`;
    case 'overview':
      return prose.overview ? sectionText('Overview', prose.overview) : null;
    case 'architecture': {
      const body = [prose.architecture, block('layers')].filter(Boolean).join('\n\n');
      return body ? sectionText('Architecture', body) : null;
    }
    case 'start': {
      const parts = [prose.start];
      const scripts = block('scripts');
      if (scripts) parts.push('### Available scripts', scripts);
      if (facts.envVars.length) {
        parts.push('### Environment variables', '`.env.example` lists these variables:', facts.envVars.map((v) => `- \`${v}\``).join('\n'));
      }
      const body = parts.filter(Boolean).join('\n\n');
      return body ? sectionText('Getting started', body) : null;
    }
    case 'structure': {
      const tree = block('tree');
      return tree ? sectionText('Project structure', tree) : null;
    }
    default:
      return null;
  }
}

function displayHeading(part) {
  return part.heading === null ? 'Introduction' : part.heading;
}

// --- Planning ---

// Plans the new README. Nothing is written here; see writeReadme.
// current: the README text, or null when there is none. saved: from readReadmeState.
// blocks: { layers, scripts, tree } computed contents ('' when there is nothing to show).
// regenerate: whether Docturnal's own sections need new prose.
// generate(personText): returns the model's reply for the standard sections.
// Returns { content, state, report, pending, errors }. content is null when README.md stays
// exactly as it is.
async function planReadme({
  current, saved, blocks, regenerate, generate, name, facts, deadline = Infinity, now = Date.now,
}) {
  const report = { updated: [], notReadded: [], fallback: false };
  const errors = [];
  // It initializes a pending variable to track any pending operations.
  let pending = null;
  const suppressed = new Map((saved ? saved.suppressed : []).map((s) => [s.key, s.heading]));
  const parsed = current === null ? { eol: '\n', preamble: '', parts: [] } : parseReadme(current);
  const savedByKey = new Map((saved ? saved.sections : []).map((s) => [s.key, s]));
  // A README that Docturnal never saved belongs to the people who wrote it.
  const foreign = current !== null && !saved;

  let parts = parsed.parts.map((p) => {
    const hash = sectionHash(p.text);
    const before = savedByKey.get(p.key);
    let owner = 'person';
    if (!p.empty && !foreign && before && before.hash === hash) {
      owner = before.owner;
    } else if (!p.empty && !foreign && !before && suppressed.has(p.key)) {
      suppressed.delete(p.key); // Added back by a person.
    }
    return { ...p, owner, original: p.text };
  });
  const present = (key) => parts.some((p) => !p.empty && p.key === key);
  if (saved) {
    for (const s of saved.sections) if (!present(s.key)) suppressed.set(s.key, s.heading || 'Introduction');
    for (const name of blocksIn(saved.text)) if (!blocksIn(current).has(name)) suppressed.set(`block:${name}`, own(BLOCK_TITLES, name) || name);
  }
  for (const name of blocksIn(current)) suppressed.delete(`block:${name}`);
  const allowBlock = (blockName) => !suppressed.has(`block:${blockName}`);
  const stdSuppressed = (std) => [...suppressed.keys()].some((k) => (std.id === 'intro' ? k === 'intro' : std.aliases.includes(baseKey(k))));

  // Standard sections: regenerate Docturnal's own, create missing ones.
  const toWrite = [];
  for (const std of STANDARD) {
    const part = parts.find((p) => !p.empty && standardOf(p.key) === std);
    if (part) {
      if (part.owner === 'docturnal' && regenerate) toWrite.push({ std, part });
    } else if (!stdSuppressed(std)) {
      toWrite.push({ std, part: null });
    }
  }
  const needsProse = toWrite.some(({ std }) => std.id !== 'structure');
  let prose = { intro: '', overview: '', architecture: '', start: '' };
  let proseOk = !needsProse;
  if (needsProse && now() > deadline) {
    pending = 'time budget';
  } else if (needsProse) {
    try {
      const personText = parts.filter((p) => !p.empty && p.owner === 'person').map((p) => p.text.trim()).join('\n\n');
      const reply = await generate(personText);
      prose = reply.prose;
      report.fallback = Boolean(reply.fallback);
      proseOk = true;
    } catch (err) {
      errors.push(`${README_PATH}: ${err.message}`);
      pending = 'the model did not respond';
    }
  }
  for (const { std, part } of toWrite) {
    if (std.id !== 'structure' && !proseOk) continue;
    const text = standardText(std.id, { prose, blocks, allowBlock, name, facts });
    if (text === null) continue;
    if (part) {
      part.text = text;
      continue;
    }
    const created = { key: std.id === 'intro' ? 'intro' : normalizeHeading(std.title), heading: std.title, text, owner: 'docturnal', original: null };
    const index = STANDARD.indexOf(std);
    let at;
    if (std.id === 'intro') {
      at = 0;
      parts = parts.filter((p) => !(p.key === 'intro' && p.empty));
    } else {
      let after = -1;
      parts.forEach((p, i) => {
        const si = p.empty ? -1 : standardIndex(p.key);
        if (si !== -1 && si < index) after = i;
      });
      if (after === -1) {
        const next = parts.findIndex((p) => !p.empty && standardIndex(p.key) > index);
        after = next === -1 ? parts.length - 1 : next - 1;
      }
      at = after + 1;
    }
    parts.splice(at, 0, created);
  }

  // Blocks are refreshed wherever they are, even inside a person's section.
  const blocksNow = new Set(parts.flatMap((p) => [...blocksIn(p.text)]));
  for (const part of parts) part.text = refreshBlocks(part.text, blocks);

  // A block that is in no section, and that no person removed, goes into its standard section.
  for (const [blockName, hostId] of Object.entries(BLOCK_HOST)) {
    if (blocksNow.has(blockName) || !allowBlock(blockName) || !own(blocks, blockName)) continue;
    const host = parts.find((p) => !p.empty && standardOf(p.key) && standardOf(p.key).id === hostId);
    if (!host || blocksIn(host.text).has(blockName)) continue;
    const addition = blockName === 'scripts' ? `### Available scripts\n\n${renderBlock(blockName, blocks[blockName])}` : renderBlock(blockName, blocks[blockName]);
    host.text = `${host.text.trimEnd()}\n\n${addition}\n`;
  }

  // Assemble. A part whose text came out the same, apart from trailing blank lines, keeps
  // its exact bytes, and when no part changed, README.md stays byte for byte as it is.
  for (const part of parts) {
    if (part.original !== null && part.text.trimEnd() === part.original.trimEnd()) part.text = part.original;
  }
  const anyChange = parts.some((p) => p.text !== p.original) || parsed.parts.length !== parts.length;
  let content = null;
  if (anyChange) {
    const texts = parts.map((p) => p.text);
    for (let i = 0; i < texts.length - 1; i++) {
      if (!texts[i].trim()) continue;
      if (!texts[i].endsWith('\n')) texts[i] += '\n';
      if (!texts[i].endsWith('\n\n')) texts[i] += '\n';
    }
    let body = texts.join('').replace(/\s+$/, '\n');
    if (!body.trim()) body = '';
    const preamble = parsed.preamble || `${MAINTAINED}\n\n`;
    content = body ? `${preamble}${body}` : null;
    if (content && parsed.eol === '\r\n') content = content.replace(/\r?\n/g, '\r\n');
  }

  for (const part of parts) {
    if (part.empty) continue;
    if (part.text !== part.original) report.updated.push(displayHeading(part));
  }
  for (const [key, heading] of suppressed) {
    if (key.startsWith('block:') || standardOf(key)) report.notReadded.push(heading);
  }

  const finalText = content ?? current;
  const finalParts = finalText === null ? [] : parseReadme(finalText).parts.filter((p) => !p.empty);
  const owners = new Map(parts.map((p) => [p.key, p]));
  const state = {
    version: README_STATE_VERSION,
    text: finalText,
    sections: finalParts.map((p) => {
      const planned = owners.get(p.key);
      return { key: p.key, heading: p.heading, hash: sectionHash(p.text), owner: planned ? planned.owner : 'person' };
    }),
    suppressed: [...suppressed].map(([key, heading]) => ({ key, heading })),
  };
  return { content, state, report, pending, errors };
}

// --- Files ---

function readReadmeState(root) {
  try {
    requirePlainPath(root, README_STATE_PATH);
    const data = JSON.parse(fs.readFileSync(path.join(root, README_STATE_PATH), 'utf8'));
    if (!data || data.version !== README_STATE_VERSION || !Array.isArray(data.sections) || !Array.isArray(data.suppressed)) return null;
    return {
      version: README_STATE_VERSION,
      text: typeof data.text === 'string' ? data.text : null,
      sections: data.sections.filter((s) => s && typeof s.key === 'string' && typeof s.hash === 'string')
        .map((s) => ({ key: s.key, heading: typeof s.heading === 'string' ? s.heading : null, hash: s.hash, owner: s.owner === 'docturnal' ? 'docturnal' : 'person' })),
      suppressed: data.suppressed.filter((s) => s && typeof s.key === 'string').map((s) => ({ key: s.key, heading: String(s.heading || s.key) })),
    };
  } catch {
    return null;
  }
}

// Whether Docturnal may read and write README.md: not when it is a symbolic link, such as one
// to another document.
function readmeIsPlain(root) {
  return isPlainPath(root, README_PATH);
}

function readCurrentReadme(root) {
  if (!readmeIsPlain(root)) return null;
  try {
    return fs.readFileSync(path.join(root, README_PATH), 'utf8');
  } catch {
    return null;
  }
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

// Writes README.md and readme.json when they change. Returns the paths written.
function writeReadme(root, { content, state }) {
  const written = [];
  if (!readmeIsPlain(root)) return written;
  requirePlainPath(root, README_STATE_PATH);
  if (content !== null) {
    fs.writeFileSync(path.join(root, README_PATH), content);
    written.push(README_PATH);
  }
  const statePath = path.join(root, README_STATE_PATH);
  let before = null;
  try {
    before = fs.readFileSync(statePath, 'utf8');
  } catch {
    // No saved state yet.
  }
  if (before !== serializeState(state)) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, serializeState(state));
    written.push(README_STATE_PATH);
  }
  return written;
}

// Computes the blocks, calls the model through `caller`, and plans the README.
// waiting: folders the documentation pass has not described yet. The layers table says so,
// and the note goes once they are described.
// available(docPath): whether a layer doc exists, so the layers table links only the
// sub-documents that do.
async function updateReadme({ root, caller, layers, facts, projectName, docsDir = 'docs', allFiles, regenerate, contextTokens = 8192, deadline, now, linkStats = {}, waiting = [], available = () => true }) {
  // A README that is a symbolic link is left alone, with no model call.
  if (!readmeIsPlain(root)) return { content: null, state: null, report: null, pending: null, errors: [], linked: true };
  const current = readCurrentReadme(root);
  const saved = readReadmeState(root);
  const docsBase = `${docsDir.replace(/\/$/, '')}/`;
  const blocks = {
    layers: [layers.length ? docs.layersTable(layers, docsBase, available) : '', waitingNote(waiting)].filter(Boolean).join('\n\n'),
    scripts: docs.scriptsTable(facts),
    tree: `\`\`\`text\n${docs.directoryTree([...new Set([...allFiles, README_PATH])])}\n\`\`\``,
  };
  const existingPaths = docs.pathsWithDirs([...allFiles, README_PATH, ...layers.map((l) => `${docsBase}${docs.docName(l)}.md`)]);
  const docOptions = { temperature: 0.3, seed: 42, num_ctx: contextTokens, num_predict: README_TOKENS };
  return planReadme({
    current,
    saved,
    blocks,
    regenerate,
    name: projectName,
    facts,
    deadline,
    now,
    generate: async (personText) => {
      const raw = docs.completeReply(await caller.call(README_PATH, { messages: readmePrompt({ projectName, layers, facts, personText }), options: docOptions, withReason: true }), linkStats);
      return { prose: readmeBodies(raw, { projectName, facts, existingPaths, knownUrls: links.knownUrls(root), linkStats }), fallback: caller.lastUsedFallback };
    },
  });
}

module.exports = { readmeIsPlain,
  proseParagraphs,
  readmePrompt,
  MAINTAINED,
  README_PATH,
  README_STATE_PATH,
  parseReadme,
  planReadme,
  readCurrentReadme,
  readReadmeState,
  renderBlock,
  sectionHash,
  updateReadme,
  writeReadme,
};
