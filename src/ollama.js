'use strict';

// Minimal client for the local Ollama server. Refuses any host that is not loopback,
// so source code can never be sent off the runner.

const DEFAULT_HOST = '127.0.0.1:11434';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function baseUrl(host = process.env.OLLAMA_HOST || DEFAULT_HOST) {
  const url = new URL(/^https?:\/\//.test(host) ? host : `http://${host}`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to use Ollama at ${url.hostname}. Docturnal only talks to a local server.`);
  }
  return url.origin;
}

async function chat({ model, messages, format, options = {}, host, timeoutMs = 10 * 60 * 1000 }) {
  const res = await fetch(`${baseUrl(host)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, format, options, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama /api/chat returned ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = await res.json();
  return body.message && typeof body.message.content === 'string' ? body.message.content : '';
}

module.exports = { DEFAULT_HOST, baseUrl, chat };
