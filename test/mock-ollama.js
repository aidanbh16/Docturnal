'use strict';

// A stand-in for the Ollama HTTP API.
//
// In tests: startMockOllama(handler) where handler receives each /api/chat request body
// and returns the assistant message content (an object is sent as JSON). defaultHandler()
// answers every Docturnal prompt type with valid output.
//
// As a server for test/e2e.sh:
//   node test/mock-ollama.js --serve --port-file FILE [--log FILE] [--oom-model NAME]
// Requests for --oom-model fail the way Ollama does when a model does not fit in memory.

const fs = require('fs');
const http = require('http');

const OOM_MESSAGE = 'model requires more system memory (5.6 GiB) than is available (3.9 GiB)';

class MockError extends Error {
  constructor(status, body) {
    super(body);
    this.status = status;
  }
}

function promptOf(body) {
  return (body.messages || []).map((m) => m.content).join('\n');
}

function kindOf(body) {
  const props = (body.format && body.format.properties) || {};
  const prompt = promptOf(body);
  if (prompt.includes('Write a block comment for each of these declarations')) return 'blocks';
  if (props.verdicts) return 'accuracy';
  if (props.comments) return 'comments';
  if (props.layers) return 'layers';
  if (prompt.includes('Rewrite this README section')) return 'polish';
  if (prompt.includes('main documentation page')) return 'readme';
  if (/documentation page for the "/.test(prompt)) return 'layer-doc';
  return 'unknown';
}

const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|def\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\()/;

function commentsReply(body) {
  const prompt = promptOf(body);
  const file = (prompt.match(/^File: (.+)$/m) || [])[1] || 'unknown';
  const names = [];
  const comments = [];
  for (const [, number, code] of prompt.matchAll(/^(\d+)\| (.*)$/gm)) {
    const match = code.match(DECLARATION);
    if (!match) continue;
    const name = match.slice(1).find(Boolean);
    names.push(name);
    comments.push({ line: Number(number), anchor: code.trim(), text: `Keeps the ${name} logic in one place for callers.`, kind: 'line' });
  }
  return {
    summary: names.length ? `Defines ${names.join(', ')} for ${file}.` : `Supports ${file}.`,
    symbols: names,
    comments,
  };
}

// The heavy-level follow-up: one block comment per listed declaration.
function blocksReply(body) {
  const prompt = promptOf(body);
  const code = new Map([...prompt.matchAll(/^(\d+)\| (.*)$/gm)].map(([, number, text]) => [Number(number), text.trim()]));
  const comments = [...prompt.matchAll(/^- line (\d+): (.+)$/gm)].map(([, number, name]) => ({
    line: Number(number),
    anchor: code.get(Number(number)) || '',
    text: `Explains what ${name} is for and what it returns.`,
    kind: 'block',
  }));
  return { comments };
}

// The accuracy check: every comment is accurate unless isAccurate says otherwise.
// isAccurate receives the comment text and the code lines under it.
function accuracyReply(body, isAccurate = () => true) {
  const items = [...promptOf(body).matchAll(/^Item (\d+)\nComment: (.*)\nCode:\n((?:\d+\| .*(?:\n|$))+)/gm)];
  return { verdicts: items.map(([, id, comment, code]) => ({ id: Number(id), accurate: isAccurate(comment, code) })) };
}

function layersReply(body) {
  const prompt = promptOf(body);
  const files = [...prompt.matchAll(/^- ([^\s:]+)(?::|$)/gm)].map((m) => m[1]);
  const groups = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const key = parts.length > 1 ? parts[parts.length - 2] : 'core';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return {
    layers: [...groups].map(([key, groupFiles]) => ({
      name: `${key.charAt(0).toUpperCase()}${key.slice(1)} Code`,
      description: `Holds the ${key} code.`,
      files: groupFiles,
    })),
  };
}

function layerDocReply(body) {
  const name = promptOf(body).match(/for the "([^"]+)" layer/)[1];
  return `# ${name}\n\nThe ${name} layer groups related modules.\n\n## Overview\n\nYou find these modules together.\n\n## How it works\n\nEach module exports its functions.`;
}

function readmeReply() {
  return '# Project\n\nThis project is a sample.\n\n## Overview\n\nIt has a few modules.\n\n## Architecture\n\nThe layers call each other.\n\n## Getting started\n\nInstall the dependencies.';
}

// A careful edit: drops the filler word "basically" and keeps everything else.
function dropFiller(text) {
  return text.replace(/\bbasically,? (\w)/gi, (match, next, offset) => {
    const startsSentence = offset === 0 || /[.!?]\s*$|\n\s*$/.test(text.slice(0, offset));
    return startsSentence ? next.toUpperCase() : next;
  }).replace(/,? basically\b/gi, '');
}

function polishReply(body) {
  return dropFiller(promptOf(body).split('Section body:\n').pop());
}

function defaultHandler({ oomModels = [] } = {}) {
  return (body) => {
    if (oomModels.includes(body.model)) throw new MockError(500, JSON.stringify({ error: OOM_MESSAGE }));
    switch (kindOf(body)) {
      case 'comments': return commentsReply(body);
      case 'blocks': return blocksReply(body);
      case 'accuracy': return accuracyReply(body);
      case 'layers': return layersReply(body);
      case 'layer-doc': return layerDocReply(body);
      case 'readme': return readmeReply(body);
      case 'polish': return polishReply(body);
      default: throw new MockError(400, JSON.stringify({ error: 'unknown prompt' }));
    }
  };
}

async function startMockOllama(handler = defaultHandler(), { port = 0, onRequest } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      let status = 200;
      let payload;
      try {
        const reply = await handler(body, requests.length - 1);
        const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
        payload = JSON.stringify({ model: body.model, message: { role: 'assistant', content }, done: true });
      } catch (err) {
        status = err.status || 500;
        payload = err.message;
      }
      if (onRequest) onRequest({ model: body.model, kind: kindOf(body), file: (promptOf(body).match(/^File: (.+)$/m) || [])[1], status });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Only runs as a server with --serve, so that `node --test` can load this file safely.
if (require.main === module && process.argv.includes('--serve')) {
  const logFile = argValue('--log');
  const oomModel = argValue('--oom-model');
  startMockOllama(defaultHandler({ oomModels: oomModel ? [oomModel] : [] }), {
    onRequest: logFile ? (entry) => fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`) : undefined,
  }).then((mock) => {
    const portFile = argValue('--port-file');
    if (portFile) fs.writeFileSync(portFile, mock.host.split(':')[1]);
    console.log(`Mock Ollama listening on ${mock.host}`);
  });
}

module.exports = { OOM_MESSAGE, accuracyReply, blocksReply, defaultHandler, kindOf, startMockOllama };
