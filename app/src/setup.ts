// The optional settings page at /setup. GitHub sends people here after they install the app,
// and every Docturnal pull request links here. Installing never requires a visit: without
// saved settings, repositories run at midnight, New York time, with medium comments. While the
// settings are still those defaults, the page saves the browser's time zone as soon as it
// loads, so closing it gives midnight in the user's own time zone.

import { COMMENT_LEVELS, type Choices, type CommentLevel, DEFAULT_SETTINGS, type ExistingCode, type Settings, SettingsStore, isCommentLevel, isDefault, isExistingCode, isValidHour, isValidTimeZone } from './settings';
import { GITHUB_API_VERSION } from './github';
import { randomToken, sameToken, signToken, verifyToken } from './session';
import { WORKFLOW_VERSION } from './workflow';

export const SESSION_COOKIE = 'docturnal_session';
const SESSION_SECONDS = 15 * 60;
const STATE_SECONDS = 10 * 60;

// Defines the structure of the environment object used for setup.
export interface SetupEnv {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  WEBHOOK_SECRET: string;
  SETTINGS: KVNamespace;
  GITHUB_API_URL?: string;
  GITHUB_WEB_URL?: string;
}

// Defines the structure of the options object used for setup.
export interface SetupOptions {
  fetch: typeof fetch;
  log: (line: string) => void;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  // How many repositories the installation has, asked as the app itself (an installation
  // token), so the count includes repositories the signed-in user cannot see.
  installationRepoCount: (installationId: number) => Promise<number>;
  // The workflow version of each repository, asked as the app, or null when a repository has
  // no Docturnal workflow or it cannot be read.
  workflowVersions?: (installationId: number, repos: string[]) => Promise<Map<string, number | null>>;
  // Queues the workflow update pull request for each repository, whatever was declined before.
  requestWorkflowUpdates?: (installationId: number, repos: string[], origin: string) => Promise<void>;
}

// The most repositories the page checks for an older workflow when it loads, so a large
// installation stays within the Worker's request limits. The button queues every repository
// past these too, and each is checked again on the queue.
export const MAX_VERSION_CHECKS = 25;

// The repositories, among the first MAX_VERSION_CHECKS, whose workflow is older than the
// current version. A failed check shows no button rather than an error.
async function olderWorkflows(options: SetupOptions, installationId: number, repos: string[]): Promise<{ repo: string; version: number }[]> {
  if (!options.workflowVersions || !repos.length) return [];
  try {
    const versions = await options.workflowVersions(installationId, repos.slice(0, MAX_VERSION_CHECKS));
    return [...versions]
      .filter((entry): entry is [string, number] => entry[1] !== null && entry[1] < WORKFLOW_VERSION)
      .map(([repo, version]) => ({ repo, version }));
  } catch {
    options.log(`setup ${installationId}: could not check the workflow versions`);
    return [];
  }
}

// Right after an install or an update, GitHub may not list the installation for the user yet,
// so those sign-ins check up to ACCESS_CHECKS times, ACCESS_RETRY_MS apart.
const ACCESS_CHECKS = 3;
const ACCESS_RETRY_MS = 2000;

interface Session {
  installationId: number;
  account: string;
  csrf: string;
}

const EXISTING_CODE_CHOICES: { value: ExistingCode; label: string; description: string }[] = [
  { value: 'gradual', label: 'Comment gradually', description: 'After the first pull request documents your code, Docturnal comments your existing files in small batches, the most important first. This is the default.' },
  { value: 'none', label: 'Only new and changed code', description: 'Docturnal comments only the code you add or change.' },
];

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

// Revokes a user token once the sign-in has checked what it needed. A failure is logged, and
// the token expires on its own.
async function revokeToken(env: SetupEnv, options: SetupOptions, token: string, installationId: number): Promise<void> {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  try {
    const response = await options.fetch(`${api}/applications/${encodeURIComponent(env.CLIENT_ID)}/token`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`)}`,
        'content-type': 'application/json',
        'user-agent': 'docturnal-app',
        'x-github-api-version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: token }),
    });
    if (!response.ok && response.status !== 404) options.log(`setup ${installationId}: could not revoke the sign-in token (HTTP ${response.status})`);
  } catch {
    options.log(`setup ${installationId}: could not revoke the sign-in token (request failed)`);
  }
}

