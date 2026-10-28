import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createHandler, type Env } from '../src/index';
import { createSession, MAX_VERSION_CHECKS, SESSION_COOKIE } from '../src/setup';
import { WORKFLOW_PATH, WORKFLOW_VERSION, workflowYaml } from '../src/workflow';
import { FakeKV } from './fake-kv';
import { FakeQueue } from './fake-queue';
import { createMockGitHub } from './mock-github.mjs';

const ORIGIN = 'https://docturnal.example';
// The settings page asks GitHub as the app how many repositories an installation has.
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
// Installation 2 is on the acme organization, with two repositories: dana has admin on both,
// as an owner would; erin has admin on one and read access to the other; frank sees and
// administers one of them but cannot see the other.
const ACME = {
  2: [
    { full_name: 'acme/api', admin: ['dana', 'erin', 'frank'] },
    { full_name: 'acme/web', admin: ['dana'], read: ['erin'] },
  ],
};
const START = Date.parse('2026-10-22T12:00:00Z');

// failExchanges: how many code exchanges fail before GitHub answers normally, with failWith
// as the failure: an HTTP status, or 'network' for a request that never gets an answer.
// hiddenChecks: how many times GitHub's list of the user's installations comes back without
// any, as it might right after an install.
// mock: more options for the GitHub mock, such as repos and files.
function setup({ settings, clientSecret, failExchanges = 0, failWith = 502, hiddenChecks = 0, mock = {} }: { settings?: Record<string, unknown>; clientSecret?: string; failExchanges?: number; failWith?: number | 'network'; hiddenChecks?: number; mock?: Record<string, unknown> } = {}) {
  const gh = createMockGitHub({
    ...mock,
    oauth: {
      clientSecret,
      // Each code works once, like GitHub's.
      codes: {
        'owner-code': 'token-owner', 'other-code': 'token-other', 'fresh-code': 'token-owner',
        'collaborator-code': 'token-collaborator', 'dana-code': 'token-dana', 'erin-code': 'token-erin', 'frank-code': 'token-frank',
      },
      installations: {
        'token-owner': [{ id: 1, account: { login: 'octo', type: 'User' } }],
        'token-other': [{ id: 99, account: { login: 'mallory', type: 'User' } }],
        // A collaborator on one of octo's repositories sees octo's installation too.
        'token-collaborator': [{ id: 1, account: { login: 'octo', type: 'User' } }],
        'token-dana': [{ id: 2, account: { login: 'acme', type: 'Organization' } }],
        'token-erin': [{ id: 2, account: { login: 'acme', type: 'Organization' } }],
        'token-frank': [{ id: 2, account: { login: 'acme', type: 'Organization' } }],
      },
      logins: { 'token-owner': 'octo', 'token-other': 'mallory', 'token-collaborator': 'carol', 'token-dana': 'dana', 'token-erin': 'erin', 'token-frank': 'frank' },
      repositories: ACME,
    },
  });
  const kv = new FakeKV();
  const queue = new FakeQueue<unknown>();
  if (settings) kv.seed(1, settings as Parameters<FakeKV['seed']>[1]);
  const logs: string[] = [];
  let now = START;
  const env = {
    APP_ID: '12345',
    PRIVATE_KEY: PEM,
    WEBHOOK_SECRET: 'webhook-secret',
    CLIENT_ID: 'Iv1.client',
    CLIENT_SECRET: 'client-secret',
    SETTINGS: kv as unknown as KVNamespace,
    SETUP_QUEUE: queue as unknown as Queue,
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_WEB_URL: 'https://github.test',
  } as Env;
  let failuresLeft = failExchanges;
  let hiddenLeft = hiddenChecks;
  const installationChecks: string[] = [];
  const fetchWithFailures: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/login/oauth/access_token') && failuresLeft > 0) {
      failuresLeft--;
      if (failWith === 'network') throw new TypeError('fetch failed');
      return new Response('upstream error', { status: failWith });
    }
    if (String(input).includes('/user/installations')) {
      installationChecks.push(String(input));
      if (hiddenLeft > 0) {
        hiddenLeft--;
        return new Response(JSON.stringify({ total_count: 0, installations: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return gh.fetch(input, init);
  };
  // Waits are recorded and move the clock instead of sleeping.
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  };
  const handle = createHandler({ fetch: fetchWithFailures, log: (line) => logs.push(line), now: () => now, sleep });

  async function get(path: string, cookie?: string, headers: Record<string, string> = {}) {
    return handle(new Request(`${ORIGIN}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } }), env);
  }
  // origin null sends no Origin header; extra adds headers such as Referer.
  async function post(fields: Record<string, string>, cookie?: string, origin: string | null = ORIGIN, extra: Record<string, string> = {}) {
    return handle(
      new Request(`${ORIGIN}/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}), ...extra },
        body: new URLSearchParams(fields).toString(),
      }),
      env
    );
  }
  // Signs in through GitHub and returns the session cookie and the form's CSRF token.
  async function signIn(path = '/setup?code=owner-code&installation_id=1&setup_action=install') {
    const response = await get(path);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/setup');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=900/);
    const cookie = setCookie.split(';')[0];
    const formResponse = await get('/setup', cookie);
    const csp = formResponse.headers.get('content-security-policy') ?? '';
    const form = await formResponse.text();
    const csrf = form.match(/name="csrf" value="([^"]+)"/)![1];
    return { cookie, csrf, form, csp };
  }
  return { gh, kv, queue, logs, env, sleeps, installationChecks, handle: (request: Request) => handle(request, env), get, post, signIn, advance: (ms: number) => (now += ms) };
}

