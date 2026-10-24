'use strict';

// Minimal client for the Ollama server. By default it refuses any host that is not loopback,
// so source code can never be sent off the runner. Docturnal for teams can name its own
// server with the ollama-url input: then that one server is allowed too, but only while every
// address its name resolves to is loopback or private, checked again at each connection, or
// when allow-public-ollama says so.
//
// It uses node:http rather than fetch, whose built-in client has timeouts of its own, and a
// large model on a CPU runner can take many minutes to load and answer. node:http has no
// timeout of its own, and replies are streamed, so the only limit on a call is the run's own
// time budget (deadline).

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_HOST = '127.0.0.1:11434';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Loopback and private ranges: the addresses a server inside your own network has.
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (!family) return false;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function parseUrl(host) {
  return new URL(/^https?:\/\//.test(host) ? host : `http://${host}`);
}

// The server named by the ollama-url input, or null in the default mode.
// Returns { url, origin, base, allowPublic }.
function remoteServer(env = process.env) {
  const raw = (env.INPUT_OLLAMA_URL || '').trim();
  if (!raw) return null;
  const url = parseUrl(raw);
  return {
    url,
    origin: url.origin,
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    allowPublic: (env.INPUT_ALLOW_PUBLIC_OLLAMA || '').trim().toLowerCase() === 'true',
  };
}

// The base URL for a host. Loopback hosts are always allowed; any other host only when it
// is the configured ollama-url server.
function baseUrl(host = process.env.OLLAMA_HOST || DEFAULT_HOST, env = process.env) {
  const url = parseUrl(host);
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  const remote = remoteServer(env);
  if (remote && remote.origin === url.origin) return remote.base;
  throw new Error(`Refusing to use Ollama at ${url.hostname}. Docturnal only talks to a local server, or to the one server set in ollama-url.`);
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

// Resolves a host and checks that every address is loopback or private, unless allowPublic.
// Returns the addresses; throws with a clear message otherwise. resolve: dns.lookup or a
// replacement for tests.
async function checkHost(hostname, { allowPublic = false, resolve = dns.lookup } = {}) {
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await new Promise((done, fail) => resolve(hostname, { all: true }, (err, list) => (err ? fail(err) : done(list))));
  const publicOnes = addresses.filter((a) => !isPrivateAddress(a.address));
  if (publicOnes.length && !allowPublic) {
    throw new Error(`The Ollama server ${hostname} resolves to the public address ${publicOnes.map((a) => a.address).join(', ')}. ` +
      'Docturnal sends your source code to this server, so it only uses servers on loopback or private addresses. ' +
      'Point ollama-url at a server inside your network, or set allow-public-ollama to "true" if you accept sending code to this address.');
  }
  return addresses;
}

// A lookup for node:http that refuses to connect to a public address, so a DNS answer that
// changes after the first check cannot send code elsewhere.
function guardedLookup({ allowPublic = false, resolve = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    checkHost(hostname, { allowPublic, resolve }).then((addresses) => {
      const wanted = options && options.family ? addresses.filter((a) => a.family === options.family) : addresses;
      const list = wanted.length ? wanted : addresses;
      if (options && options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    }, (err) => callback(err));
  };
}

// One HTTP request to the Ollama server. With onLine, the reply is read as one JSON object per
// line and each is passed to onLine; otherwise the whole reply is parsed as JSON and returned.
// deadline: a time in ms after which the call is abandoned.
function request({ method = 'POST', path, payload, host, deadline, onLine, env = process.env, resolve }) {
  const target = new URL(`${baseUrl(host, env)}${path}`);
  const remote = remoteServer(env);
  const isRemote = Boolean(remote) && !LOOPBACK_HOSTS.has(target.hostname);
  const options = { method, headers: { 'content-type': 'application/json' } };
  // A new connection for each request to a remote server, so its address is checked every time.
  if (isRemote) Object.assign(options, { agent: false, lookup: guardedLookup({ allowPublic: remote.allowPublic, resolve }) });

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
      const req = (target.protocol === 'https:' ? https : http).request(target, options, (res) => {
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

    // node:http skips the lookup for an IP address, so check one before connecting.
    if (isRemote && net.isIP(hostnameOf(target))) {
      checkHost(hostnameOf(target), { allowPublic: remote.allowPublic }).then(send, (err) => finish(err));
    } else {
      send();
    }
  });
}

// Sends one /api/chat request and returns the reply's text. With no messages, Ollama only
// loads the model. keepAlive: how long Ollama keeps the model loaded afterward, such as "30m".
async function chat({ model, messages, format, options, host, keepAlive, deadline, env, resolve }) {
  const payload = { model, messages, stream: true };
  if (format !== undefined) payload.format = format;
  if (options !== undefined) payload.options = options;
  if (keepAlive !== undefined) payload.keep_alive = keepAlive;
  let content = '';
  let done = false;
  await request({
    path: '/api/chat',
    payload,
    host,
    deadline,
    env,
    resolve,
    onLine: (chunk) => {
      if (chunk.message && typeof chunk.message.content === 'string') content += chunk.message.content;
      if (chunk.done) done = true;
    },
  });
  if (!done) throw new Error('Ollama closed the reply before it finished');
  return content;
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
      log(`Ollama: ${what}, ${seconds()}`);
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
  checkHost,
  describeError,
  guardedLookup,
  isPrivateAddress,
  loggedChat,
  remoteServer,
  request,
};