// The one error a new code cannot fix: the app's own client ID or secret is wrong. It is a
// configuration problem, shown at once. Every other failure gets one fresh sign-in.
const CONFIG_ERROR = 'incorrect_client_credentials';

// How a sign-in started: GitHub's redirect after an install or an installation update, or
// our own redirect from the settings link in a pull request. The logs name it.
type SignInPath = 'install' | 'update' | 'link';

interface SignInState {
  installationId: number;
  path?: SignInPath;
  // True for the fresh sign-in after a failed exchange, so a second failure never loops.
  retry?: boolean;
}

// Browsers announce speculative loads, which must not spend a single-use code.
function isPrefetch(request: Request): boolean {
  const purpose = `${request.headers.get('sec-purpose') ?? ''} ${request.headers.get('purpose') ?? ''} ${request.headers.get('x-moz') ?? ''}`;
  return /prefetch|prerender/i.test(purpose);
}

function userRequest(env: SetupEnv, options: SetupOptions, token: string, path: string): Promise<Response> {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  return options.fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'docturnal-app',
      'x-github-api-version': GITHUB_API_VERSION,
    },
  });
}

interface FoundInstallation {
  account: string;
  organization: boolean;
}

// Finds the installation among the ones this user can see, or returns null. GitHub lists an
// installation for anyone who can access one of its repositories, so this alone does not
// mean the user may change its settings; see mayManage.
async function findUserInstallation(env: SetupEnv, options: SetupOptions, token: string, installationId: number): Promise<FoundInstallation | null> {
  for (let page = 1; page <= 10; page++) {
    const response = await userRequest(env, options, token, `/user/installations?per_page=100&page=${page}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { installations?: { id: number; target_type?: string; account?: { login?: string; type?: string } }[] };
    const installations = data.installations ?? [];
    const match = installations.find((i) => i.id === installationId);
    if (match) {
      const type = match.account?.type ?? match.target_type;
      return { account: match.account?.login ?? `installation ${installationId}`, organization: type !== 'User' };
    }
    if (installations.length < 100) return null;
  }
  return null;
}

// The most repositories the organization check reads, 100 per request.
const MAX_REPOSITORY_PAGES = 30;

// Who may change an installation's settings, since they apply to every repository in it:
// - a personal account: only that account;
// - an organization: only someone with admin access to every repository in the
//   installation, such as an owner. GitHub returns the user's permission on each repository
//   the user can see; the installation's own count, asked as the app, shows whether that is
//   all of them. Checking ownership of the organization directly would need the app's
//   "Members" permission, which it does not have.
// Returns null when the user may, or the reason for the log when not.
async function mayManage(env: SetupEnv, options: SetupOptions, token: string, installationId: number, found: FoundInstallation): Promise<string | null> {
  if (!found.organization) {
    const response = await userRequest(env, options, token, '/user');
    if (!response.ok) return `could not read the signed-in user (HTTP ${response.status})`;
    const login = ((await response.json()) as { login?: string }).login ?? '';
    return login.toLowerCase() === found.account.toLowerCase() ? null : 'not the account owner';
  }
  const total = await options.installationRepoCount(installationId);
  if (total > MAX_REPOSITORY_PAGES * 100) return `the installation has ${total} repositories, more than the ${MAX_REPOSITORY_PAGES * 100} the check reads`;
  let admin = 0;
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
    const response = await userRequest(env, options, token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    if (!response.ok) return `could not read the user's repositories (HTTP ${response.status})`;
    const repositories = ((await response.json()) as { repositories?: { permissions?: { admin?: boolean } }[] }).repositories ?? [];
    for (const repository of repositories) {
      if (repository.permissions?.admin !== true) return 'no admin access to one of the repositories';
      admin++;
    }
    if (repositories.length < 100) break;
  }
  if (total === 0 || admin < total) return `admin access to ${admin} of ${total} repositories`;
  return null;
}

function notManagerMessage(found: FoundInstallation): string {
  return found.organization
    ? `You can't change these settings. They apply to every repository in this Docturnal installation, so only someone with admin access to all of them, such as an owner of ${found.account}, can change them.`
    : `You can't change these settings. Only ${found.account}, the account Docturnal is installed on, can change them.`;
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

// Returns a sorted array of supported time zones, including
// 'UTC', the default setting, and the selected zone.
function timeZones(selected: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...supported, 'UTC', DEFAULT_SETTINGS.timeZone, selected])].sort();
}

