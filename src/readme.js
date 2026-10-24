'use strict';

// The repository's README.md, the main document. People share it with Docturnal, so it
// carries no Docturnal marker, and Docturnal keeps what people add to it or remove from it.
//
// .docturnal/readme.json saves the README as Docturnal last wrote it, split into sections:
// the intro (the text before the first H2) and one section per H2 heading. Each run compares
// the current README with it, section by section:
// - A saved section that is gone was deleted by a person. Its heading is suppressed and never
//   written again, until a person adds it back.
// - A section that changed, or that is new, belongs to a person. Docturnal polishes it once,
//   and never regenerates it.
// - A section that is unchanged keeps its owner. Docturnal regenerates its own sections.
// Computed blocks (the layers table, the scripts table, the directory tree) sit between
// hidden markers, and are refreshed wherever they are, unless a person removed them.

const fs = require('fs');
const path = require('path');

const docs = require('./docs');
const { hashContent } = require('./state');

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

const POLISH_MIN_WORDS = 0.7;

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
  return text.replace(BLOCK_RE, (match, name) => (name in blocks ? renderBlock(name, blocks[name]) : match));
}

// --- The polish safeguard ---

function polishTokens(text) {
  const lines = text.split('\n');
  const fences = [];
  const prose = [];
  const headings = [];
  let fence = null;
  let buffer = [];
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      buffer.push(line);
      if (fenceMatch && line.trim().startsWith(fence)) {
        fences.push(buffer.join('\n'));
        buffer = [];
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1].slice(0, 3);
      buffer = [line];
      continue;
    }
    if (/^#{1,6}\s/.test(line)) headings.push(line.trim());
    prose.push(line);
  }
  if (fence) fences.push(buffer.join('\n'));
  const proseText = prose.join('\n');
  const inline = proseText.match(/`[^`\n]+`/g) || [];
  const noCode = proseText.replace(/`[^`\n]+`/g, ' ');
  const links = noCode.match(/!?\[[^[\]\n]*\]\([^()\s]+(?:\s+"[^"\n]*")?\)/g) || [];
  const targets = [
    ...[...noCode.matchAll(/\]\(\s*([^)\s]+)/g)].map((m) => m[1]),
    ...(noCode.match(/\bhttps?:\/\/[^\s)<>\]"'`]+/g) || []),
    ...[...noCode.matchAll(/^\s*\[[^\]\n]+\]:\s*(\S+)/gm)].map((m) => m[1]),
  ];
  const html = noCode.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^<>\n]*>/g) || [];
  const bare = noCode
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^<>\n]*>/g, ' ');
  const numbers = bare.match(/\d+(?:[.,:]\d+)*/g) || [];
  const words = text.split(/\s+/).filter(Boolean).length;
  return { fences, inline, links, targets, html, numbers, headings, words };
}

// Checks a polished rewrite against the person's original. Returns null when it is safe,
// or the reason it is not.
function polishProblem(original, rewrite) {
  if (!rewrite.trim()) return 'the rewrite is empty';
  const before = polishTokens(original);
  const after = polishTokens(rewrite);
  const has = (list, item) => list.includes(item);
  const checks = [
    ['code block', 'fences'], ['inline code', 'inline'], ['link target', 'targets'], ['HTML tag', 'html'], ['number', 'numbers'],
  ];
  for (const [label, field] of checks) {
    const missing = before[field].find((item) => !has(after[field], item));
    if (missing !== undefined) return `dropped a ${label}`;
    const added = after[field].find((item) => !has(before[field], item));
    if (added !== undefined) return `added a ${label}`;
  }
  const missingLink = before.links.find((link) => !rewrite.includes(link));
  if (missingLink) return 'changed a link or image';
  if (after.headings.some((h) => !before.headings.includes(h))) return 'added a heading';
  if (after.words < before.words * POLISH_MIN_WORDS) return 'too short';
  return null;
}

