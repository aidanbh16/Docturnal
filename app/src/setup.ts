// The optional settings page at /setup. GitHub sends people here after they install the app,
// and every Docturnal pull request links here. Installing never requires a visit: without
// saved settings, repositories run at midnight, New York time, with medium comments. While the
// settings are still those defaults, the page saves the browser's time zone as soon as it
// loads, so closing it gives midnight in the user's own time zone.

import { COMMENT_LEVELS, type Choices, type CommentLevel, DEFAULT_SETTINGS, type Settings, SettingsStore, isCommentLevel, isDefault, isValidHour, isValidTimeZone } from './settings';
import { GITHUB_API_VERSION } from './github';
import { randomToken, sameToken, signToken, verifyToken } from './session';

export const SESSION_COOKIE = 'docturnal_session';
const SESSION_SECONDS = 15 * 60;
const STATE_SECONDS = 10 * 60;

export interface SetupEnv {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  WEBHOOK_SECRET: string;
  SETTINGS: KVNamespace;
  GITHUB_API_URL?: string;
  GITHUB_WEB_URL?: string;
}

export interface SetupOptions {
  fetch: typeof fetch;
  log: (line: string) => void;
  now: () => number;
}

interface Session {
  installationId: number;
  account: string;
  csrf: string;
}

const LEVEL_DESCRIPTIONS: Record<CommentLevel, string> = {
  low: 'A few short comments on the most important code.',
  medium: 'Single-line comments on code that needs explaining. This is the default.',
  heavy: 'A comment above each function and class, plus notes on tricky code.',
  off: 'No comments. Docturnal only updates your docs.',
};

// --- GitHub sign-in ---

// Exchanges a sign-in code for a user token. On failure, returns GitHub's error code, such
// as bad_verification_code for a code that is wrong, already used, or expired (codes are
// single-use and last 10 minutes). Error codes are fixed names, safe to log.
async function exchangeCode(env: SetupEnv, options: SetupOptions, code: string): Promise<{ token: string } | { error: string }> {
  let response: Response;
  try {
    response = await options.fetch(`${env.GITHUB_WEB_URL || 'https://github.com'}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'docturnal-app' },
      body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code }),
    });
  } catch {
    return { error: 'request failed' };
  }
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const data = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
  if (typeof data.access_token === 'string' && data.access_token) return { token: data.access_token };
  return { error: typeof data.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : 'unexpected response' };
}

// Errors that a new code fixes. Anything else, such as wrong client credentials, would fail
// again, so it is shown at once.
const CODE_ERRORS = new Set(['bad_verification_code']);

// Browsers announce speculative loads, which must not spend a single-use code.
function isPrefetch(request: Request): boolean {
  const purpose = `${request.headers.get('sec-purpose') ?? ''} ${request.headers.get('purpose') ?? ''} ${request.headers.get('x-moz') ?? ''}`;
  return /prefetch|prerender/i.test(purpose);
}

// Finds the installation among the ones this user can access, or returns null.
async function findUserInstallation(env: SetupEnv, options: SetupOptions, token: string, installationId: number): Promise<{ account: string } | null> {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  for (let page = 1; page <= 10; page++) {
    const response = await options.fetch(`${api}/user/installations?per_page=100&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'docturnal-app',
        'x-github-api-version': GITHUB_API_VERSION,
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { installations?: { id: number; account?: { login?: string } }[] };
    const installations = data.installations ?? [];
    const match = installations.find((i) => i.id === installationId);
    if (match) return { account: match.account?.login ?? `installation ${installationId}` };
    if (installations.length < 100) return null;
  }
  return null;
}

// --- Pages ---

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function formatHour(hour: number): string {
  if (hour === 0) return '12 AM (midnight)';
  if (hour === 12) return '12 PM (noon)';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function timeZones(selected: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...supported, 'UTC', DEFAULT_SETTINGS.timeZone, selected])].sort();
}

