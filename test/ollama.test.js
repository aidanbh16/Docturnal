'use strict';

// The Ollama client: no timeout of its own, streamed replies, the run's deadline as the only
// limit, and a log line per call that never holds a prompt.

const test = require('node:test');
const assert = require('node:assert');

const { chat, describeError, loggedChat } = require('../src/ollama');
const { startMockOllama } = require('./mock-ollama');

const MESSAGES = [{ role: 'user', content: 'SECRET_CODE_LINE' }];

// A mock whose reply, headers included, waits `ms` on setTimeout before it is sent.
async function slowMock(ms) {
  let arrived;
  const received = new Promise((resolve) => {
    arrived = resolve;
  });
  const mock = await startMockOllama(async () => {
    arrived();
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true };
  });
  return { mock, received };
}

test('a reply whose headers take more than 300 seconds still arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mock, received } = await slowMock(301000);
  try {
    const reply = chat({ model: 'm', messages: MESSAGES, host: mock.host });
    await received;
    t.mock.timers.tick(301000);
    assert.strictEqual(await reply, '{"ok":true}');
  } finally {
    t.mock.timers.reset();
    await mock.close();
  }
});

// Fake timers cannot reach timers inside Node's networking, so the same wait in real time
// takes 5 minutes and runs only with DOCTURNAL_SLOW_TESTS=1.
test('real time: 305 seconds without headers, the client still succeeds', {
  skip: process.env.DOCTURNAL_SLOW_TESTS !== '1' && 'set DOCTURNAL_SLOW_TESTS=1 to run',
  timeout: 400000,
}, async () => {
  const { mock } = await slowMock(305000);
  try {
    assert.strictEqual(await chat({ model: 'm', messages: MESSAGES, host: mock.host }), '{"ok":true}');
  } finally {
    await mock.close();
  }
});

test('reads a streamed reply in pieces and sends stream: true', async () => {
  const mock = await startMockOllama(() => ({ comments: [], summary: 'A fairly long summary so the reply arrives in several pieces.' }));
  try {
    const reply = await chat({ model: 'm', messages: MESSAGES, host: mock.host, options: { num_ctx: 4096 }, format: { type: 'object' } });
    assert.deepStrictEqual(JSON.parse(reply), { comments: [], summary: 'A fairly long summary so the reply arrives in several pieces.' });
    assert.strictEqual(mock.requests[0].stream, true);
    assert.deepStrictEqual(mock.requests[0].options, { num_ctx: 4096 });
  } finally {
    await mock.close();
  }
});

test('a request without messages loads the model and sends keep_alive', async () => {
  const mock = await startMockOllama(() => 'ignored');
  try {
    assert.strictEqual(await chat({ model: 'docs', messages: [], keepAlive: '30m', host: mock.host }), '');
    assert.strictEqual(mock.requests[0].keep_alive, '30m');
  } finally {
    await mock.close();
  }
});

test('errors: a failing status, an error inside the stream, a cut connection, and a reply without done', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url !== '/api/chat') return;
      const mode = req.headers['x-mode'];
      if (mode === 'status') {
        res.writeHead(500);
        res.end('{"error":"model requires more system memory"}');
      } else if (mode === 'chunk') {
        res.writeHead(200);
        res.end('{"message":{"content":"a"},"done":false}\n{"error":"llama runner process has terminated"}\n');
      } else if (mode === 'cut') {
        res.writeHead(200);
        res.write('{"message":{"content":"a"},"done":false}\n');
        res.socket.destroy();
      } else {
        res.writeHead(200);
        res.end('{"message":{"content":"a"},"done":false}\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  // The client sends no custom headers, so each call adds one that tells the server what to do.
  const originalRequest = http.request;
  const call = (mode) => {
    http.request = (url, options, cb) => originalRequest(url, { ...options, headers: { ...options.headers, 'x-mode': mode } }, cb);
    try {
      return chat({ model: 'm', messages: MESSAGES, host });
    } finally {
      http.request = originalRequest;
    }
  };
  try {
    await assert.rejects(call('status'), /returned 500: \{"error":"model requires more system memory"\}/);
    await assert.rejects(call('chunk'), /failed: llama runner process has terminated/);
    await assert.rejects(call('cut'));
    await assert.rejects(call('nodone'), /closed the reply before it finished/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the run\'s deadline is the only limit on a call', async () => {
  const { mock, received } = await slowMock(60000);
  try {
    const reply = chat({ model: 'm', messages: MESSAGES, host: mock.host, deadline: Date.now() + 200 });
    await received;
    await assert.rejects(reply, /the time budget ran out/);
  } finally {
    await mock.close();
  }
});

test('every call is logged with its label, model, and duration; a failure with its cause; never the prompt', async () => {
  const logs = [];
  let clock = 0;
  const now = () => clock;
  const ok = loggedChat(async () => {
    clock += 41200;
    return 'reply';
  }, { log: (line) => logs.push(line), now });
  assert.strictEqual(await ok({ label: 'accuracy check for src/payroll.js', model: 'qwen2.5-coder:7b', messages: MESSAGES }), 'reply');

  const failure = new TypeError('fetch failed');
  failure.cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  const bad = loggedChat(async () => {
    clock += 300000;
    throw failure;
  }, { log: (line) => logs.push(line), now });
  await assert.rejects(bad({ label: 'layer doc api', model: 'qwen2.5-coder:7b', messages: MESSAGES }), /fetch failed/);
  await assert.rejects(bad({ model: 'docs', messages: [] }));

  assert.deepStrictEqual(logs, [
    'Ollama: accuracy check for src/payroll.js with qwen2.5-coder:7b, 41.2 s',
    'Ollama: layer doc api with qwen2.5-coder:7b failed after 300.0 s: fetch failed; cause: UND_ERR_HEADERS_TIMEOUT Headers Timeout Error',
    'Ollama: load with docs failed after 300.0 s: fetch failed; cause: UND_ERR_HEADERS_TIMEOUT Headers Timeout Error',
  ]);
  assert.ok(!logs.join('\n').includes('SECRET_CODE_LINE'));
  assert.strictEqual(describeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'socket hang up; code ECONNRESET');
});
