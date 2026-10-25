'use strict';

// Minimal client for the Ollama server on the runner. It refuses any host that is not loopback,
// so source code can never be sent off the runner.
//
// It uses node:http rather than fetch, whose built-in client has timeouts of its own, and a
// large model on a CPU runner can take many minutes to load and answer. node:http has no
// timeout of its own, and replies are streamed, so the only limit on a call is the run's own
// time budget (deadline).

const http = require('http');

const DEFAULT_HOST = '127.0.0.1:11434';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The base URL for a host, which must be loopback.
function baseUrl(host = process.env.OLLAMA_HOST || DEFAULT_HOST) {
  const url = new URL(/^https?:\/\//.test(host) ? host : `http://${host}`);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to use Ollama at ${url.hostname}. Docturnal only talks to the Ollama server on the runner itself.`);
  }
  return url.origin;
}

// One HTTP request to the Ollama server. With onLine, the reply is read as one JSON object per
// line and each is passed to onLine; otherwise the whole reply is parsed as JSON and returned.
// deadline: a time in ms after which the call is abandoned.
function request({ method = 'POST', path, payload, host, deadline, onLine }) {
  const target = new URL(`${baseUrl(host)}${path}`);
  const options = { method, headers: { 'content-type': 'application/json' } };

  return new Promise((resolvePromise, reject) => {
    let timer;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise(value);
    };

    const send = () => {
      const req = http.request(target, options, (res) => {
        res.setEncoding('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => finish(new Error(`Ollama ${path} returned ${res.statusCode}: ${body.slice(0, 500)}`)));
          res.on('error', (err) => finish(err));
          return;
        }
        let buffer = '';
        const readLine = (line) => {
          if (!line.trim()) return;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            throw new Error('Ollama sent a malformed reply');
          }
          if (chunk.error) throw new Error(`Ollama ${path} failed: ${String(chunk.error).slice(0, 500)}`);
          onLine(chunk);
        };
        res.on('data', (chunk) => {
          buffer += chunk;
          if (!onLine) return;
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
            if (onLine) {
              readLine(buffer);
              finish(null);
            } else {
              finish(null, JSON.parse(buffer));
            }
          } catch (err) {
            finish(err instanceof SyntaxError ? new Error('Ollama sent a malformed reply') : err);
          }
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
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    send();
  });
}

// Sends one /api/chat request and returns the reply's text. With no messages, Ollama only
// loads the model. keepAlive: how long Ollama keeps the model loaded afterward, such as "30m".
// withReason: return { content, doneReason } instead, where doneReason is Ollama's done_reason,
// such as "stop", or "length" when the reply reached num_predict and was cut off.
async function chat({ model, messages, format, options, host, keepAlive, deadline, withReason = false }) {
  const payload = { model, messages, stream: true };
  if (format !== undefined) payload.format = format;
  if (options !== undefined) payload.options = options;
  if (keepAlive !== undefined) payload.keep_alive = keepAlive;
  let content = '';
  let done = false;
  let doneReason = null;
  await request({
    path: '/api/chat',
    payload,
    host,
    deadline,
    onLine: (chunk) => {
      if (chunk.message && typeof chunk.message.content === 'string') content += chunk.message.content;
      if (chunk.done) {
        done = true;
        if (typeof chunk.done_reason === 'string') doneReason = chunk.done_reason;
      }
    },
  });
  if (!done) throw new Error('Ollama closed the reply before it finished');
  return withReason ? { content, doneReason } : content;
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
function loggedChat(chatFn, { log = console.log, now = Date.now, deadline } = {}) {
  return async (req) => {
    const started = now();
    const what = `${req.label || (req.messages && req.messages.length ? 'request' : 'load')} with ${req.model}`;
    const seconds = () => `${((now() - started) / 1000).toFixed(1)} s`;
    try {
      const content = await chatFn({ ...req, deadline: req.deadline !== undefined ? req.deadline : deadline });
      const cut = content && typeof content === 'object' && content.doneReason === 'length';
      log(`Ollama: ${what}, ${seconds()}${cut ? ', stopped at its length limit' : ''}`);
      return content;
    } catch (err) {
      log(`Ollama: ${what} failed after ${seconds()}: ${describeError(err)}`);
      throw err;
    }
  };
}

module.exports = {
  DEFAULT_HOST,
  baseUrl,
  chat,
  describeError,
  loggedChat,
};
