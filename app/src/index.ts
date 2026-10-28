// The Docturnal GitHub App backend. It receives webhooks at POST /webhook, serves the
// optional settings page at /setup, works through repository setup on a queue, and starts
// nightly runs from an hourly cron. It only makes GitHub API calls; it never reads code.

import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import {
  type Deps,
  InfrastructureError,
  type Outcome,
  type PathStyle,
  type QueueMessage,
  dispatchRun,
  failure,
  offerWorkflowUpdate,
  onInstallationDeleted,
  onRepositoriesRemoved,
  onPullRequestClosed,
  onSetupMerged,
  onUpdatePush,
  queueSetups,
  setUpRepository,
  workflowVersion,
} from './handlers';
import { runSchedule } from './scheduler';
import { SettingsStore } from './settings';
import { withApiVersion } from './github';
import { handleSetup } from './setup';

export interface Env {
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  SETUP_QUEUE: Queue<QueueMessage>;
  SETTINGS: KVNamespace;
  GITHUB_API_URL?: string;
  GITHUB_WEB_URL?: string;
  // The Worker's public address, for the settings link in pull requests opened from the
  // cron, which has no incoming request to take it from.
  PUBLIC_URL?: string;
  ACTION_REPOSITORY?: string;
  CONTENTS_PATH_STYLE?: string;
}

export interface Options {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  // Waits between checks on the settings page; replaceable so tests need not wait.
  sleep?: (ms: number) => Promise<void>;
}