// Strips what a model wraps around a reply: a code fence around everything, chatter, and a
// repeated heading.
function cleanPolish(raw, heading, original) {
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  const fenced = text.match(/^(```|~~~)[\w-]*\n([\s\S]*?)\n\1\s*$/);
  if (fenced && !/^\s*(```|~~~)/.test(original)) text = fenced[2];
  const lines = docs.trimChatter(text.split('\n'));
  if (lines.length && heading && normalizeHeading(lines[0].replace(/^#+\s*/, '')) === normalizeHeading(heading) && /^#/.test(lines[0])) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

function polishPrompt(heading, body) {
  return [
    {
      role: 'system',
      content: `You edit developer documentation written by people.\n\n${docs.STYLE_RULES}\n- Keep every link, image, badge, inline code span, code block, number, and HTML comment or tag exactly as written.\n- Add no information, links, commands, or headings.`,
    },
    {
      role: 'user',
      content: `Rewrite this README section for clarity, following the writing rules. Keep its meaning and every fact. Reply with the rewritten section body only, without its heading.\n\nSection heading: ${heading}\n\nSection body:\n${body}`,
    },
  ];
}

// --- Generated sections ---

function readmePrompt({ projectName, layers, facts, personText, contextTokens }) {
  const layerList = layers.map((l) => `- ${l.name}: ${l.description} Files: ${l.files.join(', ')}`).join('\n') || 'None.';
  let content = `Write the main documentation page for ${projectName}.

Use exactly this structure:

# ${projectName}

One paragraph that says what the project is and who it is for.

## Overview

## Architecture

One or two paragraphs on how the layers below work together. A table of layers is added separately.

## Getting started

Prerequisites, installation, and how to run the project, using only the commands and settings in the project facts. A table of scripts and a list of environment variables are added separately.

Do not add other sections. A project structure section is added separately.

Layers:
${layerList}

Project facts:
${docs.describeFacts(facts)}
`;
  if (personText) {
    const room = Math.max(0, docs.charBudget(contextTokens) - content.length - 100);
    content += `\nSections that the project's people wrote, for context. Do not repeat them:\n${personText.slice(0, room)}\n`;
  }
  return [
    { role: 'system', content: `You write developer documentation.\n\n${docs.STYLE_RULES}` },
    { role: 'user', content },
  ];
}

// The model's prose for the standard sections: { intro, overview, architecture, start }.
function readmeBodies(raw, { projectName, facts, existingPaths }) {
  const cleaned = docs.cleanMarkdown(raw, { title: projectName, docPath: README_PATH, existingPaths });
  const { intro, sections } = docs.splitSections(cleaned);
  const bodies = docs.arrangeSections(sections, docs.README_SECTIONS, { extrasInto: 'overview', generated: docs.README_GENERATED });
  const { first, rest } = docs.splitIntro(intro);
  return {
    intro: first || facts.description || '',
    overview: [rest, bodies.get('overview')].filter(Boolean).join('\n\n'),
    architecture: bodies.get('architecture') || '',
    start: docs.removeSubsections(bodies.get('start') || '', ['available scripts', 'scripts', 'environment variables']),
  };
}

function sectionText(title, body) {
  return `## ${title}\n\n${body.trim()}\n`;
}

// The text of a standard section that Docturnal writes, or null when there is nothing to say.
function standardText(id, { prose, blocks, allowBlock, name, facts }) {
  const block = (blockName) => (allowBlock(blockName) && blocks[blockName] ? renderBlock(blockName, blocks[blockName]) : '');
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

// Splits a part into the line that names it (its H2, or the H1 of the intro) and its body.
function splitHead(part) {
  const lines = part.text.split('\n');
  if (part.heading !== null) return { head: lines[0], body: lines.slice(1).join('\n') };
  const h1 = lines.findIndex((line) => /^#\s/.test(line));
  if (h1 === -1) return { head: '', body: part.text };
  return { head: lines.slice(0, h1 + 1).join('\n'), body: lines.slice(h1 + 1).join('\n') };
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
// polish(heading, body): returns the model's rewrite of a person's section.
// Returns { content, state, report, pending, errors }. content is null when README.md stays
// exactly as it is.
async function planReadme({
  current, saved, blocks, regenerate, generate, polish, name, facts, deadline = Infinity, now = Date.now,
}) {
  const report = { updated: [], polished: [], kept: [], notReadded: [], fallback: false };
  const errors = [];
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
    let changed = true;
    if (p.empty) changed = false;
    else if (!foreign && before && before.hash === hash) {
      owner = before.owner;
      changed = Boolean(before.pendingPolish);
    } else if (!foreign && !before && suppressed.has(p.key)) {
      suppressed.delete(p.key); // Added back by a person.
    }
    return { ...p, owner, changed, original: p.text };
  });
  const present = (key) => parts.some((p) => !p.empty && p.key === key);
  if (saved) {
    for (const s of saved.sections) if (!present(s.key)) suppressed.set(s.key, s.heading || 'Introduction');
    for (const name of blocksIn(saved.text)) if (!blocksIn(current).has(name)) suppressed.set(`block:${name}`, BLOCK_TITLES[name]);
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
    const created = { key: std.id === 'intro' ? 'intro' : normalizeHeading(std.title), heading: std.title, text, owner: 'docturnal', changed: false, original: null };
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

  // Polish each person's section that changed, once. The model sees a placeholder for each
  // block, and the refreshed block goes back in its place.
  for (const part of parts) {
    if (part.owner !== 'person' || !part.changed) continue;
    const { head, body } = splitHead({ ...part, text: part.original });
    const original = body.replace(BLOCK_RE, (match, blockName) => `<!-- docturnal:${blockName} -->`).trim();
    if (!original) continue;
    if (now() > deadline) {
      part.pendingPolish = true;
      continue;
    }
    let rewrite;
    try {
      rewrite = cleanPolish(await polish(displayHeading(part), original), part.heading, original);
    } catch (err) {
      errors.push(`${README_PATH} (${displayHeading(part)}): ${err.message}`);
      part.pendingPolish = true;
      continue;
    }
    if (rewrite === original) continue;
    if (polishProblem(original, rewrite)) {
      report.kept.push(displayHeading(part));
      continue;
    }
    const polished = rewrite.replace(/<!-- docturnal:([a-z]+) -->/g, (match, blockName) => renderBlock(blockName, blocks[blockName] ?? ''));
    part.text = head ? `${head.trimEnd()}\n\n${polished.trim()}\n` : `${polished.trim()}\n`;
    part.polished = true;
    report.polished.push(displayHeading(part));
  }

  // A block that is in no section, and that no person removed, goes into its standard section.
  for (const [blockName, hostId] of Object.entries(BLOCK_HOST)) {
    if (blocksNow.has(blockName) || !allowBlock(blockName) || !blocks[blockName]) continue;
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
    if (part.empty || part.polished) continue;
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
      const entry = { key: p.key, heading: p.heading, hash: sectionHash(p.text), owner: planned ? planned.owner : 'person' };
      if (planned && planned.pendingPolish) entry.pendingPolish = true;
      return entry;
    }),
    suppressed: [...suppressed].map(([key, heading]) => ({ key, heading })),
  };
  return { content, state, report, pending, errors };
}

// --- Files ---

function readReadmeState(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, README_STATE_PATH), 'utf8'));
    if (!data || data.version !== README_STATE_VERSION || !Array.isArray(data.sections) || !Array.isArray(data.suppressed)) return null;
    return {
      version: README_STATE_VERSION,
      text: typeof data.text === 'string' ? data.text : null,
      sections: data.sections.filter((s) => s && typeof s.key === 'string' && typeof s.hash === 'string')
        .map((s) => ({ key: s.key, heading: typeof s.heading === 'string' ? s.heading : null, hash: s.hash, owner: s.owner === 'docturnal' ? 'docturnal' : 'person', ...(s.pendingPolish ? { pendingPolish: true } : {}) })),
      suppressed: data.suppressed.filter((s) => s && typeof s.key === 'string').map((s) => ({ key: s.key, heading: String(s.heading || s.key) })),
    };
  } catch {
    return null;
  }
}

