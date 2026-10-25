import { createHmac, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { createHandler, createQueueHandler, createScheduledHandler, type Env } from '../src/index';
import {
  type QueueMessage,
  SETUP_PR_TITLE,
  UPDATE_PR_TITLE,
  WORKFLOW_UPDATE_PR_TITLE,
  resetRealApiChecks,
} from '../src/handlers';
import { SettingsStore } from '../src/settings';
import { createSession, SESSION_COOKIE } from '../src/setup';
import { WORKFLOW_PATH, WORKFLOW_VERSION, isOldTemplate, templateVersion, workflowYaml } from '../src/workflow';
import { FakeKV } from './fake-kv';
import { FakeQueue } from './fake-queue';
import { createMockGitHub } from './mock-github.mjs';

const SECRET = 'webhook-secret';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ORIGIN = 'https://docturnal.example';
const SETTINGS_LINK = `[Change Docturnal settings](${ORIGIN}/setup?installation_id=1)`;

const REPO = {
  full_name: 'octo/hello',
  name: 'hello',
  owner: { login: 'octo', name: 'octo' },
  default_branch: 'main',
};
const WORKFLOW = workflowYaml('acme/docturnal');
const OLD_WORKFLOW = `name: Docturnal
on:
  schedule:
    - cron: "7 4 * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  docturnal:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: acme/docturnal@v1
        with:
          comment-level: heavy
`;

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// One test world: a mock GitHub, a fake queue and KV, and the log lines all handlers wrote.
function setup(mockOptions: Record<string, unknown> = {}, envOverrides: Partial<Env> = {}) {
  const gh = createMockGitHub(mockOptions);
  const queue = new FakeQueue<QueueMessage>();
  const kv = new FakeKV(2);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const env = {
    APP_ID: '12345',
    PRIVATE_KEY: PEM,
    WEBHOOK_SECRET: SECRET,
    CLIENT_ID: 'Iv1.client',
    CLIENT_SECRET: 'client-secret',
    GITHUB_API_URL: 'https://api.github.test',
    ACTION_REPOSITORY: 'acme/docturnal',
    SETUP_QUEUE: queue as unknown as Queue<QueueMessage>,
    SETTINGS: kv as unknown as KVNamespace,
    ...envOverrides,
  } as Env;

  async function deliver(event: string, payload: unknown, { signature }: { signature?: string } = {}) {
    const body = JSON.stringify(payload);
    const response = await createHandler({ fetch: gh.fetch, log })(
      new Request(`${ORIGIN}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': signature ?? sign(body),
        },
        body,
      }),
      env
    );
    return response.status;
  }

  // Each invocation gets a new handler, as a new Worker invocation would.
  async function drain(batchSize = 5) {
    await queue.drain((batch) => createQueueHandler({ fetch: gh.fetch, log })(batch, env), { batchSize });
  }

  async function cron(utc: string) {
    await createScheduledHandler({ log })(Date.parse(utc), env);
  }

  return { gh, queue, kv, logs, env, deliver, drain, cron };
}

const installation = (repos = ['octo/hello'], id = 1) => ({
  action: 'created',
  installation: { id, account: { login: 'octo' } },
  repositories: repos.map((full_name) => ({ full_name, name: full_name.split('/')[1] })),
  sender: { login: 'octo' },
});

const pushToUpdate = (sender = 'github-actions[bot]') => ({
  ref: 'refs/heads/docturnal/update',
  deleted: false,
  installation: { id: 1 },
  repository: REPO,
  sender: { login: sender },
});

// What a dispatch sends: templates from version 4 also take the Existing code setting.
const medium = { 'comment-level': 'medium' };
const current = { 'comment-level': 'medium', 'existing-code': 'gradual' };

beforeEach(() => resetRealApiChecks());

describe('webhook signature', () => {
  it('rejects a bad signature with 401 before doing anything', async () => {
    const t = setup();
    expect(await t.deliver('installation', installation(), { signature: sign('something else') })).toBe(401);
    expect(t.logs).toEqual(['webhook: rejected, bad signature']);
    expect(t.gh.state.calls).toEqual([]);
    expect(t.queue.pending).toEqual([]);
    expect(t.kv.data.size).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const t = setup();
    expect(await t.deliver('installation', installation(), { signature: '' })).toBe(401);
  });

  it('accepts secrets that end with a newline, as piped secrets do', async () => {
    const t = setup({}, { APP_ID: '12345\r\n', WEBHOOK_SECRET: `${SECRET}\n`, PRIVATE_KEY: `${PEM}\n` });
    expect(await t.deliver('installation', installation())).toBe(200);
    await t.drain();
    expect(t.gh.state.dispatches).toHaveLength(1);
  });
});

describe('installation', () => {
  it('stores default settings, then creates the workflow and starts the first run from the queue', async () => {
    const t = setup();
    expect(await t.deliver('installation', installation())).toBe(200);
    expect(t.logs).toEqual(['install 1: queued 1 repository for setup']);
    expect(t.gh.state.calls).toEqual([]);
    // The webhook writes one key per repository; without a settings key, the defaults apply.
    expect([...t.kv.data.keys()]).toEqual(['install:1:repo:octo/hello']);

    await t.drain();
    expect(t.gh.state.repos.get('octo/hello').files.get(`main:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.dispatches).toEqual([{ repo: 'octo/hello', workflow: 'docturnal.yml', ref: 'main', inputs: current }]);
    expect(t.logs.slice(1)).toEqual([
      'real-api check: GET /repos/octo/hello/contents/.github%2Fworkflows%2Fdocturnal.yml?ref=main -> 404 (path style encoded)',
      'real-api check: PUT /repos/octo/hello/contents/.github%2Fworkflows%2Fdocturnal.yml -> 201 (path style encoded)',
      'setup octo/hello: added .github/workflows/docturnal.yml to main, first run queued',
      'dispatch octo/hello: started the first run on main with medium comments',
    ]);
  });

  it('uses a comment level saved on the setup page before the first run starts', async () => {
    const t = setup();
    await t.deliver('installation', installation());
    await t.kv.put('install:1:settings', JSON.stringify({ time: 0, timeZone: 'America/New_York', commentLevel: 'heavy' }), { metadata: { time: 0, timeZone: 'America/New_York' } });
    await t.drain();
    expect(t.gh.state.dispatches[0].inputs).toEqual({ 'comment-level': 'heavy', 'existing-code': 'gradual' });
  });

  it('reads the choices from the key list when the settings key carries them, with no read per installation', async () => {
    const t = setup({ repos: ['octo/hello'] });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'low', existingCode: 'none', repos: ['octo/hello'] });
    t.kv.data.get('install:1:settings')!.metadata = { time: 0, timeZone: 'America/New_York', commentLevel: 'low', existingCode: 'none' };
    t.gh.state.repos.get('octo/hello').files.set(`main:${WORKFLOW_PATH}`, WORKFLOW);
    t.kv.reads.length = 0;
    await t.cron('2026-01-15T05:07:00Z');
    expect(t.kv.reads.filter((key: string) => !key.endsWith('*'))).toEqual([]);
    await t.drain();
    expect(t.gh.state.dispatches.map((d: { inputs: unknown }) => d.inputs)).toEqual([{ 'comment-level': 'low', 'existing-code': 'none' }]);
  });

  it('one installation whose settings cannot be read is skipped, never run with the defaults, and the others still run', async () => {
    const t = setup({ repos: ['octo/a', 'octo/b'] });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'off', repos: ['octo/a'] });
    t.kv.seed(2, { time: 0, timeZone: 'America/New_York', commentLevel: 'heavy', repos: ['octo/b'] });
    for (const repo of ['octo/a', 'octo/b']) t.gh.state.repos.get(repo).files.set(`main:${WORKFLOW_PATH}`, WORKFLOW);
    const get = t.kv.get.bind(t.kv);
    t.kv.get = (async (key: string, type?: string | { type: string }) => {
      if (key === 'install:1:settings') throw new Error('KV unavailable');
      return get(key, type);
    }) as typeof t.kv.get;
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    expect(t.gh.state.dispatches.map((d: { repo: string }) => d.repo)).toEqual(['octo/b']);
    expect(t.logs).toContain('cron 2026-01-15T05:07:00.000Z: skipped installation 1 this hour, could not read its settings (KV unavailable)');
  });

  it('a batch that cannot be queued does not stop the batches after it', async () => {
    const repos = Array.from({ length: 150 }, (_, i) => `octo/r${String(i).padStart(3, '0')}`);
    const t = setup({ repos });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos });
    t.queue.failNextSends = 1;
    await t.cron('2026-01-15T05:07:00Z');
    expect(t.queue.pending.length).toBe(50);
    expect(t.logs).toContain('cron 2026-01-15T05:07:00.000Z: could not queue 100 runs, Queue send failed');
    expect(t.logs).toContain('cron 2026-01-15T05:07:00.000Z: 1 installation due, queued 50 runs, 100 not queued');
  });

  it('passes the Existing code setting to a template that takes it, and never to an older one', async () => {
    const t = setup({ repos: ['octo/new', 'octo/old'] });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'low', existingCode: 'none', repos: ['octo/new', 'octo/old'] });
    t.gh.state.repos.get('octo/new').files.set(`main:${WORKFLOW_PATH}`, WORKFLOW);
    t.gh.state.repos.get('octo/old').files.set(`main:${WORKFLOW_PATH}`, WORKFLOW_V3);
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    const inputs = Object.fromEntries(t.gh.state.dispatches.map((d: { repo: string; inputs: unknown }) => [d.repo, d.inputs]));
    expect(inputs).toEqual({ 'octo/new': { 'comment-level': 'low', 'existing-code': 'none' }, 'octo/old': { 'comment-level': 'low' } });
  });

  it('sets up all 50 repositories of a large install across many invocations, with retries', async () => {
    const repos = Array.from({ length: 50 }, (_, i) => `octo/repo-${i + 1}`);
    // Seven writes fail with 502 and the first three dispatches find no workflow yet.
    const t = setup({ repos, failPuts: 7, dispatchNotFound: 3 });
    expect(await t.deliver('installation', installation(repos))).toBe(200);
    expect(t.queue.pending).toHaveLength(50);

    await t.drain(4);
    for (const repo of repos) {
      expect(t.gh.state.repos.get(repo).files.get(`main:${WORKFLOW_PATH}`), repo).toBe(WORKFLOW);
    }
    expect(new Set(t.gh.state.dispatches.map((d: { repo: string }) => d.repo))).toEqual(new Set(repos));
    expect(t.gh.state.dispatches).toHaveLength(50);
    expect(t.queue.deadLetters).toEqual([]);
    expect(t.queue.invocations).toBeGreaterThan(25);
    expect(t.logs.filter((l) => l.includes('will retry'))).toHaveLength(10);
    expect(t.logs.filter((l) => l.startsWith('real-api check: GET'))).toHaveLength(1);
    expect(t.logs.filter((l) => l.startsWith('real-api check: PUT'))).toHaveLength(1);
    expect(t.kv.repos(1)).toHaveLength(50);
  });

  it('adds and removes repositories in the stored settings, and deletes them on uninstall', async () => {
    const t = setup({ repos: ['octo/one', 'octo/two'] });
    await t.deliver('installation_repositories', {
      action: 'added',
      installation: { id: 1 },
      repositories_added: [{ full_name: 'octo/one' }, { full_name: 'octo/two' }],
    });
    await t.drain();
    expect(t.gh.state.dispatches.map((d: { repo: string }) => d.repo).sort()).toEqual(['octo/one', 'octo/two']);
    expect(t.kv.repos(1)).toEqual(['octo/one', 'octo/two']);
    await t.kv.put('install:1:settings', JSON.stringify({ time: 2, timeZone: 'UTC', commentLevel: 'low' }), { metadata: { time: 2, timeZone: 'UTC' } });

    await t.deliver('installation_repositories', { action: 'removed', installation: { id: 1 }, repositories_removed: [{ full_name: 'octo/one' }] });
    expect(t.kv.repos(1)).toEqual(['octo/two']);
    expect(t.kv.json('install:1:settings')).toEqual({ time: 2, timeZone: 'UTC', commentLevel: 'low' });

    // Uninstalling deletes every install:1: key, across list pages, and leaves installation 10 alone.
    await t.deliver('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'octo/three' }, { full_name: 'octo/four' }] });
    t.kv.seed(10, { time: 0, timeZone: 'UTC', commentLevel: 'low', repos: ['other/repo'] });
    await t.deliver('installation', { action: 'deleted', installation: { id: 1 } });
    expect([...t.kv.data.keys()].sort()).toEqual(['install:10:repo:other/repo', 'install:10:settings']);
    expect(t.logs.at(-1)).toBe('install 1: uninstalled, deleted its settings');
  });

  it('never overwrites an existing workflow file that is not Docturnal\'s', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: 'name: Mine\n' } });
    await t.deliver('installation', installation());
    await t.drain();
    expect(t.gh.state.repos.get('octo/hello').files.get(`main:${WORKFLOW_PATH}`)).toBe('name: Mine\n');
    expect(t.gh.state.calls.some((c: string) => c.startsWith('PUT '))).toBe(false);
    expect(t.gh.state.pulls).toEqual([]);
    expect(t.logs).toContain('setup octo/hello: .github/workflows/docturnal.yml already exists on main, left it unchanged');
  });

  it('replaces the old scheduled template once, through an "Update Docturnal workflow" pull request', async () => {
    expect(isOldTemplate(OLD_WORKFLOW)).toBe(true);
    expect(isOldTemplate(WORKFLOW)).toBe(false);
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: OLD_WORKFLOW } });
    await t.deliver('installation', installation());
    await t.drain();

    const repo = t.gh.state.repos.get('octo/hello');
    expect(repo.files.get(`main:${WORKFLOW_PATH}`)).toBe(OLD_WORKFLOW);
    expect(repo.files.get(`docturnal/workflow-update:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.pulls[0]).toMatchObject({ title: WORKFLOW_UPDATE_PR_TITLE, head: 'docturnal/workflow-update', base: 'main' });
    expect(t.gh.state.pulls[0].body.endsWith(SETTINGS_LINK)).toBe(true);
    expect(t.gh.state.dispatches).toEqual([]);
    expect(t.logs).toContain('setup octo/hello: the workflow has the old schedule, opened update pull request #1');

    expect(t.gh.state.pulls[0].body).toContain('<!-- docturnal-workflow-version: 5 -->');

    // While it is open, it is not proposed again.
    await t.deliver('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'octo/hello' }] });
    await t.drain();
    expect(t.logs).toContain('setup octo/hello: the workflow has the old schedule, update pull request #1 was already proposed');

    // Closing it without merging does not bring it back.
    t.gh.state.pulls[0].state = 'closed';
    await t.deliver('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'octo/hello' }] });
    await t.drain();
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.logs).toContain('setup octo/hello: the workflow has the old schedule, the update to version 5 was declined earlier, left it unchanged');
  });

  it('queues the first run on retry when an earlier attempt created the file but could not queue the run', async () => {
    const t = setup();
    await t.deliver('installation', installation());
    t.queue.failNextSends = 1;
    await t.drain();
    expect(t.gh.state.dispatches).toHaveLength(1);
    expect(t.logs).toContain('setup octo/hello: found the workflow from an earlier attempt, first run queued');
  });

  it('falls back to a setup pull request when the default branch is protected', async () => {
    const t = setup({ protectedBranches: ['main'] });
    await t.deliver('installation', installation());
    await t.drain();
    const repo = t.gh.state.repos.get('octo/hello');
    expect(repo.files.has(`main:${WORKFLOW_PATH}`)).toBe(false);
    expect(repo.files.get(`docturnal/setup:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.pulls[0]).toMatchObject({ title: SETUP_PR_TITLE, head: 'docturnal/setup', base: 'main', state: 'open' });
    expect(t.gh.state.pulls[0].body).toContain('Merge this pull request to turn Docturnal on.');
    expect(t.gh.state.pulls[0].body.endsWith(SETTINGS_LINK)).toBe(true);
    expect(t.gh.state.dispatches).toEqual([]);
    expect(t.logs).toContain('setup octo/hello: main is protected, opened setup pull request #1');
  });

  it('skips a repository the app cannot see, without retrying', async () => {
    const t = setup({ repos: [] });
    await t.deliver('installation', installation());
    await t.drain();
    expect(t.logs).toContain('setup octo/hello: skipped, the app cannot see this repository');
    expect(t.queue.invocations).toBe(1);
  });

  it('moves a repository to the dead letter queue after GitHub keeps failing', async () => {
    const t = setup({ failPuts: 1000 });
    await t.deliver('installation', installation());
    await t.drain();
    expect(t.queue.deadLetters).toEqual([{ kind: 'setup', installationId: 1, repo: 'octo/hello', origin: ORIGIN }]);
    expect(t.logs.at(-1)).toMatch(/^setup octo\/hello: gave up after 11 attempts, Server Error; the message moves to the dead letter queue$/);
  });

  it('answers 503 when the work cannot be queued, so the delivery can be redelivered', async () => {
    const t = setup();
    t.queue.failNextSends = 1;
    expect(await t.deliver('installation', installation())).toBe(503);
    expect(t.logs).toEqual(["webhook installation: failed to queue work or store settings, redeliver it from the app's Advanced settings"]);
  });

  it('sends unencoded slashes when CONTENTS_PATH_STYLE is plain', async () => {
    const t = setup({}, { CONTENTS_PATH_STYLE: 'plain' });
    await t.deliver('installation', installation());
    await t.drain();
    expect(t.gh.state.repos.get('octo/hello').files.get(`main:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.calls).toContain('PUT /repos/octo/hello/contents/.github/workflows/docturnal.yml');
    expect(t.logs).toContain('real-api check: PUT /repos/octo/hello/contents/.github/workflows/docturnal.yml -> 201 (path style plain)');
  });
});

describe('webhooks and settings saves at the same time', () => {
  // Sends a settings page save the way a signed-in browser does.
  async function saveSettings(t: ReturnType<typeof setup>, fields: Record<string, string>) {
    const cookie = `${SESSION_COOKIE}=${await createSession(t.env, { installationId: 1, account: 'octo', csrf: 'c' }, Date.now())}`;
    return createHandler({ fetch: t.gh.fetch, log: (line) => t.logs.push(line) })(
      new Request(`${ORIGIN}/setup`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'c', ...fields }).toString(),
      }),
      t.env
    );
  }

  it('keeps both repositories when two webhooks add different repositories at the same moment', async () => {
    const t = setup({ repos: ['octo/hello', 'octo/one', 'octo/two'] });
    t.kv.seed(1, { time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', repos: ['octo/hello'] });
    // Every KV write waits until both deliveries have written, so they truly overlap.
    const writes = t.kv.holdWrites(2);
    const added = (repo: string) => t.deliver('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: repo }] });
    const deliveries = Promise.all([added('octo/one'), added('octo/two')]);
    await writes.reached;
    writes.release();
    expect(await deliveries).toEqual([200, 200]);

    // Nothing was read and written back: no gets and no lists.
    expect(t.kv.reads.filter((key: string) => !key.endsWith('*'))).toEqual([]);
    expect(await new SettingsStore(t.env.SETTINGS).get(1)).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'gradual', repos: ['octo/hello', 'octo/one', 'octo/two'] });
  });

  it('keeps a repository added by a webhook and a settings save sent at the same moment', async () => {
    const t = setup({ repos: ['octo/hello', 'octo/new'] });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    const writes = t.kv.holdWrites(2);
    const both = Promise.all([
      t.deliver('installation_repositories', { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'octo/new' }] }),
      saveSettings(t, { time: '2', timeZone: 'America/Los_Angeles', commentLevel: 'heavy' }).then((r) => r.status),
    ]);
    await writes.reached;
    writes.release();
    expect(await both).toEqual([200, 200]);

    expect(await new SettingsStore(t.env.SETTINGS).get(1)).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'gradual', repos: ['octo/hello', 'octo/new'] });
    expect(t.kv.data.get('install:1:settings')!.metadata).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'gradual' });
  });
});

describe('nightly runs from the hourly cron', () => {
  it('runs a user who installed and closed the setup page at local midnight, New York time', async () => {
    const t = setup();
    await t.deliver('installation', installation());
    await t.drain();
    t.gh.state.dispatches.length = 0;

    await t.cron('2026-01-15T04:07:00Z'); // 11:07 PM in New York
    await t.cron('2026-01-15T05:07:00Z'); // 12:07 AM
    await t.cron('2026-01-15T06:07:00Z'); // 1:07 AM
    await t.drain();
    expect(t.gh.state.dispatches).toEqual([{ repo: 'octo/hello', workflow: 'docturnal.yml', ref: 'main', inputs: current }]);
    expect(t.logs).toContain('cron 2026-01-15T05:07:00.000Z: 1 installation due, queued 1 run');
    expect(t.logs).toContain('dispatch octo/hello: started the nightly run on main with medium comments');
  });

  it('runs a user who chose 2 AM in America/Los_Angeles at 2 AM Pacific, before and after daylight saving time', async () => {
    const t = setup({ repos: ['octo/hello', 'octo/a', 'octo/b'], files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW } });
    // Installation 1 keeps the defaults; installation 2 chose 2 AM Pacific with heavy comments.
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    t.kv.seed(2, { time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', repos: ['octo/a', 'octo/b'] });
    // An installation with a settings key but no repository list is never dispatched.
    await t.kv.put('install:3:settings', JSON.stringify({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'low' }), { metadata: { time: 2, timeZone: 'America/Los_Angeles' } });
    for (const repo of ['octo/a', 'octo/b']) t.gh.state.repos.get(repo).files.set(`main:${WORKFLOW_PATH}`, WORKFLOW);

    const heavy = { 'comment-level': 'heavy', 'existing-code': 'gradual' };
    const dispatchedAt = async (utc: string) => {
      t.gh.state.dispatches.length = 0;
      await t.cron(utc);
      await t.drain();
      return t.gh.state.dispatches.map((d: { repo: string; inputs: unknown }) => [d.repo, d.inputs]);
    };
    // 7 March, before the change: 2 AM PST is 10:00 UTC.
    expect(await dispatchedAt('2026-03-07T09:07:00Z')).toEqual([]);
    expect(await dispatchedAt('2026-03-07T10:07:00Z')).toEqual([['octo/a', heavy], ['octo/b', heavy]]);
    // 8 March, the day of the change: 2 AM does not exist, so the run comes at 3:07 AM PDT.
    expect(await dispatchedAt('2026-03-08T09:07:00Z')).toEqual([]);
    expect(await dispatchedAt('2026-03-08T10:07:00Z')).toEqual([['octo/a', heavy], ['octo/b', heavy]]);
    // 9 March, after the change: 2 AM PDT is 09:00 UTC.
    expect(await dispatchedAt('2026-03-09T09:07:00Z')).toEqual([['octo/a', heavy], ['octo/b', heavy]]);
    expect(await dispatchedAt('2026-03-09T10:07:00Z')).toEqual([]);
    // Midnight in New York (04:07 UTC in summer time) runs installation 1 only.
    expect(await dispatchedAt('2026-03-09T04:07:00Z')).toEqual([['octo/hello', current]]);
  });

  it('skips a repository without the workflow, and one still on the old template, without retrying', async () => {
    const t = setup({ repos: ['octo/hello', 'octo/old'], files: { [`main:${WORKFLOW_PATH}`]: 'x' } });
    t.gh.state.repos.get('octo/hello').files.delete(`main:${WORKFLOW_PATH}`);
    t.gh.state.repos.get('octo/old').files.set(`main:${WORKFLOW_PATH}`, OLD_WORKFLOW);
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello', 'octo/old'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    expect(t.gh.state.dispatches).toEqual([]);
    expect(t.queue.invocations).toBe(1);
    expect(t.logs).toContain('dispatch octo/hello: skipped, .github/workflows/docturnal.yml is not on main');
    expect(t.logs).toContain('dispatch octo/old: skipped, the workflow still has its own schedule');
  });
});

describe('setup pull request', () => {
  const closed = (merged: boolean, ref = 'docturnal/setup') => ({
    action: 'closed',
    installation: { id: 1 },
    repository: REPO,
    pull_request: { number: 1, merged, head: { ref, repo: { full_name: 'octo/hello' } }, base: { ref: 'main' } },
  });

  it('starts the first run when the setup pull request is merged, and deletes its branch', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW }, branches: ['docturnal/setup'] });
    await t.deliver('pull_request', closed(true));
    expect(t.logs).toEqual([
      'setup octo/hello: setup pull request #1 merged, first run queued',
      'pull request octo/hello#1: deleted docturnal/setup',
    ]);
    await t.drain();
    expect(t.gh.state.dispatches).toEqual([{ repo: 'octo/hello', workflow: 'docturnal.yml', ref: 'main', inputs: current }]);
  });

  it('starts no run and deletes nothing for a merged docturnal/setup pull request from a fork', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW }, branches: ['docturnal/setup'] });
    const fromFork = closed(true);
    fromFork.pull_request.head.repo = { full_name: 'someone/hello' };
    expect(await t.deliver('pull_request', fromFork)).toBe(200);
    expect(t.queue.pending).toEqual([]);
    await t.drain();
    expect(t.gh.state.dispatches).toEqual([]);
    expect(t.gh.state.calls).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it('starts no run when the setup pull request is closed without merging, and does nothing for other branches', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: 'x' }, branches: ['docturnal/setup'] });
    await t.deliver('pull_request', closed(false));
    await t.deliver('pull_request', closed(true, 'feature'));
    expect(t.queue.pending).toEqual([]);
    // Only the closed setup pull request's branch is deleted.
    expect(t.gh.state.calls.filter((c: string) => c.includes('/repos/'))).toEqual(['DELETE /repos/octo/hello/git/refs/heads/docturnal/setup']);
  });
});

describe('branch cleanup when a Docturnal pull request closes', () => {
  const closed = ({ merged = true, ref = 'docturnal/update', headRepo = 'octo/hello' as string | null } = {}) => ({
    action: 'closed',
    installation: { id: 1 },
    repository: REPO,
    pull_request: { number: 7, merged, head: { ref, repo: headRepo ? { full_name: headRepo } : null }, base: { ref: 'main' } },
  });
  const branchesOf = (t: ReturnType<typeof setup>) => [...t.gh.state.repos.get('octo/hello').branches.keys()];
  const ALL = ['docturnal/update', 'docturnal/setup', 'docturnal/workflow-update'];

  for (const ref of ALL) {
    it(`deletes ${ref} when its pull request is merged`, async () => {
      const t = setup({ branches: ALL });
      expect(await t.deliver('pull_request', closed({ ref }))).toBe(200);
      expect(branchesOf(t)).toEqual(['main', ...ALL.filter((b) => b !== ref)]);
      expect(t.gh.state.calls).toContain(`DELETE /repos/octo/hello/git/refs/heads/${ref}`);
      expect(t.logs).toContain(`pull request octo/hello#7: deleted ${ref}`);
    });
  }

  it('deletes docturnal/update when its pull request is closed without merging', async () => {
    const t = setup({ branches: ['docturnal/update'] });
    await t.deliver('pull_request', closed({ merged: false }));
    expect(branchesOf(t)).toEqual(['main']);
    expect(t.logs).toEqual(['pull request octo/hello#7: deleted docturnal/update']);
  });

  for (const status of ['in_progress', 'queued', 'pending']) {
    it(`keeps docturnal/update while a Docturnal run is ${status}`, async () => {
      const t = setup({ branches: ['docturnal/update'], runs: [{ repo: 'octo/hello', status }] });
      expect(await t.deliver('pull_request', closed())).toBe(200);
      expect(branchesOf(t)).toEqual(['main', 'docturnal/update']);
      expect(t.gh.state.calls.filter((c: string) => c.startsWith('DELETE'))).toEqual([]);
      expect(t.gh.state.calls).toContain('GET /repos/octo/hello/actions/workflows/docturnal.yml/runs');
      expect(t.logs).toEqual(['pull request octo/hello#7: kept docturnal/update, a Docturnal run is queued or in progress; the next closed pull request deletes it']);
    });
  }

  it('deletes docturnal/update when its pull request is closed without merging, even while a run is in progress', async () => {
    // The run's push then finds the branch gone and leaves its work for the next run.
    const t = setup({ branches: ['docturnal/update'], runs: [{ repo: 'octo/hello', status: 'in_progress' }] });
    await t.deliver('pull_request', closed({ merged: false }));
    expect(branchesOf(t)).toEqual(['main']);
    expect(t.logs).toEqual(['pull request octo/hello#7: deleted docturnal/update']);
  });

  it('deletes the setup and workflow update branches without checking for runs, since runs never push to them', async () => {
    const t = setup({ branches: ALL, runs: [{ repo: 'octo/hello', status: 'in_progress' }] });
    await t.deliver('pull_request', closed({ ref: 'docturnal/workflow-update' }));
    expect(branchesOf(t)).toEqual(['main', 'docturnal/update', 'docturnal/setup']);
    expect(t.gh.state.calls.filter((c: string) => c.includes('/repos/'))).toEqual(['DELETE /repos/octo/hello/git/refs/heads/docturnal/workflow-update']);
  });

  it('treats a branch that is already gone as deleted', async () => {
    const t = setup();
    expect(await t.deliver('pull_request', closed())).toBe(200);
    expect(t.logs).toEqual(['pull request octo/hello#7: docturnal/update was already deleted']);
  });

  it('ignores a pull request from a fork, from a deleted fork, or from a branch that is not Docturnal\'s', async () => {
    const t = setup({ branches: [...ALL, 'feature'] });
    await t.deliver('pull_request', closed({ headRepo: 'someone/hello' }));
    await t.deliver('pull_request', closed({ headRepo: null }));
    await t.deliver('pull_request', closed({ ref: 'feature' }));
    await t.deliver('pull_request', closed({ ref: 'docturnal/update-old' }));
    expect(t.gh.state.calls).toEqual([]);
    expect(branchesOf(t)).toEqual(['main', ...ALL, 'feature']);
    expect(t.logs).toEqual([]);
  });

  it('ignores a closed pull request without an installation', async () => {
    const t = setup({ branches: ['docturnal/update'] });
    const { installation: _, ...payload } = closed();
    await t.deliver('pull_request', payload);
    expect(t.gh.state.calls).toEqual([]);
  });
});