// Describes the schedule based on the settings' time, time zone, and comment level.
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

// A random nonce for each response: the page's one inline style and its one inline script
// carry it, and the Content-Security-Policy allows nothing else.
function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(value: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${value}'`,
    `style-src 'nonce-${value}'`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
  ].join('; ');
}

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const value = nonce();
  // Every value shown on the page is escaped, so the only <script> in body is the page's own.
  const scripted = body.replaceAll('<script>', `<script nonce="${value}">`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} - Docturnal</title>
<style nonce="${value}">${STYLE}</style>
</head>
<body>
<main>
${scripted}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': contentSecurityPolicy(value),
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

// Shown when GitHub sign-in fails twice, instead of an error: the install itself worked, and
// Docturnal runs without anyone visiting this page. A new install has the default settings;
// after an update or from a pull request link, the installation keeps the settings it has.
function signInFailedPage(installationId: number, path: SignInPath): Response {
  const schedule = path === 'install'
    ? `It will run ${escape(describe(DEFAULT_SETTINGS))}.`
    : 'It keeps running every night with its current settings.';
  return page(200, 'Docturnal is installed', `<h1>Docturnal is installed</h1>
<p>${schedule} You can change the settings any time from the link in each Docturnal pull request.</p>
<p class="muted">GitHub sign-in did not finish this time, so the settings can't be shown yet.</p>
<a class="button" href="/setup?installation_id=${installationId}">Try signing in again</a>`);
}

// The "Update the Docturnal workflow" button, shown only while a repository uses an older workflow.
function updateSection(session: Session, older: { repo: string; version: number }[]): string {
  if (!older.length) return '';
  const list = older.map((o) => `<li>${escape(o.repo)} (version ${o.version})</li>`).join('');
  return `<h2>Docturnal workflow</h2>
<p>These repositories use an older Docturnal workflow. Version ${WORKFLOW_VERSION} lets only one run happen at a time and pins the code that checks out your repository.</p>
<ul class="muted">${list}</ul>
<form method="post" action="/setup">
<input type="hidden" name="csrf" value="${escape(session.csrf)}">
<input type="hidden" name="action" value="update-workflow">
<button type="submit">Update the Docturnal workflow</button>
</form>
<p class="muted">Docturnal opens a pull request in each one for you to review and merge.</p>`;
}