function describe(settings: Choices): string {
  return `every night at ${formatHour(settings.time)}, ${settings.timeZone} time, with ${settings.commentLevel === 'off' ? 'no comments (docs only)' : `${settings.commentLevel} comments`}`;
}

const STYLE = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --panel: #f6f8fa; --accent: #0969da; --accent-fg: #ffffff; --error: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --panel: #151b23; --accent: #4493f8; --accent-fg: #0d1117; --error: #f85149; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: 0.95rem; }
label, legend { display: block; font-weight: 600; margin: 20px 0 6px; }
select { width: 100%; padding: 10px; font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
fieldset { border: 0; margin: 0; padding: 0; }
.level { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 8px 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; }
.level input { margin-top: 5px; }
.level span { display: block; color: var(--muted); font-size: 0.9rem; }
button, .button { display: inline-block; margin-top: 24px; padding: 10px 20px; font: inherit; font-weight: 600; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; text-decoration: none; }
.error { color: var(--error); font-weight: 600; }
ul { padding-left: 20px; }
`;

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} - Docturnal</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      // Not no-referrer: with no-referrer, browsers send "Origin: null" and no Referer on a
      // form submit. same-origin keeps both for our own form and sends nothing to other sites.
      'referrer-policy': 'same-origin',
      ...headers,
    },
  });
}

function errorPage(status: number, message: string): Response {
  return page(status, 'Something went wrong', `<h1>Docturnal settings</h1>\n<p class="error">${escape(message)}</p>`);
}

function formPage(session: Session, settings: Settings): Response {
  const hours = Array.from({ length: 24 }, (_, hour) =>
    `<option value="${hour}"${hour === settings.time ? ' selected' : ''}>${formatHour(hour)}</option>`).join('');
  const zones = timeZones(settings.timeZone).map((zone) =>
    `<option value="${escape(zone)}"${zone === settings.timeZone ? ' selected' : ''}>${escape(zone.replace(/_/g, ' '))}</option>`).join('');
  const levels = COMMENT_LEVELS.map((level) => `<label class="level"><input type="radio" name="commentLevel" value="${level}"${level === settings.commentLevel ? ' checked' : ''}><div>${level.charAt(0).toUpperCase()}${level.slice(1)}<span>${escape(LEVEL_DESCRIPTIONS[level])}</span></div></label>`).join('\n');
  const repos = settings.repos.length
    ? `<p class="muted">These settings apply to every repository in this installation:</p><ul class="muted">${settings.repos.map((r) => `<li>${escape(r)}</li>`).join('')}</ul>`
    : '';
  // Until settings are saved, select the browser's time zone and save it right away, keeping
  // the default hour and comment level. The server saves it only if the settings are still
  // the defaults, so this never replaces a choice made in another tab.
  const script = isDefault(settings)
    ? `<script>
(function () {
  var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var select = document.getElementById('timeZone');
  var known = false;
  for (var i = 0; i < select.options.length; i++) {
    if (select.options[i].value === zone) { known = true; break; }
  }
  if (!known || zone === select.value) return;
  select.value = zone;
  var body = new URLSearchParams();
  body.set('csrf', document.querySelector('input[name="csrf"]').value);
  body.set('detectedTimeZone', zone);
  fetch('/setup', { method: 'POST', body: body, credentials: 'same-origin' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      if (!data || !data.saved) return;
      document.getElementById('unsaved').textContent =
        'Your time zone, ' + data.timeZone + ', is saved. If you close this page now, Docturnal runs ' + data.schedule + '.';
    })
    .catch(function () {});
})();
</script>`
    : '';
  return page(200, 'Settings', `<h1>Docturnal settings</h1>
<p>Choose when Docturnal runs each night for <strong>${escape(session.account)}</strong>, and how many comments it adds.</p>
<form method="post" action="/setup">
<input type="hidden" name="csrf" value="${escape(session.csrf)}">
<label for="time">Time</label>
<select id="time" name="time">${hours}</select>
<label for="timeZone">Time zone</label>
<select id="timeZone" name="timeZone">${zones}</select>
<fieldset>
<legend>Comment level</legend>
${levels}
</fieldset>
<button type="submit">Save</button>
</form>
<p class="muted" id="unsaved">If you close this page without saving, nothing changes: Docturnal runs ${escape(describe(settings))}.</p>
${repos}
${script}`);
}

// --- Handlers ---

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function readSession(request: Request, env: SetupEnv, now: number): Promise<Session | null> {
  return verifyToken<Session>(env.WEBHOOK_SECRET, 'session', cookieValue(request, SESSION_COOKIE), now);
}

// Creates the session cookie value. Exported so tests and local checks can make a session.
export function createSession(env: SetupEnv, session: Session, now: number): Promise<string> {
  return signToken(env.WEBHOOK_SECRET, 'session', session, now + SESSION_SECONDS * 1000);
}

async function signInRedirect(env: SetupEnv, origin: string, installationId: number, now: number): Promise<Response> {
  const state = await signToken(env.WEBHOOK_SECRET, 'state', { installationId }, now + STATE_SECONDS * 1000);
  const url = new URL(`${env.GITHUB_WEB_URL || 'https://github.com'}/login/oauth/authorize`);
  url.searchParams.set('client_id', env.CLIENT_ID);
  url.searchParams.set('redirect_uri', `${origin}/setup`);
  url.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } });
}

async function handleGet(request: Request, env: SetupEnv, options: SetupOptions): Promise<Response> {
  const url = new URL(request.url);
  const now = options.now();
  const code = url.searchParams.get('code');
  const requested = Number(url.searchParams.get('installation_id'));

  if (code) {
    // A prefetch or prerender would spend the code before the real visit; refuse it, and
    // the browser loads the page normally when the user gets there.
    if (isPrefetch(request)) {
      return new Response('Not available for prefetch.\n', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    // GitHub sends installation_id after an install or an installation update; after our own
    // sign-in redirect, the signed state carries it instead.
    let installationId = requested;
    const stateParam = url.searchParams.get('state');
    const fromOurRedirect = Boolean(stateParam) && !url.searchParams.has('installation_id');
    if (fromOurRedirect) {
      const state = await verifyToken<{ installationId: number }>(env.WEBHOOK_SECRET, 'state', stateParam, now);
      if (!state) return errorPage(400, 'This sign-in link expired. Open the settings link in a Docturnal pull request again.');
      installationId = state.installationId;
    }
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return errorPage(400, 'This link is missing the installation. Open the settings link in a Docturnal pull request.');
    }
    // Already signed in for this installation, for example on a second visit or a repeated
    // request: show the form without spending the code.
    const existing = await readSession(request, env, now);
    if (existing && existing.installationId === installationId) {
      return new Response(null, { status: 303, headers: { location: '/setup', 'cache-control': 'no-store' } });
    }
    const exchanged = await exchangeCode(env, options, code);
    if ('error' in exchanged) {
      // GitHub's own redirect brought a code that no longer works: sign in again, once. If
      // the code came back from that fresh sign-in, show the error instead of looping.
      if (!fromOurRedirect && CODE_ERRORS.has(exchanged.error)) {
        options.log(`setup ${installationId}: the sign-in code did not work (${exchanged.error}), signing in again`);
        return signInRedirect(env, url.origin, installationId, now);
      }
      options.log(`setup ${installationId}: GitHub sign-in failed (${exchanged.error})`);
      return errorPage(403, 'GitHub sign-in did not work. Open the settings link in a Docturnal pull request and try again.');
    }
    const access = await findUserInstallation(env, options, exchanged.token, installationId);
    if (!access) {
      options.log(`setup ${installationId}: rejected, the signed-in user cannot access this installation`);
      return errorPage(403, "You can't change these settings. Sign in with a GitHub account that can manage this Docturnal installation.");
    }
    const value = await createSession(env, { installationId, account: access.account, csrf: randomToken() }, now);
    options.log(`setup ${installationId}: signed in for ${access.account}`);
    return new Response(null, {
      status: 303,
      headers: { location: '/setup', 'set-cookie': sessionCookie(value, SESSION_SECONDS), 'cache-control': 'no-store' },
    });
  }

  const session = await readSession(request, env, now);
  if (session && (!requested || requested === session.installationId)) {
    const settings = await new SettingsStore(env.SETTINGS).getOrDefault(session.installationId);
    return formPage(session, settings);
  }
  if (Number.isInteger(requested) && requested > 0) return signInRedirect(env, url.origin, requested, now);
  return errorPage(400, 'Open this page from the settings link in a Docturnal pull request.');
}

// Checks that a POST came from our own page. The expected origin is always the origin of the
// incoming request URL. A browser sends "Origin: null" for a form submit under some referrer
// policies; then the Referer must match, and without a Referer the request is allowed here
// and must still pass the session and CSRF checks that follow.
function sameOriginPost(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (origin !== null && origin !== 'null') return origin === expected;
  if (referer === null) return true;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

async function handlePost(request: Request, env: SetupEnv, options: SetupOptions): Promise<Response> {
  const now = options.now();
  const session = await readSession(request, env, now);
  if (!session) {
    return errorPage(403, 'Your session expired. Open the settings link in a Docturnal pull request to sign in again.');
  }
  if (!sameOriginPost(request)) return errorPage(403, 'This form was sent from another site.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, 'The form could not be read. Try again.');
  }
  if (!sameToken(String(form.get('csrf') ?? ''), session.csrf)) {
    options.log(`setup ${session.installationId}: rejected, the form token did not match`);
    return errorPage(403, 'This form expired. Reload the page and try again.');
  }
  const store = new SettingsStore(env.SETTINGS);
  if (form.has('detectedTimeZone')) return saveDetectedTimeZone(store, session, String(form.get('detectedTimeZone')), options);

  const time = Number(form.get('time'));
  const timeZone = String(form.get('timeZone') ?? '');
  const commentLevel = String(form.get('commentLevel') ?? '');
  if (!isValidHour(time) || !isValidTimeZone(timeZone) || !isCommentLevel(commentLevel)) {
    return errorPage(400, 'Choose a time, a time zone, and a comment level.');
  }

  // Only the settings key is written; the repository list belongs to the webhooks.
  const saved: Choices = { time, timeZone, commentLevel };
  await store.putChoices(session.installationId, saved);
  options.log(`setup ${session.installationId}: saved ${formatHour(time)} ${timeZone}, ${commentLevel} comments`);
  return page(200, 'Settings saved', `<h1>Settings saved</h1>
<p>Docturnal now runs ${escape(describe(saved))}, starting with the next run.</p>
<a class="button" href="/setup">Change them again</a>`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// Saves the time zone the page detected in the browser, keeping the default hour and comment
// level. It changes nothing once the settings differ from the defaults.
async function saveDetectedTimeZone(store: SettingsStore, session: Session, timeZone: string, options: SetupOptions): Promise<Response> {
  if (!isValidTimeZone(timeZone)) return json({ saved: false }, 400);
  const current = (await store.getChoices(session.installationId)) ?? DEFAULT_SETTINGS;
  if (!isDefault(current)) return json({ saved: false });
  const saved: Choices = { ...current, timeZone };
  if (timeZone !== current.timeZone) {
    await store.putChoices(session.installationId, saved);
    options.log(`setup ${session.installationId}: saved the browser's time zone, ${timeZone}`);
  }
  return json({ saved: true, timeZone, schedule: describe(saved) });
}

export async function handleSetup(request: Request, env: SetupEnv, options: SetupOptions): Promise<Response> {
  if (request.method === 'GET') return handleGet(request, env, options);
  if (request.method === 'POST') return handlePost(request, env, options);
  return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, POST' } });
}
