'use strict';

// Minimal client for the local Ollama server. Refuses any host that is not loopback,
// so source code can never be sent off the runner.
//
// It uses node:http rather than fetch, whose built-in client has timeouts of its own, and a
// large model on a CPU runner can take many minutes to load and answer. node:http has no
// timeout of its own, and replies are streamed, so the only limit on a call is the run's own
// time budget (deadline).

const http = require('http');
const https = require('https');

const DEFAULT_HOST = '127.0.0.1:11434';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function baseUrl(host = process.env.OLLAMA_HOST || DEFAULT_HOST) {
  const url = new URL(/^https?:\/\//.test(host) ? host : `http://${host}`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to use Ollama at ${url.hostname}. Docturnal only talks to a local server.`);
  }
  return url.origin;
}

// Sends one /api/chat request and returns the reply's text. With no messages, Ollama only
// loads the model. keepAlive: how long Ollama keeps the model loaded afterward, such as "30m".
// deadline: a time in ms after which the call is abandoned.
function chat({ model, messages, format, options, host, keepAlive, deadline }) {
  const url = new URL('/api/chat', baseUrl(host));
  const payload = { model, messages, stream: true };
  if (format !== undefined) payload.format = format;
  if (options !== undefined) payload.options = options;
  if (keepAlive !== undefined) payload.keep_alive = keepAlive;

  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.setEncoding('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => finish(new Error(`Ollama /api/chat returned ${res.statusCode}: ${body.slice(0, 500)}`)));
        res.on('error', (err) => finish(err));
        return;
      }

      // The reply is one JSON object per line. Each carries a piece of the message, and the
      // last one has done: true. A failure after the headers arrives as { error }.
      let buffer = '';
      let content = '';
      let done = false;
      const readLine = (line) => {
        if (!line.trim()) return;
        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          throw new Error('Ollama sent a malformed reply');
        }
        if (chunk.error) throw new Error(`Ollama /api/chat failed: ${String(chunk.error).slice(0, 500)}`);
        if (chunk.message && typeof chunk.message.content === 'string') content += chunk.message.content;
        if (chunk.done) done = true;
      };
      res.on('data', (chunk) => {
        buffer += chunk;
        try {
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            readLine(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
        } catch (err) {
          finish(err);
          req.destroy();
        }
      });
      res.on('end', () => {
        try {
          readLine(buffer);
        } catch (err) {
          finish(err);
          return;
        }
        if (done) finish(null, content);
        else finish(new Error('Ollama closed the reply before it finished'));
      });
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));

    if (deadline !== undefined) {
      timer = setTimeout(() => {
        const err = new Error('the time budget ran out');
        finish(err);
        req.destroy(err);
      }, Math.max(0, deadline - Date.now()));
    }
    req.end(JSON.stringify(payload));
  });
}

// What went wrong, with the underlying cause when there is one, such as ECONNRESET.
// Never includes the request.
function describeError(err) {
  const parts = [err && err.message ? err.message : String(err)];
  if (err && err.code && !parts[0].includes(err.code)) parts.push(`code ${err.code}`);
  const cause = err && err.cause;
  if (cause) parts.push(`cause: ${cause.code ? `${cause.code} ` : ''}${cause.message || cause}`.trim());
  return parts.join('; ');
}

// Wraps a chat function so every call logs its label, model, and duration, and a failure
// also logs its cause. Prompts, code, and replies are never logged. deadline is passed on
// to every call.
function loggedChat(chat, { log = console.log, now = Date.now, deadline } = {}) {
  return async (request) => {
    const started = now();
    const what = `${request.label || (request.messages && request.messages.length ? 'request' : 'load')} with ${request.model}`;
    const seconds = () => `${((now() - started) / 1000).toFixed(1)} s`;
    try {
      const content = await chat({ ...request, deadline: request.deadline !== undefined ? request.deadline : deadline });
      log(`Ollama: ${what}, ${seconds()}`);
      return content;
    } catch (err) {
      log(`Ollama: ${what} failed after ${seconds()}: ${describeError(err)}`);
      throw err;
    }
  };
}

module.exports = { DEFAULT_HOST, baseUrl, chat, describeError, loggedChat };