function formPage(session: Session, settings: Settings, older: { repo: string; version: number }[] = []): Response {
  const hours = Array.from({ length: 24 }, (_, hour) =>
    `<option value="${hour}"${hour === settings.time ? ' selected' : ''}>${formatHour(hour)}</option>`).join('');
  const zones = timeZones(settings.timeZone).map((zone) =>
    `<option value="${escape(zone)}"${zone === settings.timeZone ? ' selected' : ''}>${escape(zone.replace(/_/g, ' '))}</option>`).join('');
  const existing = EXISTING_CODE_CHOICES.map((choice) => `<label class="level"><input type="radio" name="existingCode" value="${choice.value}"${choice.value === settings.existingCode ? ' checked' : ''}><div>${escape(choice.label)}<span>${escape(choice.description)}</span></div></label>`).join('\n');
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
<fieldset>
<legend>Existing code</legend>
${existing}
</fieldset>
<button type="submit">Save</button>
</form>
<p class="muted" id="unsaved">If you close this page without saving, nothing changes: Docturnal runs ${escape(describe(settings))}.</p>
${updateSection(session, older)}
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

async function signInRedirect(env: SetupEnv, origin: string, installationId: number, now: number, extra: Omit<SignInState, 'installationId'> = {}): Promise<Response> {
  const state = await signToken(env.WEBHOOK_SECRET, 'state', { installationId, ...extra } satisfies SignInState, now + STATE_SECONDS * 1000);
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
    // sign-in redirect, the signed state carries it instead, with the path that started it.
    let installationId = requested;
    let path: SignInPath = url.searchParams.get('setup_action') === 'update' ? 'update' : 'install';
    let retry = false;
    const stateParam = url.searchParams.get('state');
    const fromOurRedirect = Boolean(stateParam) && !url.searchParams.has('installation_id');
    if (fromOurRedirect) {
      const state = await verifyToken<SignInState>(env.WEBHOOK_SECRET, 'state', stateParam, now);
      if (!state) return errorPage(400, 'This sign-in link expired. Open the settings link in a Docturnal pull request again.');
      installationId = state.installationId;
      path = state.path ?? 'link';
      retry = state.retry === true;
    }
    // Installation ID must be a positive integer to proceed with sign-in or session retrieval.
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return errorPage(400, 'This link is missing the installation. Open the settings link in a Docturnal pull request.');
    }
    // Already signed in for this installation, for example on a second visit or a repeated
    // request: show the form without spending the code. A session for any other
    // installation, such as one the user uninstalled, is ignored, and the new sign-in
    // replaces it.
    const existing = await readSession(request, env, now);
    if (existing && existing.installationId === installationId) {
      return new Response(null, { status: 303, headers: { location: '/setup', 'cache-control': 'no-store' } });
    }
    const exchanged = await exchangeCode(env, options, code);
    if ('error' in exchanged) {
      const where = `setup ${installationId} (${path}${retry ? ', second try' : ''})`;
      if (exchanged.error === CONFIG_ERROR) {
        options.log(`${where}: GitHub sign-in failed (${exchanged.error}); check CLIENT_ID and CLIENT_SECRET`);
        return errorPage(500, "Docturnal's GitHub sign-in is not set up correctly, so this page can't open. Docturnal is installed and runs every night with its current settings.");
      }
      // A code from GitHub's install or update redirect that did not work: sign in again,
      // once, so a new user never sees an error on the first page.
      if (!fromOurRedirect) {
        options.log(`${where}: the sign-in code did not work (${exchanged.error}), signing in again`);
        return signInRedirect(env, url.origin, installationId, now, { path, retry: true });
      }
      // The fresh sign-in failed too, or a sign-in from a pull request link did: say what
      // worked and offer another try, without looping.
      options.log(`${where}: GitHub sign-in failed (${exchanged.error})`);
      return signInFailedPage(installationId, path);
    }
    // A pull request link is for an installation that exists already, so it is checked once.
    const checks = path === 'link' ? 1 : ACCESS_CHECKS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let access: FoundInstallation | null = null;
    let check = 1;
    let refusal: string | null = null;
    try {
      access = await findUserInstallation(env, options, exchanged.token, installationId);
      while (!access && check < checks) {
        await sleep(ACCESS_RETRY_MS);
        check++;
        access = await findUserInstallation(env, options, exchanged.token, installationId);
      }
      if (access) refusal = await mayManage(env, options, exchanged.token, installationId, access);
    } finally {
      // The user's token is needed only for these checks; the session never uses it.
      await revokeToken(env, options, exchanged.token, installationId);
    }
    if (access && check > 1) options.log(`setup ${installationId} (${path}): GitHub listed the installation on check ${check}`);
    if (!access) {
      options.log(`setup ${installationId}: rejected, the signed-in user cannot access this installation${checks > 1 ? ` (${path}, after ${checks} checks)` : ''}`);
      return errorPage(403, "You can't change these settings. Sign in with a GitHub account that can manage this Docturnal installation.");
    }
    if (refusal) {
      options.log(`setup ${installationId}: rejected, ${refusal}`);
      return errorPage(403, notManagerMessage(access));
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
    return formPage(session, settings, await olderWorkflows(options, session.installationId, settings.repos));
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

// Handles POST requests to update settings or manage workflows.
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
  if (form.get('action') === 'update-workflow') return updateWorkflows(request, store, session, options);
  if (form.has('detectedTimeZone')) return saveDetectedTimeZone(store, session, String(form.get('detectedTimeZone')), options);

  const time = Number(form.get('time'));
  const timeZone = String(form.get('timeZone') ?? '');
  const commentLevel = String(form.get('commentLevel') ?? '');
  // A form from before this setting existed keeps the stored choice.
  const existingRaw = form.get('existingCode');
  const existingCode = existingRaw === null ? ((await store.getChoices(session.installationId)) ?? DEFAULT_SETTINGS).existingCode : String(existingRaw);
  if (!isValidHour(time) || !isValidTimeZone(timeZone) || !isCommentLevel(commentLevel) || !isExistingCode(existingCode)) {
    return errorPage(400, 'Choose a time, a time zone, a comment level, and what to do with existing code.');
  }

  // Only the settings key is written; the repository list belongs to the webhooks.
  const saved: Choices = { time, timeZone, commentLevel, existingCode };
  await store.putChoices(session.installationId, saved);
  options.log(`setup ${session.installationId}: saved ${formatHour(time)} ${timeZone}, ${commentLevel} comments, existing code ${existingCode}`);
  return page(200, 'Settings saved', `<h1>Settings saved</h1>
<p>Docturnal now runs ${escape(describe(saved))}, starting with the next run.</p>
<a class="button" href="/setup">Change them again</a>`);
}

// The "Update the Docturnal workflow" button: queues the update pull request for the
// repositories found on an older version, and for any past the ones the page checks,
// whatever was declined before. Each is checked again on the queue, so a repository already
// on the current version gets nothing.
async function updateWorkflows(request: Request, store: SettingsStore, session: Session, options: SetupOptions): Promise<Response> {
  if (!options.requestWorkflowUpdates) return errorPage(503, "The workflow can't be updated from here right now. Try again later.");
  const { repos } = await store.getOrDefault(session.installationId);
  const older = await olderWorkflows(options, session.installationId, repos);
  const unchecked = repos.slice(MAX_VERSION_CHECKS);
  const queued = [...older.map((o) => o.repo), ...unchecked];
  if (!queued.length) {
    return page(200, 'Workflow up to date', `<h1>Workflow up to date</h1>
<p>Every repository in this installation already uses Docturnal workflow version ${WORKFLOW_VERSION}.</p>
<a class="button" href="/setup">Back to the settings</a>`);
  }
  try {
    await options.requestWorkflowUpdates(session.installationId, queued, new URL(request.url).origin);
  } catch {
    options.log(`setup ${session.installationId}: could not queue the workflow updates`);
    return errorPage(503, "The workflow updates couldn't be started. Try again in a few minutes.");
  }
  options.log(`setup ${session.installationId}: queued workflow updates for ${queued.length} ${queued.length === 1 ? 'repository' : 'repositories'}`);
  const list = older.map((o) => `<li>${escape(o.repo)}</li>`).join('');
  const more = unchecked.length ? `<p class="muted">Docturnal also checks the other ${unchecked.length} ${unchecked.length === 1 ? 'repository' : 'repositories'} and updates any that need it.</p>` : '';
  return page(200, 'Workflow update started', `<h1>Workflow update started</h1>
<p>Docturnal is opening a pull request to update the workflow to version ${WORKFLOW_VERSION}${older.length ? ' in:' : '.'}</p>
${older.length ? `<ul>${list}</ul>` : ''}
${more}
<p>Each pull request appears within a minute. Merge it to finish the update.</p>
<a class="button" href="/setup">Back to the settings</a>`);
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