function readCurrentReadme(root) {
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
async function updateReadme({ root, caller, layers, facts, projectName, docsDir = 'docs', allFiles, regenerate, contextTokens = 8192, deadline, now }) {
  const current = readCurrentReadme(root);
  const saved = readReadmeState(root);
  const docsBase = `${docsDir.replace(/\/$/, '')}/`;
  const blocks = {
    layers: layers.length ? docs.layersTable(layers, docsBase) : '',
    scripts: docs.scriptsTable(facts),
    tree: `\`\`\`text\n${docs.directoryTree([...new Set([...allFiles, README_PATH])])}\n\`\`\``,
  };
  const existingPaths = docs.pathsWithDirs([...allFiles, README_PATH, ...layers.map((l) => `${docsBase}${l.slug}.md`)]);
  const docOptions = { temperature: 0.3, seed: 42, num_ctx: contextTokens };
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
      const raw = await caller.call(README_PATH, { messages: readmePrompt({ projectName, layers, facts, personText, contextTokens }), options: docOptions });
      return { prose: readmeBodies(raw, { projectName, facts, existingPaths }), fallback: caller.lastUsedFallback };
    },
    polish: (heading, body) => caller.call(`${README_PATH} (${heading})`, { messages: polishPrompt(heading, body), options: { ...docOptions, temperature: 0.2 } }),
  });
}

module.exports = {
  MAINTAINED,
  README_PATH,
  README_STATE_PATH,
  parseReadme,
  planReadme,
  polishProblem,
  readCurrentReadme,
  readReadmeState,
  renderBlock,
  sectionHash,
  updateReadme,
  writeReadme,
};
