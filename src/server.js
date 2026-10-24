'use strict';

// Docturnal for teams: checks the Ollama server named by ollama-url before any code is sent
// to it. It resolves the host and allows it only on loopback or private addresses (unless
// allow-public-ollama is "true"), checks that the server answers at /api/tags, and makes sure
// the models are there: it asks the server to pull a missing model through /api/pull, or,
// when pull-models is "false", fails and names the model. Uses Node built-ins only, so it runs
// before npm install. Never contacts anything but that server.

const ollama = require('./ollama');

class ServerError extends Error {}

function hasModel(names, model) {
  const bare = (name) => name.replace(/:latest$/, '');
  return names.some((name) => name === model || bare(name) === bare(model));
}

// Returns { addresses, pulled }. Throws ServerError with a one-line message on failure.
async function checkServer({ env = process.env, models = [], log = console.log, resolve } = {}) {
  const server = ollama.remoteServer(env);
  if (!server) throw new ServerError('ollama-url is not set.');
  const hostname = server.url.hostname.replace(/^\[|\]$/g, '');

  let addresses;
  try {
    addresses = await ollama.checkHost(hostname, { allowPublic: server.allowPublic, resolve });
  } catch (err) {
    throw new ServerError(err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
      ? `Docturnal cannot resolve the Ollama server ${hostname} from ollama-url. Check the address and this runner's DNS.`
      : err.message);
  }
  log(`Docturnal: Ollama server ${hostname} at ${addresses.map((a) => a.address).join(', ')}${server.allowPublic ? ' (allow-public-ollama is on)' : ''}`);

  let tags;
  try {
    tags = await ollama.request({ method: 'GET', path: '/api/tags', host: server.url.href, env, resolve });
  } catch (err) {
    throw new ServerError(`Docturnal cannot reach the Ollama server at ${server.base} (${ollama.describeError(err)}). ` +
      'Check ollama-url, and that the server is running and reachable from this runner.');
  }
  const names = Array.isArray(tags && tags.models) ? tags.models.map((m) => m && m.name).filter((n) => typeof n === 'string') : [];

  const pullModels = (env.INPUT_PULL_MODELS || 'true').trim().toLowerCase() !== 'false';
  const pulled = [];
  for (const model of [...new Set(models.filter(Boolean))]) {
    if (hasModel(names, model)) continue;
    if (!pullModels) {
      throw new ServerError(`The Ollama server at ${server.base} does not have the model ${model}, and pull-models is "false". ` +
        `Run "ollama pull ${model}" on the server, or set pull-models to "true".`);
    }
    log(`Docturnal: asking the Ollama server to pull ${model}`);
    let last = '';
    try {
      await ollama.request({
        path: '/api/pull',
        payload: { model, stream: true },
        host: server.url.href,
        env,
        resolve,
        onLine: (chunk) => {
          // Logs each new stage, not every progress update.
          if (chunk.status && chunk.status !== last && !chunk.completed) {
            last = chunk.status;
            log(`Docturnal: ${model}: ${chunk.status}`);
          }
        },
      });
    } catch (err) {
      throw new ServerError(`The Ollama server at ${server.base} could not pull ${model} (${ollama.describeError(err)}).`);
    }
    pulled.push(model);
  }
  return { addresses, pulled };
}

if (require.main === module) {
  checkServer({ models: [process.env.COMMENT_MODEL, process.env.DOCS_MODEL] }).catch((err) => {
    console.error(`::error::${err instanceof ServerError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { ServerError, checkServer, hasModel };
