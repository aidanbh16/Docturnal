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

// A folder summary: a purpose for each file in the digest, named after its first export.
function folderReply(body) {
  const digest = body.messages[1].content;
  const where = (digest.match(/^Files in (?:the folder )?(.+?)\./m) || [])[1] || 'the project';
  // Only the files marked "*" need a purpose.
  const files = [...digest.matchAll(/^\* ([^:\n]+): (?:(?:exports|defines) ([\w$]+))?/gm)].map((m) => ({
    name: m[1],
    purpose: m[2] ? `Defines ${m[2]} for ${m[1]}.` : `Supports ${m[1]}.`,
  }));
  return { summary: `Holds the code in ${where}.`, files };
}

function kindOf(body) {
  const props = (body.format && body.format.properties) || {};
  const prompt = promptOf(body);
  if (!(body.messages || []).length) return 'load';
  if (prompt.includes('Write a block comment for each of these declarations')) return 'blocks';
  if (props.verdicts) return 'accuracy';
  if (props.comments) return 'comments';
  if (props.summary && props.files) return 'folder';
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

// The accuracy check: every comment is accurate and useful and repeats nothing, unless judge
// says otherwise. judge(comment, code, functionComment) returns true or false for accurate,
// or an object with any of accurate, useful, and repeats.
function accuracyReply(body, judge = () => true) {
  const items = [...promptOf(body).matchAll(/^Item (\d+)\nComment: (.*)\n(?:Function comment: (.*)\n)?Code:\n((?:\d+\| .*(?:\n|$))+)/gm)];
  return {
    verdicts: items.map(([, id, comment, functionComment, code]) => {
      const answer = judge(comment, code, functionComment);
      return { id: Number(id), accurate: true, useful: true, repeats: false, ...(typeof answer === 'boolean' ? { accurate: answer } : answer) };
    }),
  };
}

// One layer per group, named after the last part of its folder: "Api Code" for src/api.
function layersReply(body) {
  const prompt = promptOf(body);
  const groups = [...prompt.matchAll(/^- (g\d+): ([^\s,(]+)/gm)].map((m) => ({ id: m[1], folder: m[2] }));
  const used = new Set();
  return {
    layers: groups.map(({ id, folder }) => {
      // The parent folder too when the last part repeats, as a model would name app/src and src.
      let key = folder === '.' ? 'core' : folder.split('/').pop();
      for (let n = 2; used.has(key); n++) key = `${folder.split('/').pop()} ${n}`;
      used.add(key);
      return { name: `${key.charAt(0).toUpperCase()}${key.slice(1)} Code`, description: `Holds the ${key} code.`, groups: [id] };
    }),
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
      case 'folder': return folderReply(body);
      case 'blocks': return blocksReply(body);
      case 'accuracy': return accuracyReply(body);
      case 'load': return '';
      case 'layers': return layersReply(body);
      case 'layer-doc': return layerDocReply(body);
      case 'readme': return readmeReply(body);
      case 'polish': return polishReply(body);
      default: throw new MockError(400, JSON.stringify({ error: 'unknown prompt' }));
    }
  };
}

// models: what /api/tags lists, names or { name, digest } entries.
async function startMockOllama(handler = defaultHandler(), { port = 0, onRequest, models = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: models.map((m) => (typeof m === 'string' ? { name: m } : m)) }));
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
      let content;
      let payload;
      try {
        // A request without messages only loads the model, as in Ollama. The handler may
        // still fail it, for example for a model that does not fit in memory.
        const reply = await handler(body, requests.length - 1);
        content = !(body.messages || []).length ? '' : typeof reply === 'string' ? reply : JSON.stringify(reply);
      } catch (err) {
        status = err.status || 500;
        payload = err.message;
        // A handler error with dropConnection closes the socket without a reply, the way a
        // connection that times out or resets looks to the client.
        if (err.dropConnection) status = 0;
      }
      if (onRequest) onRequest({ model: body.model, kind: kindOf(body), file: (promptOf(body).match(/^File: (.+)$/m) || [])[1], status });
      if (status === 0) {
        req.socket.destroy();
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content }, done: true }));
        return;
      }
      // Streamed like Ollama: one JSON object per line, the message in pieces, then done.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const size = Math.max(1, Math.ceil(content.length / 3));
      for (let i = 0; i < content.length; i += size) {
        res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: content.slice(i, i + size) }, done: false })}\n`);
      }
      res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: content ? 'stop' : 'load' })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${server.address().port}`,
    port: server.address().port,
    requests,
    models,
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