const SAVE = { time: '2', timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'none' };

describe('who may change the settings', () => {
  it('a personal account: the owner may, a collaborator on one of its repositories may not', async () => {
    const t = setup();
    const owner = await t.get('/setup?code=owner-code&installation_id=1&setup_action=install');
    expect(owner.status).toBe(303);
    const collaborator = await t.get('/setup?code=collaborator-code&installation_id=1&setup_action=install');
    expect(collaborator.status).toBe(403);
    expect(collaborator.headers.get('set-cookie')).toBeNull();
    expect(await collaborator.text()).toContain("Only octo, the account Docturnal is installed on, can change them.");
    expect(t.logs).toContain('setup 1: rejected, not the account owner');
    // Both sign-in tokens are revoked once the checks are done, whether the user may or not.
    expect(t.gh.state.revoked).toEqual(['token-owner', 'token-collaborator']);
    expect(t.logs.some((l: string) => l.includes('could not revoke'))).toBe(false);
  });

  it('an organization: someone with admin access to every repository, such as an owner, may', async () => {
    const t = setup();
    const response = await t.get('/setup?code=dana-code&installation_id=2&setup_action=install');
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(await (await t.get('/setup', cookie)).text()).toContain('<strong>acme</strong>');
  });

  it('an organization: a collaborator without admin on every repository may not, and nor may one who cannot see them all', async () => {
    const t = setup();
    for (const [code, reason] of [['erin-code', 'no admin access to one of the repositories'], ['frank-code', 'admin access to 1 of 2 repositories']]) {
      const response = await t.get(`/setup?code=${code}&installation_id=2&setup_action=install`);
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toContain('only someone with admin access to all of them, such as an owner of acme, can change them.');
      expect(t.logs).toContain(`setup 2: rejected, ${reason}`);
    }
  });
});

