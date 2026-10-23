import { describe, expect, it } from 'vitest';

import { createHandler, type Env } from '../src/index';
import { createSession, SESSION_COOKIE } from '../src/setup';
import { FakeKV } from './fake-kv';
import { createMockGitHub } from './mock-github.mjs';

const ORIGIN = 'https://docturnal.example';
const START = Date.parse('2026-10-22T12:00:00Z');

function setup({ settings, clientSecret }: { settings?: Record<string, unknown>; clientSecret?: string } = {}) {
  const gh = createMockGitHub({
    oauth: {
      clientSecret,
      // Each code works once, like GitHub's.
      codes: { 'owner-code': 'token-owner', 'other-code': 'token-other', 'fresh-code': 'token-owner' },
      installations: {
        'token-owner': [{ id: 1, account: { login: 'octo' } }],
        'token-other': [{ id: 99, account: { login: 'mallory' } }],
      },
    },
  });
  const kv = new FakeKV();
  if (settings) kv.seed(1, settings as Parameters<FakeKV['seed']>[1]);
  const logs: string[] = [];
  let now = START;
  const env = {
    APP_ID: '12345',
    PRIVATE_KEY: 'unused',
    WEBHOOK_SECRET: 'webhook-secret',
    CLIENT_ID: 'Iv1.client',
    CLIENT_SECRET: 'client-secret',
    SETTINGS: kv as unknown as KVNamespace,
    SETUP_QUEUE: {} as Queue,
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_WEB_URL: 'https://github.test',
  } as Env;
  const handle = createHandler({ fetch: gh.fetch, log: (line) => logs.push(line), now: () => now });

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
    const form = await (await get('/setup', cookie)).text();
    const csrf = form.match(/name="csrf" value="([^"]+)"/)![1];
    return { cookie, csrf, form };
  }
  return { gh, kv, logs, env, handle: (request: Request) => handle(request, env), get, post, signIn, advance: (ms: number) => (now += ms) };
}

const SAVE = { time: '2', timeZone: 'America/Los_Angeles', commentLevel: 'heavy' };

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
    expect(t.kv.json('install:1:settings')).toEqual({ time: 2, timeZone: 'America/Los_Angeles', commentLevel: 'heavy' });
    expect(t.kv.data.get('install:1:settings')!.metadata).toEqual({ time: 2, timeZone: 'America/Los_Angeles' });
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
    expect(t.logs).toEqual(['setup 1: rejected, the signed-in user cannot access this installation']);
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
// that sends the request to the Worker with the session cookie, as the browser would.
async function runPageScript(t: ReturnType<typeof setup>, form: string, cookie: string, browserZone: string) {
  const script = form.match(/<script>([\s\S]*?)<\/script>/)![1];
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

describe("saving the browser's time zone", () => {
  it('saves it as soon as the page loads, keeping midnight and medium comments', async () => {
    const t = setup({ settings: { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', repos: ['octo/hello'] } });
    const { cookie, form } = await t.signIn();
    const { select, unsaved, requests } = await runPageScript(t, form, cookie, 'America/Los_Angeles');

    expect(requests.map((r) => r.get('detectedTimeZone'))).toEqual(['America/Los_Angeles']);
    expect(select.value).toBe('America/Los_Angeles');
    expect(t.kv.installation(1)).toEqual({ time: 0, timeZone: 'America/Los_Angeles', commentLevel: 'medium', repos: ['octo/hello'] });
    expect(t.kv.data.get('install:1:settings')!.metadata).toEqual({ time: 0, timeZone: 'America/Los_Angeles' });
    expect(unsaved.textContent).toBe('Your time zone, America/Los_Angeles, is saved. If you close this page now, Docturnal runs every night at 12 AM (midnight), America/Los_Angeles time, with medium comments.');
    expect(t.logs).toContain("setup 1: saved the browser's time zone, America/Los_Angeles");

    // The next visit shows the saved time zone and does not save again.
    const again = await (await t.get('/setup', cookie)).text();
    expect(again).toContain('value="America/Los_Angeles" selected');
    expect(again).not.toContain('<script>');
  });

  it('creates the entry when the install webhook has not stored one yet', async () => {
    const t = setup();
    const { cookie, form } = await t.signIn();
    await runPageScript(t, form, cookie, 'Europe/Berlin');
    // Only the settings key is written; repository keys are the webhooks' to create.
    expect([...t.kv.data.keys()]).toEqual(['install:1:settings']);
    expect(t.kv.json('install:1:settings')).toEqual({ time: 0, timeZone: 'Europe/Berlin', commentLevel: 'medium' });
  });

  it('sends nothing when the browser is already in New York or its time zone is not listed', async () => {
    for (const zone of ['America/New_York', 'Not/A_Zone']) {
      const t = setup();
      const { cookie, form } = await t.signIn();
      const { requests } = await runPageScript(t, form, cookie, zone);
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
    expect(t.logs).toEqual(['setup 1: the sign-in code did not work (bad_verification_code), signing in again']);

    const back = await t.get(`/setup?code=fresh-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('set-cookie')).toMatch(/^docturnal_session=/);
    expect(t.logs.at(-1)).toBe('setup 1: signed in for octo');
  });

  it('shows the error only when the fresh sign-in fails too, without looping', async () => {
    const t = setup();
    const state = authorizeState(await t.get('/setup?code=expired-code&installation_id=1&setup_action=update'));
    const back = await t.get(`/setup?code=also-expired&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(403);
    expect(await back.text()).toContain('GitHub sign-in did not work.');
    expect(t.logs.at(-1)).toBe('setup 1: GitHub sign-in failed (bad_verification_code)');
  });

  it('shows the error at once when a new code would not help, such as a wrong client secret', async () => {
    const t = setup({ clientSecret: 'the-real-secret' });
    const response = await t.get(INSTALL);
    expect(response.status).toBe(403);
    expect(t.logs).toEqual(['setup 1: GitHub sign-in failed (incorrect_client_credentials)']);
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
    expect(t.logs).toEqual(['setup 1: rejected, the signed-in user cannot access this installation']);
  });
});