// Secrets set through a pipe (echo, PowerShell) end with a newline, which would break the
// webhook signature check.
function normalizeEnv(raw: Env): Env {
  return {
    ...raw,
    APP_ID: (raw.APP_ID ?? '').trim(),
    PRIVATE_KEY: (raw.PRIVATE_KEY ?? '').trim(),
    WEBHOOK_SECRET: (raw.WEBHOOK_SECRET ?? '').trim(),
    CLIENT_ID: (raw.CLIENT_ID ?? '').trim(),
    CLIENT_SECRET: (raw.CLIENT_SECRET ?? '').trim(),
    ACTION_REPOSITORY: (raw.ACTION_REPOSITORY ?? '').trim(),
    PUBLIC_URL: (raw.PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
  };
}

// Checks if the required environment variables are set.
function missingConfig(env: Env, needed: string[]): string | null {
  const bindings = ['SETUP_QUEUE', 'SETTINGS'];
  const missing = needed.filter((key) => !env[key as keyof Env]).map((key) => (bindings.includes(key) ? `the ${key} binding` : key));
  return missing.length ? missing.join(', ') : null;
}

const WEBHOOK_NEEDS = ['APP_ID', 'PRIVATE_KEY', 'WEBHOOK_SECRET', 'SETUP_QUEUE', 'SETTINGS'];
const SETUP_NEEDS = ['APP_ID', 'PRIVATE_KEY', 'CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_SECRET', 'SETTINGS'];

// Creates dependencies for the app, including logging and settings.
function makeDeps(env: Env, log: (line: string) => void, origin?: string, now?: () => number): Deps {
  return {
    log,
    now,
    origin: origin || env.PUBLIC_URL || undefined,
    actionRepository: env.ACTION_REPOSITORY ?? '',
    pathStyle: (env.CONTENTS_PATH_STYLE === 'plain' ? 'plain' : 'encoded') as PathStyle,
    settings: new SettingsStore(env.SETTINGS),
    enqueue: async (messages) => {
      await env.SETUP_QUEUE.sendBatch(messages);
    },
  };
}

// Creates an Octokit app instance with the provided environment variables and options.
function makeApp(env: Env, options: Options): App {
  return new App({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    webhooks: { secret: env.WEBHOOK_SECRET },
    Octokit: Octokit.plugin(withApiVersion).defaults({
      baseUrl: env.GITHUB_API_URL || 'https://api.github.com',
      request: options.fetch ? { fetch: options.fetch } : {},
    }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

function containsInfrastructureError(err: unknown): boolean {
  if (err instanceof InfrastructureError) return true;
  const nested = (err as { errors?: unknown[] })?.errors;
  return Array.isArray(nested) && nested.some(containsInfrastructureError);
}

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

// Handles incoming webhooks, verifying the signature and processing the payload.
async function handleWebhook(request: Request, env: Env, options: Options, log: (line: string) => void): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed\n', { status: 405 });
  const missing = missingConfig(env, WEBHOOK_NEEDS);
  if (missing) {
    log(`webhook: rejected, not configured (missing ${missing})`);
    return new Response('Not configured\n', { status: 500 });
  }

  const deps = makeDeps(env, log, new URL(request.url).origin, options.now);
  const app = makeApp(env, options);

  // GitHub caps webhook payloads at 25 MB; anything larger is refused before it is read.
  if (Number(request.headers.get('content-length') || 0) > MAX_WEBHOOK_BYTES) {
    log('webhook: rejected, payload too large');
    return new Response('Payload too large\n', { status: 413 });
  }
  // Verify the signature before anything else, including parsing the body.
  const body = await request.text();
  if (body.length > MAX_WEBHOOK_BYTES) {
    log('webhook: rejected, payload too large');
    return new Response('Payload too large\n', { status: 413 });
  }
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const valid = signature !== '' && (await app.webhooks.verify(body, signature).catch(() => false));
  if (!valid) {
    log('webhook: rejected, bad signature');
    return new Response('Bad signature\n', { status: 401 });
  }

  const name = request.headers.get('x-github-event') ?? '';
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    log(`webhook ${name}: ignored, the body is not JSON`);
    return new Response('ok\n', { status: 200 });
  }
  if (env.PRIVATE_KEY.includes('BEGIN RSA PRIVATE KEY')) {
    log('webhook: PRIVATE_KEY is in PKCS#1 format; convert it to PKCS#8 (see DEPLOY.md)');
    return new Response('ok\n', { status: 200 });
  }

  app.webhooks.on('installation.created', async ({ payload: p }) => {
    await queueSetups(p.installation.id, (p.repositories ?? []).map((r) => r.full_name), deps);
  });
  app.webhooks.on('installation.deleted', async ({ payload: p }) => {
    await onInstallationDeleted(p.installation.id, deps);
  });
  app.webhooks.on('installation_repositories.added', async ({ payload: p }) => {
    await queueSetups(p.installation.id, p.repositories_added.map((r) => r.full_name), deps);
  });
  app.webhooks.on('installation_repositories.removed', async ({ payload: p }) => {
    await onRepositoriesRemoved(p.installation.id, p.repositories_removed.map((r) => r.full_name), deps);
  });
  app.webhooks.on('pull_request.closed', async ({ octokit, payload: p }) => {
    if (!p.installation) return;
    await onSetupMerged(p, deps);
    await onPullRequestClosed(octokit, p, deps);
  });
  app.webhooks.on('push', async ({ octokit, payload: p }) => {
    // Without an installation the app cannot act on this repository.
    if (p.installation) await onUpdatePush(octokit, p, deps);
  });

  // Handlers are short: setup work goes to the queue. GitHub API failures are logged and
  // answered with 200, so GitHub does not retry. Only a failure to queue work or store
  // settings answers 503, which keeps the delivery in GitHub's list for redelivery.
  try {
    await app.webhooks.receive({ id: request.headers.get('x-github-delivery') ?? '', name, payload } as any);
  } catch (err) {
    if (containsInfrastructureError(err)) {
      log(`webhook ${name}: failed to queue work or store settings, redeliver it from the app's Advanced settings`);
      return new Response('Could not queue work\n', { status: 503 });
    }
    log(`webhook ${name}: failed, ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  return new Response('ok\n', { status: 200 });
}

// Creates a handler function for incoming requests,
// normalizing the environment and routing the request.
export function createHandler(options: Options = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  const route = routeRequest(options, log);
  return async (request: Request, rawEnv: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> => withSecurityHeaders(await route(request, rawEnv, ctx));
}

// Headers on every response from the Worker: browsers must not guess content types, and must
// reach it over HTTPS only.
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Routes incoming requests to the appropriate handler based on the path.
function routeRequest(options: Options, log: (line: string) => void) {
  return async (request: Request, rawEnv: Env, _ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> => {
    const env = normalizeEnv(rawEnv);
    const { pathname } = new URL(request.url);
    if (pathname === '/webhook') return handleWebhook(request, env, options, log);
    if (pathname === '/setup') {
      const missing = missingConfig(env, SETUP_NEEDS);
      if (missing) {
        log(`setup: not configured (missing ${missing})`);
        return new Response('Docturnal settings are not available yet.\n', { status: 503 });
      }
      // Workers require the global fetch to be called unbound; as a method of the options
      // object it throws "Illegal invocation".
      const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
      const installationRepoCount = async (installationId: number) => {
        const octokit = (await makeApp(env, options).getInstallationOctokit(installationId)) as unknown as Octokit;
        const response = await octokit.request('GET /installation/repositories', { per_page: 1 });
        return (response.data as { total_count: number }).total_count;
      };
      // The workflow version of each repository, read on its default branch as the app.
      const workflowVersions = async (installationId: number, repos: string[]) => {
        const octokit = (await makeApp(env, options).getInstallationOctokit(installationId)) as unknown as Octokit;
        const deps = makeDeps(env, log, new URL(request.url).origin);
        const entries = await Promise.all(repos.map(async (full) => {
          const [owner, repo] = full.split('/');
          return [full, await workflowVersion(octokit, { owner, repo }, undefined, deps)] as [string, number | null];
        }));
        return new Map(entries);
      };
      // One queue message per repository, so each update is its own piece of work.
      const requestWorkflowUpdates = async (installationId: number, repos: string[], origin: string) => {
        const messages = repos.map((repo) => ({ body: { kind: 'workflow-update', installationId, repo, origin } as QueueMessage }));
        for (let i = 0; i < messages.length; i += 100) await env.SETUP_QUEUE.sendBatch(messages.slice(i, i + 100));
      };
      return handleSetup(request, env, { fetch: doFetch, log, now: options.now ?? Date.now, sleep: options.sleep, installationRepoCount, workflowVersions, requestWorkflowUpdates });
    }
    return new Response('Not found\n', { status: 404 });
  };
}

// Processes queued setup and dispatch messages, one repository per message.
export function createQueueHandler(options: Options = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  return async (batch: MessageBatch<QueueMessage>, rawEnv: Env): Promise<void> => {
    const env = normalizeEnv(rawEnv);
    const missing = missingConfig(env, WEBHOOK_NEEDS);
    if (missing) {
      log(`queue: not configured (missing ${missing}), retrying later`);
      batch.retryAll({ delaySeconds: 300 });
      return;
    }
    const deps = makeDeps(env, log, undefined, options.now);
    const app = makeApp(env, options);
    for (const message of batch.messages) {
      const body = message.body;
      let outcome: Outcome;
      try {
        const octokit = (await app.getInstallationOctokit(body.installationId)) as unknown as Octokit;
        outcome = body.kind === 'setup'
          ? await setUpRepository(octokit, body, message.attempts, deps)
          : body.kind === 'workflow-update'
            ? await offerWorkflowUpdate(octokit, body, message.attempts, deps)
            : await dispatchRun(octokit, body, message.attempts, deps);
      } catch (err) {
        outcome = failure(`${body.kind} ${body.repo}`, err, message.attempts, deps);
      }
      if (outcome.retry) message.retry({ delaySeconds: outcome.delaySeconds });
      else message.ack();
    }
  };
}

// The hourly cron: queues a run for each repository whose chosen local hour has arrived.
export function createScheduledHandler(options: Options = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  return async (scheduledTime: number, rawEnv: Env): Promise<void> => {
    const env = normalizeEnv(rawEnv);
    const missing = missingConfig(env, ['SETTINGS', 'SETUP_QUEUE']);
    if (missing) {
      log(`cron: not configured (missing ${missing})`);
      return;
    }
    await runSchedule(env, new Date(scheduledTime), log);
  };
}

const handleFetch = createHandler();
const handleQueue = createQueueHandler();
const handleScheduled = createScheduledHandler();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
  queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },
  scheduled(controller: ScheduledController, env: Env): Promise<void> {
    return handleScheduled(controller.scheduledTime, env);
  },
};