describe('setup page sign-in', () => {
  it('lets the owner sign in after install and save settings', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] } });
    const { cookie, csrf, form } = await t.signIn();
    expect(form).toContain('<strong>octo</strong>');
    expect(form).toContain('<option value="0" selected>12 AM (midnight)</option>');
    expect(form).toContain('value="America/New_York" selected');
    expect(form).toContain('value="medium" checked');
    expect(form).toContain('If you close this page without saving, nothing changes: Docturnal runs every night at 12 AM (midnight), America/New_York time, with medium comments.');
    // With default settings, the page saves the browser's time zone when it loads.
    expect(form).toContain('resolvedOptions().timeZone');
    expect(form).toContain("body.set('detectedTimeZone', zone)");
    expect(t.logs).toContain('setup 1: signed in for octo');

    const saved = await t.post({ ...SAVE, csrf }, cookie);
    expect(saved.status).toBe(200);
    const page = await saved.text();
    expect(page).toContain('Docturnal now runs every night at 2 AM, America/Los_Angeles time, with heavy comments');
    expect(t.kv.json('install:1:settings')).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'none' });
    expect(t.kv.data.get('install:1:settings')!.metadata).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy', existingCode: 'none' });
    expect(t.logs).toContain('setup 1: saved 2 AM America/Los_Angeles, heavy comments, existing code none');
    expect(t.kv.repos(1)).toEqual(['octo/hello']);

    // Saved settings are shown next time, without the browser suggestion.
    const again = await (await t.get('/setup', cookie)).text();
    expect(again).toContain('<option value="2" selected>2 AM</option>');
    expect(again).not.toContain('resolvedOptions().timeZone');
  });

  it('rejects a user who cannot access the installation', async () => {
    const t = setup();
    const response = await t.get('/setup?code=other-code&installation_id=1&setup_action=install');
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('You can&#39;t change these settings.');
    // After an install, GitHub gets three chances to list the installation, 2 seconds apart.
    expect(t.logs).toEqual(['setup 1: rejected, the signed-in user cannot access this installation (install, after 3 checks)']);
    expect(t.installationChecks).toHaveLength(3);
    expect(t.sleeps).toEqual([2000, 2000]);
    expect(t.kv.data.size).toBe(0);
  });


  it('sends the settings link through GitHub sign-in before showing the form', async () => {
    const t = setup();
    const response = await t.get('/setup?installation_id=1');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://github.test/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.client');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/setup`);
    const state = location.searchParams.get('state')!;

    // GitHub returns with the code and our state, which carries the installation ID.
    const { form } = await t.signIn(`/setup?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(form).toContain('Docturnal settings');
  });

  it('rejects a forged or expired sign-in state', async () => {
    const t = setup();
    expect((await t.get('/setup?code=owner-code&state=forged.state')).status).toBe(400);
    const location = new URL((await t.get('/setup?installation_id=1')).headers.get('location')!);
    t.advance(11 * 60 * 1000);
    expect((await t.get(`/setup?code=owner-code&state=${encodeURIComponent(location.searchParams.get('state')!)}`)).status).toBe(400);
  });

  it('asks a signed-in user to sign in again for a different installation', async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    const response = await t.get('/setup?installation_id=2', cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/login/oauth/authorize');
  });
});

// Runs the page's inline script with a minimal DOM, the given browser time zone, and a fetch
// that sends the request to the Worker with the session cookie, as the browser would. It
// enforces the page's Content-Security-Policy as a browser does: the script runs only with
// the policy's nonce, and fetch reaches only the page's own origin.
async function runPageScript(t: ReturnType<typeof setup>, form: string, cookie: string, browserZone: string, csp: string) {
  const allowed = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  const tag = form.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  expect(tag, 'the script carries a nonce').toBeTruthy();
  expect(tag![1]).toBe(allowed);
  const script = tag![2];
  const zones = [...form.matchAll(/<option value="([A-Z][^"]*)"( selected)?/g)];
  const select = { value: zones.find((m) => m[2])![1], options: zones.map((m) => ({ value: m[1] })) };
  const unsaved = { textContent: form.match(/<p class="muted" id="unsaved">([^<]*)<\/p>/)![1] };
  const csrf = { value: form.match(/name="csrf" value="([^"]+)"/)![1] };
  const document = {
    getElementById: (id: string) => ({ timeZone: select, unsaved })[id],
    querySelector: (selector: string) => (selector === 'input[name="csrf"]' ? csrf : null),
  };
  const fakeIntl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: browserZone }) }) };
  const requests: URLSearchParams[] = [];
  let done: Promise<unknown> = Promise.resolve();
  const fakeFetch = (path: string, init: { method: string; body: URLSearchParams }) => {
    // connect-src 'self'
    expect(new URL(path, ORIGIN).origin).toBe(ORIGIN);
    expect(csp).toContain("connect-src 'self'");
    requests.push(init.body);
    const response = t.handle(new Request(`${ORIGIN}${path}`, {
      method: init.method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: init.body.toString(),
    }));
    done = response;
    return response;
  };
  new Function('document', 'Intl', 'fetch', 'URLSearchParams', script)(document, fakeIntl, fakeFetch, URLSearchParams);
  await done;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { select, unsaved, requests };
}

describe('security headers', () => {
  it('serves the settings page with a CSP whose nonce is on its only script and style, new for each response', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] } });
    const { cookie, form, csp } = await t.signIn();
    const value = csp.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)![1];
    expect(csp).toBe(`default-src 'none'; script-src 'nonce-${value}'; style-src 'nonce-${value}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'`);
    expect(form.match(/<script\b[^>]*>/g)).toEqual([`<script nonce="${value}">`]);
    expect(form.match(/<style\b[^>]*>/g)).toEqual([`<style nonce="${value}">`]);
    // Nothing the policy would block: no inline handlers, style attributes, or other sources.
    expect(form).not.toMatch(/\son[a-z]+=|\sstyle=|<link|<img|<iframe|src=/i);
    const again = (await t.get('/setup', cookie)).headers.get('content-security-policy');
    expect(again).not.toBe(csp);
  });

  it('refuses a webhook payload larger than GitHub sends, before reading or verifying it', async () => {
    const t = setup();
    const response = await t.handle(new Request(`${ORIGIN}/webhook`, { method: 'POST', headers: { 'content-length': String(26 * 1024 * 1024) }, body: 'x' }));
    expect(response.status).toBe(413);
    expect(t.logs).toContain('webhook: rejected, payload too large');
  });

  it('sends nosniff and HSTS on every response, including errors, webhooks, and unknown paths', async () => {
    const t = setup();
    for (const response of [await t.get('/setup'), await t.get('/setup?code=other-code&installation_id=1'), await t.get('/nowhere'), await t.handle(new Request(`${ORIGIN}/webhook`, { method: 'POST', body: '{}' }))]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    }
  });
});

describe("saving the browser's time zone", () => {
  it('saves it as soon as the page loads, keeping midnight and medium comments', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] } });
    const { cookie, form, csp } = await t.signIn();
    const { select, unsaved, requests } = await runPageScript(t, form, cookie, 'America/Los_Angeles', csp);

    expect(requests.map((r) => r.get('detectedTimeZone'))).toEqual(['America/Los_Angeles']);
    expect(select.value).toBe('America/Los_Angeles');
    expect(t.kv.installation(1)).toEqual({ time: 0, timeZone: 'America/Los_Angeles', commentLevel: 'medium', existingCode: 'gradual', repos: ['octo/hello'] });
    expect(t.kv.data.get('install:1:settings')!.metadata).toEqual({ time: 0, timeZone: 'America/Los_Angeles', commentLevel: 'medium', existingCode: 'gradual' });
    expect(unsaved.textContent).toBe('Your time zone, America/Los_Angeles, is saved. If you close this page now, Docturnal runs every night at 12 AM (midnight), America/Los_Angeles time, with medium comments.');
    expect(t.logs).toContain("setup 1: saved the browser's time zone, America/Los_Angeles");

    // The next visit shows the saved time zone and does not save again.
    const again = await (await t.get('/setup', cookie)).text();
    expect(again).toContain('value="America/Los_Angeles" selected');
    expect(again).not.toContain('<script>');
  });

  it('creates the entry when the install webhook has not stored one yet', async () => {
    const t = setup();
    const { cookie, form, csp } = await t.signIn();
    await runPageScript(t, form, cookie, 'Europe/Berlin', csp);
    // Only the settings key is written; repository keys are the webhooks' to create.
    expect([...t.kv.data.keys()]).toEqual(['install:1:settings']);
    expect(t.kv.json('install:1:settings')).toEqual({ time: 0, timeZone: 'Europe/Berlin', commentLevel: 'medium', existingCode: 'gradual' });
  });

  it('sends nothing when the browser is already in New York or its time zone is not listed', async () => {
    for (const zone of ['America/New_York', 'Not/A_Zone']) {
      const t = setup();
      const { cookie, form, csp } = await t.signIn();
      const { requests } = await runPageScript(t, form, cookie, zone, csp);
      expect(requests).toEqual([]);
      expect(t.kv.data.size).toBe(0);
    }
  });

  it('never replaces settings that were already changed', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: [] } });
    const { cookie, csrf } = await t.signIn();
    // Another tab saves 3 AM before this request arrives.
    await t.post({ csrf, time: '3', timeZone: 'America/New_York', commentLevel: 'medium' }, cookie);
    const response = await t.post({ csrf, detectedTimeZone: 'Asia/Tokyo' }, cookie);
    expect(await response.json()).toEqual({ saved: false });
    expect(t.kv.json('install:1:settings')).toMatchObject({ time: 3, timeZone: 'America/New_York' });
  });

  it('requires a session and the CSRF token, and rejects an unknown time zone', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    expect((await t.post({ csrf, detectedTimeZone: 'Asia/Tokyo' })).status).toBe(403);
    expect((await t.post({ csrf: 'wrong', detectedTimeZone: 'Asia/Tokyo' }, cookie)).status).toBe(403);
    expect((await t.post({ csrf, detectedTimeZone: 'Mars/Olympus' }, cookie)).status).toBe(400);
    expect(t.kv.data.size).toBe(0);
  });
});

describe('the Existing code setting', () => {
  it('shows both choices with the saved one selected, "Comment gradually" by default', async () => {
    const t = setup();
    const { form } = await t.signIn();
    expect(form).toContain('<legend>Existing code</legend>');
    expect(form).toContain('<input type="radio" name="existingCode" value="gradual" checked><div>Comment gradually<span>After the first pull request documents your code, Docturnal comments your existing files in small batches, the most important first. This is the default.</span></div>');
    expect(form).toContain('<input type="radio" name="existingCode" value="none"><div>Only new and changed code<span>Docturnal comments only the code you add or change.</span></div>');
  });

  it('keeps the stored choice when an older form without the field is sent, and refuses an unknown value', async () => {
    const t = setup({ settings: { time: 1, timeZone: 'UTC', commentLevel: 'low', existingCode: 'none', repos: ['octo/hello'] } });
    const { cookie, csrf } = await t.signIn();
    const { existingCode: _, ...older } = SAVE;
    expect((await t.post({ ...older, csrf }, cookie)).status).toBe(200);
    expect(t.kv.json('install:1:settings')).toMatchObject({ existingCode: 'none', commentLevel: 'heavy' });
    expect((await t.post({ ...SAVE, existingCode: 'everything', csrf }, cookie)).status).toBe(400);
  });
});

describe('saving settings', () => {
  it('rejects a save without a session, with a wrong CSRF token, or with a tampered or expired session', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();

    expect((await t.post({ ...SAVE, csrf })).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf: 'wrong' }, cookie)).status).toBe(403);
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await t.post({ ...SAVE, csrf }, tampered)).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf }, cookie, 'https://evil.example')).status).toBe(403);
    t.advance(16 * 60 * 1000);
    expect((await t.post({ ...SAVE, csrf }, cookie)).status).toBe(403);
    expect(t.kv.data.size).toBe(0);
  });

  it('rejects a session whose signature is spelled differently but decodes to the same bytes', async () => {
    const t = setup();
    const value = await createSession(t.env, { installationId: 1, account: 'octo', csrf: 'c' }, START);
    expect((await t.get('/setup', `${SESSION_COOKIE}=${value}`)).status).toBe(200);
    // The last base64url character carries 2 unused bits; flipping one keeps the bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) ^ 1];
    expect((await t.get('/setup', `${SESSION_COOKIE}=${respelled}`)).status).toBe(400);
  });

  it("rejects saving settings for an installation the user doesn't own", async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] } });
    // Mallory can sign in only for installation 99, and the form cannot name another one.
    const cookie = `${SESSION_COOKIE}=${await createSession(t.env, { installationId: 99, account: 'mallory', csrf: 'c' }, START)}`;
    const response = await t.post({ ...SAVE, csrf: 'c', installation_id: '1' }, cookie);
    expect(response.status).toBe(200);
    expect(t.kv.installation(1)).toEqual({ time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] });
    expect(t.kv.json('install:99:settings')).toMatchObject({ time: 2, timeZone: 'America/Los_Angeles' });

    // And signing in for installation 1 as Mallory is refused outright.
    expect((await t.get('/setup?code=other-code&installation_id=1')).status).toBe(403);
  });

  // A form submit from a page served with Referrer-Policy: no-referrer arrives with
  // "Origin: null" and no Referer. That is what rejected Save during the real test install.
  it('accepts Save sent with "Origin: null" and no Referer when the session and CSRF token are valid', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    const response = await t.post({ ...SAVE, csrf }, cookie, 'null');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Docturnal now runs every night at 2 AM, America/Los_Angeles time, with heavy comments');
  });

  it('checks the Referer when the Origin is null, and still requires the session and CSRF token', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    expect((await t.post({ ...SAVE, csrf }, cookie, 'null', { referer: `${ORIGIN}/setup` })).status).toBe(200);
    expect((await t.post({ ...SAVE, csrf }, cookie, 'null', { referer: 'https://evil.example/setup' })).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf }, cookie, 'null', { referer: 'not a url' })).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf: 'wrong' }, cookie, 'null')).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf }, undefined, 'null')).status).toBe(403);
    // Without an Origin header, the same Referer rules apply.
    expect((await t.post({ ...SAVE, csrf }, cookie, null, { referer: 'https://evil.example/' })).status).toBe(403);
    expect((await t.post({ ...SAVE, csrf }, cookie, null)).status).toBe(200);
    // A real origin must match the request URL's origin exactly.
    expect((await t.post({ ...SAVE, csrf }, cookie, 'https://docturnal.example.evil.test')).status).toBe(403);
  });

  it('serves pages with a referrer policy that keeps the Origin on a same-site form submit', async () => {
    const t = setup();
    const { cookie } = await t.signIn();
    expect((await t.get('/setup', cookie)).headers.get('referrer-policy')).toBe('same-origin');
  });

  it('rejects an unknown time zone, an hour outside 0 to 23, or an unknown comment level', async () => {
    const t = setup();
    const { cookie, csrf } = await t.signIn();
    for (const bad of [{ timeZone: 'Mars/Olympus' }, { time: '24' }, { time: '1.5' }, { commentLevel: 'loud' }]) {
      expect((await t.post({ ...SAVE, csrf, ...bad }, cookie)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(t.kv.data.size).toBe(0);
  });

  it('escapes values it shows on the page', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/<script>'] } });
    const { form } = await t.signIn();
    expect(form).toContain('octo/&lt;script&gt;');
    expect(form).not.toContain('octo/<script>');
  });
});

describe('sign-in codes from GitHub', () => {
  const INSTALL = '/setup?code=owner-code&installation_id=1&setup_action=install';
  const UPDATE = '/setup?code=owner-code&installation_id=1&setup_action=update';

  // Follows a 302 to GitHub's authorize page and returns the state it carries.
  function authorizeState(response: Response): string {
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://github.test/login/oauth/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/setup`);
    return location.searchParams.get('state')!;
  }

  it('signs in on the normal install path, exchanging the code once', async () => {
    const t = setup();
    const response = await t.get(INSTALL);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/setup');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(await (await t.get('/setup', cookie)).text()).toContain('Docturnal settings');
    expect(t.gh.state.codeExchanges).toBe(1);
    expect(t.logs).toEqual(['setup 1: signed in for octo']);
  });

  it('signs in the same way from an installation update redirect with a code', async () => {
    const t = setup();
    expect((await t.get(UPDATE)).status).toBe(303);
    expect(t.logs).toEqual(['setup 1: signed in for octo']);
  });

  it('sends an update redirect without a code to GitHub sign-in, then shows the form', async () => {
    const t = setup();
    const state = authorizeState(await t.get('/setup?installation_id=1&setup_action=update'));
    // GitHub returns with a new code and our state, which names the installation.
    const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(303);
    const cookie = back.headers.get('set-cookie')!.split(';')[0];
    expect(await (await t.get('/setup', cookie)).text()).toContain('<strong>octo</strong>');
  });

  it('signs in again, instead of showing an error, when the code is already used or expired', async () => {
    const t = setup();
    await t.get(INSTALL); // The code is now used.
    t.logs.length = 0;
    const state = authorizeState(await t.get(UPDATE));
    expect(t.logs).toEqual(['setup 1 (update): the sign-in code did not work (bad_verification_code), signing in again']);

    const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('set-cookie')).toMatch(/^docturnal_session=/);
    expect(t.logs.at(-1)).toBe('setup 1: signed in for octo');
  });

  it('shows a friendly page, not an error, when the fresh sign-in after an update fails too, without looping', async () => {
    const t = setup();
    const state = authorizeState(await t.get('/setup?code=expired-code&installation_id=1&setup_action=update'));
    const back = await t.get(`/setup?code=also-expired&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(200);
    const html = await back.text();
    expect(html).toContain('<h1>Docturnal is installed</h1>');
    expect(html).toContain('It keeps running every night with its current settings. You can change the settings any time from the link in each Docturnal pull request.');
    expect(html).toContain('<a class="button" href="/setup?installation_id=1">Try signing in again</a>');
    expect(html).not.toContain('class="error"');
    expect(back.headers.get('set-cookie')).toBeNull();
    expect(t.logs).toEqual([
      'setup 1 (update): the sign-in code did not work (bad_verification_code), signing in again',
      'setup 1 (update, second try): GitHub sign-in failed (bad_verification_code)',
    ]);
    // "Try signing in again" starts a new sign-in.
    authorizeState(await t.get('/setup?installation_id=1'));
  });

  it('shows the configuration error at once for wrong client credentials, which a new code would not fix', async () => {
    const t = setup({ clientSecret: 'the-real-secret' });
    const response = await t.get(INSTALL);
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain('Docturnal&#39;s GitHub sign-in is not set up correctly, so this page can&#39;t open. Docturnal is installed and runs every night with its current settings.');
    expect(t.logs).toEqual(['setup 1 (install): GitHub sign-in failed (incorrect_client_credentials); check CLIENT_ID and CLIENT_SECRET']);
    expect(t.gh.state.codeExchanges).toBe(1);
  });

  it('a stale session for another installation never blocks the sign-in after a fresh install', async () => {
    const t = setup();
    // The browser still has a valid session for an installation that was since removed.
    const stale = `${SESSION_COOKIE}=${await createSession(t.env, { installationId: 174349041, account: 'octo', csrf: 'old' }, START)}`;
    const response = await t.get(INSTALL, stale);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/setup');
    // The new session replaces the stale one.
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).not.toBe(stale);
    const form = await (await t.get('/setup', cookie)).text();
    expect(form).toContain('Docturnal settings');
    expect(form).toContain('<strong>octo</strong>');
    expect(t.gh.state.codeExchanges).toBe(1);
    expect(t.logs).toEqual(['setup 1: signed in for octo']);
  });

  for (const failWith of [502, 'network'] as const) {
    it(`any failure to exchange an install code (${failWith}) signs in again once, and then shows the form`, async () => {
      const t = setup({ failExchanges: 1, failWith });
      const state = authorizeState(await t.get(INSTALL));
      const reason = failWith === 'network' ? 'request failed' : 'HTTP 502';
      expect(t.logs).toEqual([`setup 1 (install): the sign-in code did not work (${reason}), signing in again`]);
      const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
      expect(back.status).toBe(303);
      expect(await (await t.get('/setup', back.headers.get('set-cookie')!.split(';')[0])).text()).toContain('<strong>octo</strong>');
    });
  }

  it('after an install, a second failure shows that Docturnal is installed with its default schedule', async () => {
    const t = setup({ failExchanges: 2 });
    const state = authorizeState(await t.get(INSTALL));
    const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(200);
    const html = await back.text();
    expect(html).toContain('<h1>Docturnal is installed</h1>');
    expect(html).toContain('It will run every night at 12 AM (midnight), America/New_York time, with medium comments. You can change the settings any time from the link in each Docturnal pull request.');
    expect(html).toContain('Try signing in again');
    expect(t.logs).toEqual([
      'setup 1 (install): the sign-in code did not work (HTTP 502), signing in again',
      'setup 1 (install, second try): GitHub sign-in failed (HTTP 502)',
    ]);
    // Logs name the error and the path, never a code or a token.
    expect(t.logs.join('\n')).not.toMatch(/owner-code|fresh-code|token-owner/);
  });

  it('a failed sign-in from a pull request link shows the friendly page instead of redirecting again', async () => {
    const t = setup({ failExchanges: 1 });
    const state = authorizeState(await t.get('/setup?installation_id=1'));
    const back = await t.get(`/setup?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain('It keeps running every night with its current settings.');
    expect(t.logs).toEqual(['setup 1 (link): GitHub sign-in failed (HTTP 502)']);
  });

  it('does not spend the code twice when the same redirect is requested again', async () => {
    const t = setup();
    const first = await t.get(INSTALL);
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    // A repeated request with the new session goes straight to the form.
    const again = await t.get(INSTALL, cookie);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/setup');
    expect(t.gh.state.codeExchanges).toBe(1);
    // A repeated request that arrives before the cookie is stored signs in again instead of failing.
    authorizeState(await t.get(INSTALL));
  });

  it('refuses a browser prefetch without spending the code', async () => {
    const t = setup();
    for (const headers of [{ 'sec-purpose': 'prefetch' }, { 'sec-purpose': 'prefetch;prerender' }, { purpose: 'prefetch' }]) {
      const response = await t.get(INSTALL, undefined, headers);
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(t.gh.state.codeExchanges ?? 0).toBe(0);
    expect((await t.get(INSTALL)).status).toBe(303);
  });

  it('still rejects a signed-in session for another installation', async () => {
    const t = setup();
    const cookie = `${SESSION_COOKIE}=${await createSession(t.env, { installationId: 99, account: 'mallory', csrf: 'c' }, START)}`;
    // The session is for 99, so the code for installation 1 is checked with GitHub.
    const response = await t.get('/setup?code=other-code&installation_id=1&setup_action=update', cookie);
    expect(response.status).toBe(403);
    expect(t.logs).toEqual(['setup 1: rejected, the signed-in user cannot access this installation (update, after 3 checks)']);
  });

  it('checks again when GitHub does not list a new installation at first, and shows the form when it appears', async () => {
    const t = setup({ hiddenChecks: 1 });
    const response = await t.get(INSTALL);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/setup');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(await (await t.get('/setup', cookie)).text()).toContain('<strong>octo</strong>');
    expect(t.installationChecks).toHaveLength(2);
    expect(t.sleeps).toEqual([2000]);
    expect(t.gh.state.codeExchanges).toBe(1);
    expect(t.logs).toEqual([
      'setup 1 (install): GitHub listed the installation on check 2',
      'setup 1: signed in for octo',
    ]);
  });

  it('checks again after an update redirect too, including on the fresh sign-in after a failed code', async () => {
    const t = setup({ failExchanges: 1, hiddenChecks: 2 });
    const state = authorizeState(await t.get(UPDATE));
    const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(303);
    expect(t.installationChecks).toHaveLength(3);
    expect(t.logs).toContain('setup 1 (update): GitHub listed the installation on check 3');
  });

  it('checks a pull request link only once, without waiting', async () => {
    const t = setup({ hiddenChecks: 1 });
    const state = authorizeState(await t.get('/setup?installation_id=1'));
    const back = await t.get(`/setup?code=owner-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(403);
    expect(await back.text()).toContain('You can&#39;t change these settings.');
    expect(t.installationChecks).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
    expect(t.logs).toEqual(['setup 1: rejected, the signed-in user cannot access this installation']);
  });
});

describe('the "Update the Docturnal workflow" button', () => {
  const OLD = workflowYaml('acme/docturnal').replace(`# Docturnal workflow version ${WORKFLOW_VERSION}.`, '# Docturnal workflow version 3.');
  // octo/hello is on version 3; octo/other is current.
  function world() {
    const t = setup({ settings: { repos: ['octo/hello', 'octo/other'] }, mock: { repos: ['octo/hello', 'octo/other'] } });
    t.gh.state.repos.get('octo/hello').files.set(`main:${WORKFLOW_PATH}`, OLD);
    t.gh.state.repos.get('octo/other').files.set(`main:${WORKFLOW_PATH}`, workflowYaml('acme/docturnal'));
    return t;
  }
  const UPDATE = { action: 'update-workflow' };

  it('shows only while a repository uses an older workflow, and queues its update on click', async () => {
    const t = world();
    const { cookie, csrf, form } = await t.signIn();
    expect(form).toContain('<button type="submit">Update the Docturnal workflow</button>');
    expect(form).toContain('<li>octo/hello (version 3)</li>');
    expect(form).not.toContain('octo/other (version');
    const response = await t.post({ ...UPDATE, csrf }, cookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<h1>Workflow update started</h1>');
    expect(page).toContain('<ul><li>octo/hello</li></ul>');
    expect(t.queue.pending.map((m) => m.body)).toEqual([{ kind: 'workflow-update', installationId: 1, repo: 'octo/hello', origin: ORIGIN }]);
    expect(t.logs).toContain('setup 1: queued workflow updates for 1 repository');

    // Once every repository is current, the page has no button, and a click changes nothing.
    t.gh.state.repos.get('octo/hello').files.set(`main:${WORKFLOW_PATH}`, workflowYaml('acme/docturnal'));
    const current = await (await t.get('/setup', cookie)).text();
    expect(current).not.toContain('Update the Docturnal workflow');
    const again = await t.post({ ...UPDATE, csrf }, cookie);
    expect(await again.text()).toContain('Every repository in this installation already uses Docturnal workflow version 5.');
    expect(t.queue.pending).toHaveLength(1);
  });

  it('requires the session from the ownership check, the CSRF token, and our own origin', async () => {
    const t = world();
    const { cookie, csrf } = await t.signIn();
    expect((await t.post({ ...UPDATE, csrf })).status).toBe(403);
    expect((await t.post({ ...UPDATE, csrf: 'wrong' }, cookie)).status).toBe(403);
    expect((await t.post({ ...UPDATE, csrf }, cookie, 'https://evil.example')).status).toBe(403);
    expect((await t.post({ ...UPDATE, csrf }, cookie, null, { referer: 'https://evil.example/' })).status).toBe(403);
    expect(t.logs).toContain('setup 1: rejected, the form token did not match');
    // Someone who could not pass the ownership check has no session for this installation:
    // a session for their own installation reaches only its repositories.
    const mallory = `${SESSION_COOKIE}=${await createSession(t.env, { installationId: 99, account: 'mallory', csrf: 'c' }, START)}`;
    const other = await t.post({ ...UPDATE, csrf: 'c', installation_id: '1' }, mallory);
    expect(await other.text()).toContain('already uses Docturnal workflow version 5');
    // A collaborator cannot sign in at all.
    expect((await t.get('/setup?code=collaborator-code&installation_id=1&setup_action=install')).status).toBe(403);
    expect(t.queue.pending).toEqual([]);
  });

  it('queues the repositories past the ones the page checks, and says so', async () => {
    const repos = Array.from({ length: MAX_VERSION_CHECKS + 2 }, (_, i) => `octo/r${String(i).padStart(2, '0')}`);
    const t = setup({ settings: { repos }, mock: { repos, files: { [`main:${WORKFLOW_PATH}`]: OLD } } });
    const { cookie, csrf, form } = await t.signIn();
    expect((form.match(/\(version 3\)/g) ?? []).length).toBe(MAX_VERSION_CHECKS);
    const page = await (await t.post({ ...UPDATE, csrf }, cookie)).text();
    expect(page).toContain('Docturnal also checks the other 2 repositories and updates any that need it.');
    expect(t.queue.pending.map((m) => (m.body as { repo: string }).repo)).toEqual(repos);
  });
});