describe('push to docturnal/update', () => {
  it('creates the pull request the first time and updates it the second time, ending with the settings link', async () => {
    const t = setup({ files: { 'docturnal/update:.docturnal/last-run.md': '# Docturnal update\n\nFirst run.\n' } });
    await t.deliver('push', pushToUpdate());
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.pulls[0]).toMatchObject({
      title: UPDATE_PR_TITLE,
      head: 'docturnal/update',
      base: 'main',
      body: `# Docturnal update\n\nFirst run.\n\n---\n\n${SETTINGS_LINK}`,
    });
    expect(t.logs).toEqual(['push octo/hello: opened pull request #1']);

    t.gh.state.repos.get('octo/hello').files.set('docturnal/update:.docturnal/last-run.md', '# Docturnal update\n\nSecond run.\n');
    await t.deliver('push', pushToUpdate());
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.pulls[0].body).toBe(`# Docturnal update\n\nSecond run.\n\n---\n\n${SETTINGS_LINK}`);
    expect(t.logs.at(-1)).toBe('push octo/hello: updated pull request #1');
  });

  it("takes the title from last-run.md's first heading, and changes it when the pull request gets comments", async () => {
    const t = setup({ files: { 'docturnal/update:.docturnal/last-run.md': '# Docturnal: documentation\n\n## Progress\n\n- **Documentation:** complete.\n' } });
    await t.deliver('push', pushToUpdate());
    expect(t.gh.state.pulls[0]).toMatchObject({
      title: 'Docturnal: documentation',
      body: `## Progress\n\n- **Documentation:** complete.\n\n---\n\n${SETTINGS_LINK}`,
    });
    t.gh.state.repos.get('octo/hello').files.set('docturnal/update:.docturnal/last-run.md', '# Docturnal: comments and documentation\n\n## Progress\n\n- **Comments:** 5 of 21 files.\n');
    await t.deliver('push', pushToUpdate());
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.pulls[0]).toMatchObject({
      title: 'Docturnal: comments and documentation',
      body: `## Progress\n\n- **Comments:** 5 of 21 files.\n\n---\n\n${SETTINGS_LINK}`,
    });
    // A heading that does not name Docturnal stays in the body, under the usual title.
    t.gh.state.repos.get('octo/hello').files.set('docturnal/update:.docturnal/last-run.md', '# Something else\n\nText.\n');
    await t.deliver('push', pushToUpdate());
    expect(t.gh.state.pulls[0]).toMatchObject({ title: UPDATE_PR_TITLE, body: `# Something else\n\nText.\n\n---\n\n${SETTINGS_LINK}` });
  });

  it("ends the body with the settings link after the Action's last-run.md, which does not contain the link itself", async () => {
    // A report built by the Action's own code, with per-file comment counts.
    const { buildReport } = await import('../../src/report.js');
    const report: string = buildReport({
      processed: [{ path: 'math.js', verifier: 'typescript', added: 1, rejections: [], stats: { proposed: 3, added: 1, lineShift: 0, dropped: { placement: {}, length: {}, density: { 'level limit reached': 2 }, safety: {}, off: {} } } }],
      models: { comment: 'qwen2.5-coder:3b', docs: 'qwen2.5-coder:7b', level: 'medium' },
    });
    expect(report).not.toContain('Change Docturnal settings');
    const t = setup({ files: { 'docturnal/update:.docturnal/last-run.md': report } });
    await t.deliver('push', pushToUpdate());
    const body: string = t.gh.state.pulls[0].body;
    expect(body).toContain('| `math.js` | 1 | Yes (TypeScript) | proposed 3, 2 dropped by the density limit, 1 added |');
    expect(body.endsWith(`\n\n---\n\n${SETTINGS_LINK}`)).toBe(true);
  });

  it('keeps the settings link at the end when a long last-run.md is shortened', async () => {
    const long = `# Docturnal update\n\n${'- A line of the report.\n'.repeat(5000)}`;
    const t = setup({ files: { 'docturnal/update:.docturnal/last-run.md': long } });
    await t.deliver('push', pushToUpdate());
    const body: string = t.gh.state.pulls[0].body;
    // GitHub rejects pull request bodies over 65,536 characters.
    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body).toContain('The rest of this description is in `.docturnal/last-run.md`.');
    expect(body.endsWith(SETTINGS_LINK)).toBe(true);
  });

  it('ignores pushes by anyone but github-actions[bot] and pushes to other branches', async () => {
    const t = setup();
    await t.deliver('push', pushToUpdate('octo'));
    await t.deliver('push', { ...pushToUpdate(), ref: 'refs/heads/main' });
    await t.deliver('push', { ...pushToUpdate(), installation: undefined });
    expect(t.gh.state.calls).toEqual([]);
    expect(t.logs).toEqual(['push octo/hello: ignored a push to docturnal/update by octo']);
  });

  it('logs a failed pull request call and still returns 200', async () => {
    const t = setup({ failPulls: true });
    expect(await t.deliver('push', pushToUpdate())).toBe(200);
    expect(t.logs[0]).toMatch(/^push octo\/hello: failed to open or update the pull request/);
  });
});

describe('workflow template', () => {
  it('has no schedule, and takes comment-level and existing-code as dispatch inputs', () => {
    expect(WORKFLOW).not.toMatch(/schedule:|cron:/);
    expect(WORKFLOW).toContain(`on:
  workflow_dispatch:
    inputs:
      comment-level:
        description: "How many comments to add: low, medium, heavy, or off (docs only)."
        type: choice
        options: ["low", "medium", "heavy", "off"]
        default: "medium"
      existing-code:
        description: "Existing code: gradual (comment it in small batches) or none (only new and changed code)."
        type: choice
        options: ["gradual", "none"]
        default: "gradual"`);
    expect(WORKFLOW).toContain('permissions:\n  contents: write\n\n');
    expect(WORKFLOW).not.toContain('actions: write');
  });

  it('runs one job, whose timeout leaves at least 20 minutes after the time budget, with no artifacts', () => {
    expect(WORKFLOW).toContain(`jobs:
  docturnal:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      # Pinned to a full commit SHA, so the code that checks out your repository cannot change
      # without a new version of this workflow.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: acme/docturnal@v1
        with:
          comment-level: \${{ inputs['comment-level'] || 'medium' }}
          existing-code: \${{ inputs['existing-code'] || 'gradual' }}
          time-budget-minutes: "90"
          job-timeout-minutes: "120"
`);
    expect(WORKFLOW.endsWith('          job-timeout-minutes: "120"\n')).toBe(true);
    expect(WORKFLOW.split('\njobs:\n')[1].match(/^  [\w-]+:$/gm)).toEqual(['  docturnal:']);
    expect(WORKFLOW).not.toMatch(/mode:|artifact|matrix|needs:/);
  });

  it('pins every third-party action to a full commit SHA, with its version in a comment', () => {
    const references = [...WORKFLOW.matchAll(/^\s*- uses:\s*(.+)$/gm)].map((m) => m[1]);
    const thirdParty = references.filter((r) => !r.startsWith('acme/docturnal@'));
    expect(thirdParty).toEqual(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1']);
    for (const reference of thirdParty) expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    // Docturnal's own Action follows its release tag, which the app's maintainer moves.
    expect(references).toContain('acme/docturnal@v1');
  });
});

// Earlier templates, from the current one. Version 4 used the actions/checkout@v7 tag;
// version 3 also had no existing-code input and no time budget; version 2 used
// actions/checkout@v4; version 1 also had no version line and no concurrency block.
const WORKFLOW_V4 = WORKFLOW
  .replace(`# Docturnal workflow version ${WORKFLOW_VERSION}.\n`, '# Docturnal workflow version 4.\n')
  .replace("      # Pinned to a full commit SHA, so the code that checks out your repository cannot change\n      # without a new version of this workflow.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n", '      - uses: actions/checkout@v7\n');
const WORKFLOW_V3 = WORKFLOW_V4
  .replace('# Docturnal workflow version 4.\n', '# Docturnal workflow version 3.\n')
  .replace(/\n      existing-code:\n(?:        .*\n){4}/, '\n')
  .replace(/\n          existing-code: .*\n          time-budget-minutes: .*\n          job-timeout-minutes: .*\n/, '\n');
const WORKFLOW_V2 = WORKFLOW_V3
  .replace('# Docturnal workflow version 3.\n', '# Docturnal workflow version 2.\n')
  .replaceAll('actions/checkout@v7', 'actions/checkout@v4');
const WORKFLOW_V1 = WORKFLOW_V2
  .replace('# Docturnal workflow version 2.\n', '')
  .replace(/\n# One run at a time[\s\S]*?cancel-in-progress: false\n/, '');

describe('workflow versions', () => {
  it('lets one run at a time per repository, and carries its version', () => {
    expect(WORKFLOW).toContain('\nconcurrency:\n  group: docturnal\n  cancel-in-progress: false\n');
    expect(WORKFLOW).toContain(`\n# Docturnal workflow version ${WORKFLOW_VERSION}.\n`);
    expect(WORKFLOW_VERSION).toBe(5);
    expect(WORKFLOW_V4).toContain('      - uses: actions/checkout@v7\n');
    expect(templateVersion(WORKFLOW_V4, 'acme/docturnal')).toBe(4);
    expect(WORKFLOW_V1).not.toContain('concurrency');
    expect(WORKFLOW_V3).not.toContain('existing-code');
    expect(WORKFLOW_V3).not.toContain('time-budget-minutes');
    expect(WORKFLOW_V3).toContain("          comment-level: ${{ inputs['comment-level'] || 'medium' }}\n");
    expect(WORKFLOW_V2).toContain('actions/checkout@v4');
    expect(templateVersion(WORKFLOW, 'acme/docturnal')).toBe(5);
    expect(templateVersion(WORKFLOW_V3, 'acme/docturnal')).toBe(3);
    expect(templateVersion(WORKFLOW_V2, 'acme/docturnal')).toBe(2);
    expect(templateVersion(WORKFLOW_V1, 'acme/docturnal')).toBe(1);
    expect(templateVersion(OLD_WORKFLOW, 'acme/docturnal')).toBe(0);
    expect(templateVersion(workflowYaml('someone/my-docs-tool'), 'someone/my-docs-tool')).toBe(5);
    expect(templateVersion('jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n', 'acme/docturnal')).toBeNull();
  });

  it('proposes version 5 to a repository set up with version 1, listing every change since, through the update pull request', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V1 } });
    await t.deliver('installation', installation());
    await t.drain();
    const repo = t.gh.state.repos.get('octo/hello');
    expect(repo.files.get(`main:${WORKFLOW_PATH}`)).toBe(WORKFLOW_V1);
    expect(repo.files.get(`docturnal/workflow-update:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.pulls).toEqual([expect.objectContaining({ title: WORKFLOW_UPDATE_PR_TITLE, head: 'docturnal/workflow-update', state: 'open' })]);
    expect(t.gh.state.pulls[0].body).toContain('updates `.github/workflows/docturnal.yml` to version 5');
    expect(t.gh.state.pulls[0].body).toContain('The new version makes these changes:\n\n- Lets only one Docturnal run happen at a time');
    expect(t.gh.state.pulls[0].body).toContain('\n- Uses version 7 of `actions/checkout`, which runs on Node.js 24.');
    expect(t.gh.state.pulls[0].body).toContain('\n- Passes your "Existing code" setting to each run');
    expect(t.gh.state.pulls[0].body.endsWith(SETTINGS_LINK)).toBe(true);
    expect(t.logs).toContain('setup octo/hello: the workflow is version 1, opened update pull request #1');  });

  it('proposes version 5 to a repository on version 3, with the Existing code setting and the pinned checkout', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V3 } });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    const repo = t.gh.state.repos.get('octo/hello');
    expect(repo.files.get(`docturnal/workflow-update:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    const body = t.gh.state.pulls[0].body;
    expect(body).toContain('The new version makes these changes:\n\n- Passes your "Existing code" setting to each run');
    expect(body).toContain('\n- Pins `actions/checkout` to a full commit SHA');
    expect(body).not.toMatch(/parallel|artifact|actions: write/);
    expect(body).not.toContain('Node.js 24');
    expect(body).toContain('<!-- docturnal-workflow-version: 5 -->');
    // Version 3 runs as before until the pull request is merged, without the existing-code input.
    expect(t.gh.state.dispatches).toEqual([{ repo: 'octo/hello', workflow: 'docturnal.yml', ref: 'main', inputs: medium }]);
    expect(t.logs).toContain('dispatch octo/hello: the workflow is version 3, opened update pull request #1');
  });

  it('proposes version 5 to a repository on version 4, for the pinned checkout only, and still sends existing-code', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V4 } });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', existingCode: 'none', repos: ['octo/hello'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    const body = t.gh.state.pulls[0].body;
    expect(body).toContain('The new version pins `actions/checkout` to a full commit SHA');
    expect(body).not.toContain('Existing code');
    expect(t.gh.state.dispatches.map((d: { inputs: unknown }) => d.inputs)).toEqual([{ 'comment-level': 'medium', 'existing-code': 'none' }]);
  });

  it('proposes the update from the nightly run for existing installs, once, and still starts the run', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V1 } }, { PUBLIC_URL: ORIGIN });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    expect(t.gh.state.pulls).toHaveLength(1);
    // The cron has no incoming request, so the settings link comes from PUBLIC_URL.
    expect(t.gh.state.pulls[0].body.endsWith(SETTINGS_LINK)).toBe(true);
    expect(t.gh.state.dispatches).toEqual([{ repo: 'octo/hello', workflow: 'docturnal.yml', ref: 'main', inputs: medium }]);
    expect(t.logs).toContain('dispatch octo/hello: the workflow is version 1, opened update pull request #1');

    // The next night: no second pull request and no repeated log line.
    t.logs.length = 0;
    await t.cron('2026-01-16T05:07:00Z');
    await t.drain();
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.dispatches).toHaveLength(2);
    expect(t.logs.filter((l) => l.includes('update pull request'))).toEqual([]);
  });

  it('starts the update branch again from the default branch when an earlier update pull request was closed', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V1 } });
    const repo = t.gh.state.repos.get('octo/hello');
    // The version 1 proposal from before versions were recorded, merged long ago.
    repo.branches.set('docturnal/workflow-update', 'sha-old');
    repo.files.set(`docturnal/workflow-update:${WORKFLOW_PATH}`, WORKFLOW_V1);
    repo.files.set('docturnal/workflow-update:stale.txt', 'left from the earlier pull request');
    t.gh.state.pulls.push({ repo: 'octo/hello', number: 7, state: 'closed', title: WORKFLOW_UPDATE_PR_TITLE, head: 'docturnal/workflow-update', base: 'main', body: 'Docturnal now starts its nightly run from the app.' });
    t.gh.state.nextPull = 8;

    await t.deliver('installation', installation());
    await t.drain();
    expect(repo.branches.get('docturnal/workflow-update')).toBe('sha-base');
    expect(repo.files.has('docturnal/workflow-update:stale.txt')).toBe(false);
    expect(repo.files.get(`docturnal/workflow-update:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.pulls.map((p: { number: number; state: string }) => [p.number, p.state])).toEqual([[7, 'closed'], [8, 'open']]);
  });

  it('brings an open pull request for an older version up to date instead of opening another', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: OLD_WORKFLOW } });
    const repo = t.gh.state.repos.get('octo/hello');
    repo.branches.set('docturnal/workflow-update', 'sha-base');
    repo.files.set(`docturnal/workflow-update:${WORKFLOW_PATH}`, WORKFLOW_V1);
    t.gh.state.pulls.push({ repo: 'octo/hello', number: 3, state: 'open', title: WORKFLOW_UPDATE_PR_TITLE, head: 'docturnal/workflow-update', base: 'main', body: 'Docturnal now starts its nightly run from the app.' });
    t.gh.state.nextPull = 4;
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });

    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(repo.files.get(`docturnal/workflow-update:${WORKFLOW_PATH}`)).toBe(WORKFLOW);
    expect(t.gh.state.pulls[0].body).toContain('<!-- docturnal-workflow-version: 5 -->');
    // Still on the scheduled template until the pull request is merged, so no dispatch.
    expect(t.gh.state.dispatches).toEqual([]);
    expect(t.logs).toContain('dispatch octo/hello: the workflow has the old schedule, updated pull request #3 to version 5');
    expect(t.logs).toContain('dispatch octo/hello: skipped, the workflow still has its own schedule');
  });

  it('leaves a repository alone after its owner closes the version 5 pull request', async () => {
    const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW_V1 } });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    t.gh.state.pulls[0].state = 'closed';
    await t.cron('2026-01-16T05:07:00Z');
    await t.drain();
    expect(t.gh.state.pulls).toHaveLength(1);
    expect(t.gh.state.dispatches).toHaveLength(2);
  });
});

describe('nightly run while another run is going', () => {
  for (const status of ['in_progress', 'queued', 'pending']) {
    it(`skips the nightly run when a run is ${status}`, async () => {
      const t = setup({ files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW }, runs: [{ repo: 'octo/hello', status }] });
      t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
      await t.cron('2026-01-15T05:07:00Z');
      await t.drain();
      expect(t.gh.state.dispatches).toEqual([]);
      expect(t.logs).toContain('dispatch octo/hello: skipped, a run is already in progress');
      expect(t.queue.deadLetters).toEqual([]);
    });
  }

  it('checks only Docturnal runs in the same repository', async () => {
    const t = setup({ repos: ['octo/hello', 'octo/busy'], files: { [`main:${WORKFLOW_PATH}`]: WORKFLOW }, runs: [{ repo: 'octo/busy', status: 'in_progress' }] });
    t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello', 'octo/busy'] });
    await t.cron('2026-01-15T05:07:00Z');
    await t.drain();
    expect(t.gh.state.dispatches.map((d: { repo: string }) => d.repo)).toEqual(['octo/hello']);
    expect(t.gh.state.calls).toContain('GET /repos/octo/hello/actions/workflows/docturnal.yml/runs');
    expect(t.logs).toContain('dispatch octo/busy: skipped, a run is already in progress');
  });

  it('does not check for runs before the first run after install', async () => {
    const t = setup({ runs: [{ repo: 'octo/hello', status: 'in_progress' }] });
    await t.deliver('installation', installation());
    await t.drain();
    expect(t.gh.state.dispatches).toHaveLength(1);
  });
});

describe('GitHub API version', () => {
  it('sends X-GitHub-Api-Version 2026-03-10 on every call, so GitHub sends no deprecation warning', async () => {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const t = setup({ files: { 'docturnal/update:.docturnal/last-run.md': '# Docturnal update\n' } });
      await t.deliver('installation', installation());
      await t.drain();
      await t.deliver('push', pushToUpdate());
      t.kv.seed(1, { time: 0, timeZone: 'America/New_York', commentLevel: 'heavy', repos: ['octo/hello'] });
      await t.cron('2026-01-15T05:07:00Z');
      await t.drain();

      // 2026-03-10 answers a dispatch with 200 and the run details; both runs started.
      expect(t.gh.state.dispatches).toHaveLength(2);
      expect(t.logs).toContain('dispatch octo/hello: started the nightly run on main with heavy comments');
      expect(t.gh.state.apiVersions.length).toBeGreaterThan(10);
      expect(new Set(t.gh.state.apiVersions)).toEqual(new Set(['2026-03-10']));
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('the mock answers like GitHub, with a Sunset header, when a call has no version header', async () => {
    const gh = createMockGitHub();
    const response = await gh.fetch('https://api.github.test/repos/octo/hello', {});
    expect(response.headers.get('sunset')).toBe('Fri, 10 Mar 2028 00:00:00 GMT');
  });
});

describe('Worker entry module', () => {
  // Workers treat each named export of the entry module as an entrypoint and refuse to start
  // when one is not a function, which no other test would notice.
  it('exports only functions besides the default handler', async () => {
    const entry = await import('../src/index');
    for (const [name, value] of Object.entries(entry)) {
      if (name !== 'default') expect(typeof value, name).toBe('function');
    }
  });
});
