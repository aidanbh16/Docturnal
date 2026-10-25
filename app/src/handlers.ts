// Webhook and queue handlers. They only make GitHub API calls and never read source code.
//
// Setting up a repository and dispatching runs happen from the queue, one repository per
// message, so an install with many repositories never depends on one Worker invocation.

import type { Octokit } from '@octokit/core';
import { type CommentLevel, DEFAULT_SETTINGS, type ExistingCode, SettingsStore } from './settings';
import { WORKFLOW_FILE, WORKFLOW_PATH, WORKFLOW_VERSION, templateVersion, workflowYaml } from './workflow';

export const UPDATE_BRANCH = 'docturnal/update';
export const SETUP_BRANCH = 'docturnal/setup';
export const WORKFLOW_UPDATE_BRANCH = 'docturnal/workflow-update';
export const LAST_RUN_PATH = '.docturnal/last-run.md';
export const BOT_LOGIN = 'github-actions[bot]';
export const UPDATE_PR_TITLE = 'Docturnal: comments and documentation';
export const SETUP_PR_TITLE = 'Set up Docturnal';
export const WORKFLOW_UPDATE_PR_TITLE = 'Update Docturnal workflow';

// Keep in sync with max_retries in wrangler.toml. After this many retries the queue moves
// the message to the dead letter queue.
export const MAX_RETRIES = 10;
// Gives GitHub time to register a workflow file that was just committed.
export const DISPATCH_DELAY_SECONDS = 15;
const NOT_REGISTERED_DELAY_SECONDS = 30;
const QUEUE_BATCH_LIMIT = 100;

// GitHub limits a pull request body to 65,536 characters.
const MAX_BODY = 64000;

export const SETUP_PR_BODY = `Docturnal adds comments to your code and updates your documentation every night. When it has changes, it opens a pull request so you can review them before anything reaches your code.

This pull request adds one file, \`${WORKFLOW_PATH}\`. Docturnal starts it once a night on GitHub's standard runner. Your code stays on that runner: Docturnal uses models that run on the runner itself and sends nothing to outside services.

Merge this pull request to turn Docturnal on. The first run starts as soon as you merge. After that, Docturnal runs every night at midnight, New York time, with medium comments, until you change the settings.`;

// Statuses of a run that has not finished. "pending" is a run waiting for the concurrency group.
const ACTIVE_RUN_STATUSES = ['in_progress', 'queued', 'pending'] as const;

// What each template version changed, for the update pull request.
const VERSION_CHANGES: Record<number, string> = {
  2: 'Lets only one Docturnal run happen at a time in this repository. If a run starts while another one is still going, for example a run you started by hand and the nightly run, the second one waits for the first to finish. Two runs then never push their changes at the same time.',
  3: 'Uses version 7 of `actions/checkout`, which runs on Node.js 24. GitHub is retiring Node.js 20 for actions, and the older version adds a deprecation warning to every run.',
  4: 'Passes your "Existing code" setting to each run, so you can choose to have existing code commented gradually, in small batches, or only new and changed code. It also tells each run how long its job may take, so a run always commits its work before the job times out.',
  5: 'Pins `actions/checkout` to a full commit SHA instead of a version tag. A tag can be moved to different code, and a commit SHA cannot, so the code that checks out your repository changes only with a new version of this workflow.',
};

// The changes between version `from` and the current one: one paragraph, or a list.
function changesSince(from: number): string {
  const changes: string[] = [];
  for (let v = from + 1; v <= WORKFLOW_VERSION; v++) if (VERSION_CHANGES[v]) changes.push(VERSION_CHANGES[v]);
  if (changes.length === 1) return `The new version ${changes[0].charAt(0).toLowerCase()}${changes[0].slice(1)}`;
  return `The new version makes these changes:\n\n${changes.map((c) => `- ${c}`).join('\n')}`;
}

// The pull request body for updating a workflow from `from` to the current version. A hidden
// line records the version, so each version is proposed only once.
export function workflowUpdateBody(from: number): string {
  const intro = from === 0
    ? `Docturnal now starts its nightly run from the app, at the time you choose in Docturnal's settings, instead of from a schedule in this repository.

This pull request replaces \`${WORKFLOW_PATH}\` with the current version. The new file has no schedule, takes the comment level from Docturnal's settings, and lets only one Docturnal run happen at a time. Until you merge this pull request, Docturnal keeps running on the old schedule.

After you merge, Docturnal runs every night at the time in its settings: midnight, New York time, with medium comments, unless you change them.`
    : `This pull request updates \`${WORKFLOW_PATH}\` to version ${WORKFLOW_VERSION}.

${changesSince(from)}

Nothing else changes: Docturnal keeps the run time and comment level from its settings.`;
  return `${intro}\n\n<!-- docturnal-workflow-version: ${WORKFLOW_VERSION} -->`;
}

// The version a workflow update pull request proposed. Pull requests from before versions
// were recorded proposed version 1.
function proposedVersion(body: string | null | undefined): number {
  const match = /<!-- docturnal-workflow-version: (\d+) -->/.exec(body ?? '');
  return match ? Number(match[1]) : 1;
}

const FALLBACK_UPDATE_BODY = 'Docturnal added comments to your code and updated your documentation. Review the changes, then merge this pull request to keep them.';

export type QueueMessage =
  | { kind: 'setup'; installationId: number; repo: string; origin?: string }
  | { kind: 'dispatch'; installationId: number; repo: string; reason: 'first' | 'nightly'; ref?: string; commentLevel?: CommentLevel; existingCode?: ExistingCode };

export type Outcome = { retry: false } | { retry: true; delaySeconds: number };
const DONE: Outcome = { retry: false };

// How the Contents API path is sent: "encoded" lets Octokit send .github%2Fworkflows%2F...,
// "plain" sends the slashes as they are. Set by CONTENTS_PATH_STYLE in wrangler.toml.
export type PathStyle = 'encoded' | 'plain';

export interface Deps {
  log: (line: string) => void;
  actionRepository: string;
  pathStyle: PathStyle;
  settings: SettingsStore;
  enqueue: (messages: { body: QueueMessage; delaySeconds?: number }[]) => Promise<void>;
  // The Worker's own address, for the settings link in pull request bodies.
  origin?: string;
}

// Raised when work cannot be queued or settings cannot be stored, so the webhook can answer
// 503 and GitHub keeps the failed delivery for redelivery.
export class InfrastructureError extends Error {}

interface RepoRef {
  owner: string;
  repo: string;
}

export function settingsUrl(origin: string, installationId: number): string {
  return `${origin}/setup?installation_id=${installationId}`;
}

// Every pull request body the app writes ends with the settings link.
function withSettingsLink(body: string, origin: string | undefined, installationId: number): string {
  if (!origin) return body;
  return `${body.trimEnd()}\n\n---\n\n[Change Docturnal settings](${settingsUrl(origin, installationId)})`;
}

function errorStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status: unknown }).status) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

function retryAfterSeconds(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: Record<string, string> } })?.response?.headers;
  const value = Number(headers?.['retry-after']);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Network errors, server errors, and rate limits are worth retrying; other errors are not.
function retryDelay(err: unknown): number | null {
  if (err instanceof InfrastructureError) return 30;
  const status = errorStatus(err);
  if (status === undefined || Number.isNaN(status)) return 30;
  if (status >= 500 || status === 429) return retryAfterSeconds(err) ?? 60;
  if (status === 403 && /rate limit/i.test(errorMessage(err))) return retryAfterSeconds(err) ?? 120;
  return null;
}

// Decides what happens to a message whose work failed, and logs one line about it.
export function failure(label: string, err: unknown, attempts: number, deps: Deps): Outcome {
  const delay = retryDelay(err);
  if (delay === null) {
    deps.log(`${label}: failed, ${errorMessage(err)}`);
    return DONE;
  }
  if (attempts > MAX_RETRIES) {
    deps.log(`${label}: gave up after ${attempts} attempts, ${errorMessage(err)}; the message moves to the dead letter queue`);
  } else {
    deps.log(`${label}: ${errorMessage(err)}, will retry in ${delay}s (attempt ${attempts})`);
  }
  return { retry: true, delaySeconds: delay };
}

async function infrastructure<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new InfrastructureError(`could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// A commit to the default branch was refused by branch protection or a ruleset.
function isProtectedBranchError(err: unknown): boolean {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : '';
  return (status === 403 || status === 409 || status === 422) && /protected|rule|pull request|status check/i.test(message);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// --- Contents API, with a one-time log of the exact request for checking the real API ---

const realApiLogged = new Set<string>();

export function resetRealApiChecks(): void {
  realApiLogged.clear();
}

function contentsRoute(method: 'GET' | 'PUT', path: string, style: PathStyle): { route: string; params: Record<string, string> } {
  return style === 'plain'
    ? { route: `${method} /repos/{owner}/{repo}/contents/${path}`, params: {} }
    : { route: `${method} /repos/{owner}/{repo}/contents/{path}`, params: { path } };
}

// Logs the first read and the first create of the workflow file in this Worker instance,
// with the request path exactly as sent and the status GitHub returned.
function logRealApiCheck(octokit: Octokit, route: string, params: Record<string, unknown>, status: number | string, deps: Deps) {
  const method = route.split(' ')[0];
  if (realApiLogged.has(method)) return;
  realApiLogged.add(method);
  const { url } = octokit.request.endpoint(route as 'GET /', params);
  const sent = new URL(url);
  deps.log(`real-api check: ${method} ${sent.pathname}${sent.search} -> ${status} (path style ${deps.pathStyle})`);
}

async function contentsRequest(
  octokit: Octokit,
  method: 'GET' | 'PUT',
  { owner, repo }: RepoRef,
  path: string,
  extra: Record<string, string>,
  deps: Deps
): Promise<any> {
  const { route, params } = contentsRoute(method, path, deps.pathStyle);
  const all = { owner, repo, ...params, ...extra };
  const checked = path === WORKFLOW_PATH;
  try {
    const response = await octokit.request(route as 'GET /', all);
    if (checked) logRealApiCheck(octokit, route, all, response.status, deps);
    return response.data;
  } catch (err) {
    if (checked) logRealApiCheck(octokit, route, all, errorStatus(err) ?? 'network error', deps);
    throw err;
  }
}

async function readFile(octokit: Octokit, target: RepoRef, path: string, ref: string, deps: Deps): Promise<{ content: string; sha: string } | null> {
  try {
    const data = await contentsRequest(octokit, 'GET', target, path, { ref }, deps);
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
    return { content: fromBase64(data.content), sha: data.sha };
  } catch (err) {
    if (errorStatus(err) === 404) return null;
    throw err;
  }
}

// Without a sha, creating fails if the file exists, so an existing workflow is never
// overwritten. Only the "Update Docturnal workflow" branch passes a sha.
async function writeWorkflowFile(octokit: Octokit, target: RepoRef, branch: string, deps: Deps, { sha, message }: { sha?: string; message: string }) {
  await contentsRequest(octokit, 'PUT', target, WORKFLOW_PATH, {
    branch,
    message,
    content: toBase64(workflowYaml(deps.actionRepository)),
    ...(sha ? { sha } : {}),
  }, deps);
}

// Creates the branch from `from`. If it exists, it is reused, or with reset moved to `from`
// first, so a new pull request does not carry commits from an earlier one.
async function createBranch(octokit: Octokit, { owner, repo }: RepoRef, branch: string, from: string, { reset = false } = {}) {
  const { data: base } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${from}` });
  try {
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/heads/${branch}`, sha: base.object.sha });
  } catch (err) {
    if (errorStatus(err) !== 422) throw err;
    if (reset) await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}`, sha: base.object.sha, force: true });
  }
}

// --- Webhooks ---

// Creates a key for each repository and puts one setup message per
// repository on the queue.
export async function queueSetups(installationId: number, repos: string[], deps: Deps): Promise<void> {
  if (!repos.length) {
    deps.log(`install ${installationId}: no repositories selected`);
    return;
  }
  await infrastructure('store settings', () => deps.settings.addRepos(installationId, repos));
  const messages = repos.map((repo) => ({ body: { kind: 'setup', installationId, repo, origin: deps.origin } as QueueMessage }));
  for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
    await infrastructure('queue work', () => deps.enqueue(messages.slice(i, i + QUEUE_BATCH_LIMIT)));
  }
  deps.log(`install ${installationId}: queued ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} for setup`);
}

export async function onRepositoriesRemoved(installationId: number, repos: string[], deps: Deps): Promise<void> {
  await infrastructure('store settings', () => deps.settings.removeRepos(installationId, repos));
  deps.log(`install ${installationId}: removed ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} from the schedule`);
}

export async function onInstallationDeleted(installationId: number, deps: Deps): Promise<void> {
  await infrastructure('delete settings', () => deps.settings.delete(installationId));
  deps.log(`install ${installationId}: uninstalled, deleted its settings`);
}

export async function onSetupMerged(payload: any, deps: Deps): Promise<void> {
  const fullName = payload.repository.full_name;
  const pr = payload.pull_request;
  if (!pr.merged || pr.head.ref !== SETUP_BRANCH || pr.head.repo?.full_name !== fullName) return;
  await infrastructure('queue work', () =>
    deps.enqueue([{ body: { kind: 'dispatch', installationId: payload.installation.id, repo: fullName, reason: 'first', ref: pr.base.ref } }])
  );
  deps.log(`setup ${fullName}: setup pull request #${pr.number} merged, first run queued`);
}

// The branches Docturnal creates for its pull requests.
export const DOCTURNAL_BRANCHES: readonly string[] = [UPDATE_BRANCH, SETUP_BRANCH, WORKFLOW_UPDATE_BRANCH];

// Deletes a Docturnal branch once its pull request is closed, merged or not, so repositories
// do not collect stale branches. After a merge, docturnal/update is kept while a Docturnal run
// is queued, pending, or in progress, since that run builds on it; the next closed pull request
// deletes it. A pull request closed without merging loses its branch at once: a run going then
// finds the branch gone when it pushes, and leaves its work for the next run, so the declined
// changes never come back. A branch that is already gone counts as deleted. Failures are logged, never retried.
export async function onPullRequestClosed(octokit: Octokit, payload: any, deps: Deps): Promise<void> {
  const fullName = payload.repository.full_name;
  const pr = payload.pull_request;
  const branch = pr.head.ref;
  // A pull request from a fork names a branch in someone else's repository.
  if (!DOCTURNAL_BRANCHES.includes(branch) || pr.head.repo?.full_name !== fullName) return;
  const owner = payload.repository.owner.login ?? payload.repository.owner.name;
  const repo = payload.repository.name;
  const label = `pull request ${fullName}#${pr.number}`;
  try {
    if (branch === UPDATE_BRANCH && pr.merged && (await hasActiveRun(octokit, { owner, repo }))) {
      deps.log(`${label}: kept ${branch}, a Docturnal run is queued or in progress; the next closed pull request deletes it`);
      return;
    }
    try {
      // The branch is one of ours, so its name is sent as it is, with its slash.
      await octokit.request(`DELETE /repos/{owner}/{repo}/git/refs/heads/${branch}` as 'GET /', { owner, repo });
    } catch (err) {
      const status = errorStatus(err);
      if (status !== 404 && status !== 422) throw err;
      deps.log(`${label}: ${branch} was already deleted`);
      return;
    }
    deps.log(`${label}: deleted ${branch}`);
  } catch (err) {
    deps.log(`${label}: could not delete ${branch}, ${errorMessage(err)}`);
  }
}

// The pull request's title, last-run.md's first heading when it names Docturnal, and its body,
// the rest. last-run.md from before titles were set this way starts with "# Docturnal update".
function splitTitle(text: string): { title: string; body: string } {
  const match = /^# (Docturnal[^\n]{0,80})\n+/.exec(text);
  if (!match || match[1].trim() === 'Docturnal update') return { title: UPDATE_PR_TITLE, body: text };
  return { title: match[1].trim(), body: text.slice(match[0].length) };
}

// Opens or updates the pull request for docturnal/update, with last-run.md's title and body.
export async function onUpdatePush(octokit: Octokit, payload: any, deps: Deps): Promise<void> {
  const fullName = payload.repository.full_name;
  if (payload.ref !== `refs/heads/${UPDATE_BRANCH}` || payload.deleted) return;
  if (payload.sender?.login !== BOT_LOGIN) {
    deps.log(`push ${fullName}: ignored a push to ${UPDATE_BRANCH} by ${payload.sender?.login ?? 'unknown'}`);
    return;
  }
  const owner = payload.repository.owner.login ?? payload.repository.owner.name;
  const repo = payload.repository.name;
  try {
    const report = await readFile(octokit, { owner, repo }, LAST_RUN_PATH, UPDATE_BRANCH, deps);
    let { title, body } = report && report.content.trim() ? splitTitle(report.content) : { title: UPDATE_PR_TITLE, body: FALLBACK_UPDATE_BODY };
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\nThe rest of this description is in \`${LAST_RUN_PATH}\`.`;
    body = withSettingsLink(body, deps.origin, payload.installation.id);

    const { data: open } = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open', head: `${owner}:${UPDATE_BRANCH}` });
    if (open.length) {
      await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: open[0].number, title, body });
      deps.log(`push ${fullName}: updated pull request #${open[0].number}`);
      return;
    }
    const { data: pr } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title,
      head: UPDATE_BRANCH,
      base: payload.repository.default_branch,
      body,
    });
    deps.log(`push ${fullName}: opened pull request #${pr.number}`);
  } catch (err) {
    deps.log(`push ${fullName}: failed to open or update the pull request, ${errorMessage(err)}`);
  }
}

// --- Queue work ---

async function openSetupPullRequest(octokit: Octokit, target: RepoRef, defaultBranch: string, message: SetupMessage, deps: Deps): Promise<number> {
  const { owner, repo } = target;
  await createBranch(octokit, target, SETUP_BRANCH, defaultBranch);
  if ((await readFile(octokit, target, WORKFLOW_PATH, SETUP_BRANCH, deps)) === null) {
    await writeWorkflowFile(octokit, target, SETUP_BRANCH, deps, { message: 'Add the Docturnal workflow' });
  }
  const { data: open } = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open', head: `${owner}:${SETUP_BRANCH}` });
  if (open.length) return open[0].number;
  const { data: pr } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner,
    repo,
    title: SETUP_PR_TITLE,
    head: SETUP_BRANCH,
    base: defaultBranch,
    body: withSettingsLink(SETUP_PR_BODY, message.origin, message.installationId),
  });
  return pr.number;
}

// Proposes the current template to a repository with an older one, through a pull request.
// Each version is proposed once: an open pull request for an older version is brought up
// to date, and a closed one for the current version means the owner declined it.
// Returns the pull request number and what happened, or null when it was declined.
async function proposeWorkflowUpdate(
  octokit: Octokit,
  target: RepoRef,
  defaultBranch: string,
  from: number,
  origin: string | undefined,
  installationId: number,
  deps: Deps
): Promise<{ number: number; action: 'opened' | 'updated' | 'already proposed' } | null> {
  const { owner, repo } = target;
  const body = withSettingsLink(workflowUpdateBody(from), origin, installationId);
  const { data: earlier } = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'all', head: `${owner}:${WORKFLOW_UPDATE_BRANCH}` });
  const open = earlier.find((pr: { state: string }) => pr.state === 'open');
  if (open && proposedVersion(open.body) >= WORKFLOW_VERSION) return { number: open.number, action: 'already proposed' };
  if (!open && earlier.some((pr: { body?: string | null }) => proposedVersion(pr.body) >= WORKFLOW_VERSION)) return null;

  // An open pull request keeps its branch; otherwise the branch starts again from the default branch.
  if (!open) await createBranch(octokit, target, WORKFLOW_UPDATE_BRANCH, defaultBranch, { reset: true });
  const current = await readFile(octokit, target, WORKFLOW_PATH, WORKFLOW_UPDATE_BRANCH, deps);
  if (!current || current.content !== workflowYaml(deps.actionRepository)) {
    await writeWorkflowFile(octokit, target, WORKFLOW_UPDATE_BRANCH, deps, { sha: current?.sha, message: `Update the Docturnal workflow to version ${WORKFLOW_VERSION}` });
  }
  if (open) {
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: open.number, body });
    return { number: open.number, action: 'updated' };
  }
  const { data: pr } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner,
    repo,
    title: WORKFLOW_UPDATE_PR_TITLE,
    head: WORKFLOW_UPDATE_BRANCH,
    base: defaultBranch,
    body,
  });
  return { number: pr.number, action: 'opened' };
}

function describeVersion(version: number): string {
  return version === 0 ? 'the workflow has the old schedule' : `the workflow is version ${version}`;
}

function describeProposal(proposal: { number: number; action: string } | null): string {
  if (!proposal) return `the update to version ${WORKFLOW_VERSION} was declined earlier, left it unchanged`;
  if (proposal.action === 'opened') return `opened update pull request #${proposal.number}`;
  if (proposal.action === 'updated') return `updated pull request #${proposal.number} to version ${WORKFLOW_VERSION}`;
  return `update pull request #${proposal.number} was already proposed`;
}

type SetupMessage = Extract<QueueMessage, { kind: 'setup' }>;
type DispatchMessage = Extract<QueueMessage, { kind: 'dispatch' }>;

// Adds the workflow to one repository and queues the first run. Safe to run more than once.
export async function setUpRepository(octokit: Octokit, message: SetupMessage, attempts: number, deps: Deps): Promise<Outcome> {
  const fullName = message.repo;
  const [owner, repo] = fullName.split('/');
  const target = { owner, repo };
  const label = `setup ${fullName}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(deps.actionRepository)) {
    deps.log(`${label}: skipped, ACTION_REPOSITORY is not set`);
    return DONE;
  }
  const queueFirstRun = (ref: string) =>
    infrastructure('queue work', () =>
      deps.enqueue([{ body: { kind: 'dispatch', installationId: message.installationId, repo: fullName, reason: 'first', ref }, delaySeconds: DISPATCH_DELAY_SECONDS }])
    );
  try {
    let defaultBranch: string;
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      defaultBranch = data.default_branch;
    } catch (err) {
      if (errorStatus(err) !== 404) throw err;
      deps.log(`${label}: skipped, the app cannot see this repository`);
      return DONE;
    }

    const existing = await readFile(octokit, target, WORKFLOW_PATH, defaultBranch, deps);
    if (existing !== null) {
      if (existing.content === workflowYaml(deps.actionRepository)) {
        // An earlier attempt created the file but failed before queuing the first run.
        if (attempts > 1) {
          await queueFirstRun(defaultBranch);
          deps.log(`${label}: found the workflow from an earlier attempt, first run queued`);
        } else {
          deps.log(`${label}: already set up`);
        }
        return DONE;
      }
      const version = templateVersion(existing.content, deps.actionRepository);
      if (version !== null && version < WORKFLOW_VERSION) {
        const proposal = await proposeWorkflowUpdate(octokit, target, defaultBranch, version, message.origin, message.installationId, deps);
        deps.log(`${label}: ${describeVersion(version)}, ${describeProposal(proposal)}`);
        return DONE;
      }
      deps.log(`${label}: ${WORKFLOW_PATH} already exists on ${defaultBranch}, left it unchanged`);
      return DONE;
    }

    try {
      await writeWorkflowFile(octokit, target, defaultBranch, deps, { message: 'Add the Docturnal workflow' });
    } catch (err) {
      if (!isProtectedBranchError(err)) throw err;
      const number = await openSetupPullRequest(octokit, target, defaultBranch, message, deps);
      deps.log(`${label}: ${defaultBranch} is protected, opened setup pull request #${number}`);
      return DONE;
    }
    await queueFirstRun(defaultBranch);
    deps.log(`${label}: added ${WORKFLOW_PATH} to ${defaultBranch}, first run queued`);
    return DONE;
  } catch (err) {
    return failure(label, err, attempts, deps);
  }
}

// True when a Docturnal run in this repository has not finished yet.
async function hasActiveRun(octokit: Octokit, { owner, repo }: RepoRef): Promise<boolean> {
  for (const status of ACTIVE_RUN_STATUSES) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
      owner,
      repo,
      workflow_id: WORKFLOW_FILE,
      status,
      per_page: 1,
    });
    if (data.total_count > 0) return true;
  }
  return false;
}

// Checks a repository before its nightly run. Proposes a workflow update when the template
// is older than the current version. Returns why the run is skipped (null to start it), and
// the template's version.
async function beforeNightlyRun(octokit: Octokit, target: RepoRef, ref: string, message: DispatchMessage, deps: Deps): Promise<{ skip: string | null; version: number | null }> {
  const workflow = await readFile(octokit, target, WORKFLOW_PATH, ref, deps);
  if (!workflow) return { skip: `${WORKFLOW_PATH} is not on ${ref}`, version: null };
  const version = templateVersion(workflow.content, deps.actionRepository);
  if (version !== null && version < WORKFLOW_VERSION) {
    // A failed proposal is logged and tried again the next night; it never blocks the run.
    try {
      const proposal = await proposeWorkflowUpdate(octokit, target, ref, version, deps.origin, message.installationId, deps);
      // Logged only when something changed, so a declined or pending proposal is not logged every night.
      if (proposal && proposal.action !== 'already proposed') deps.log(`dispatch ${message.repo}: ${describeVersion(version)}, ${describeProposal(proposal)}`);
    } catch (err) {
      deps.log(`dispatch ${message.repo}: could not propose the workflow update, ${errorMessage(err)}`);
    }
  }
  // The old template runs on its own schedule until its update pull request is merged.
  if (version === 0) return { skip: 'the workflow still has its own schedule', version };
  if (await hasActiveRun(octokit, target)) return { skip: 'a run is already in progress', version };
  return { skip: null, version };
}

// The template version that brought the existing-code input. Older templates refuse it.
const EXISTING_CODE_FROM_VERSION = 4;

// Starts docturnal.yml with the installation's comment level.
export async function dispatchRun(octokit: Octokit, message: DispatchMessage, attempts: number, deps: Deps): Promise<Outcome> {
  const [owner, repo] = message.repo.split('/');
  const label = `dispatch ${message.repo}`;
  const which = message.reason === 'first' ? 'the first run' : 'the nightly run';
  try {
    let ref = message.ref;
    if (!ref) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      ref = data.default_branch as string;
    }
    let version: number | null;
    if (message.reason === 'nightly') {
      const before = await beforeNightlyRun(octokit, { owner, repo }, ref, message, deps);
      if (before.skip) {
        deps.log(`${label}: skipped, ${before.skip}`);
        return DONE;
      }
      version = before.version;
    } else {
      // The first run follows a fresh install, so the template is current unless it says otherwise.
      const workflow = await readFile(octokit, { owner, repo }, WORKFLOW_PATH, ref, deps).catch(() => null);
      version = workflow ? templateVersion(workflow.content, deps.actionRepository) : WORKFLOW_VERSION;
    }
    const choices = (await deps.settings.getChoices(message.installationId)) ?? DEFAULT_SETTINGS;
    const commentLevel = message.commentLevel ?? choices.commentLevel;
    const existingCode = message.existingCode ?? choices.existingCode;
    // Only templates that have the existing-code input get it; GitHub refuses an unknown input.
    const inputs: Record<string, string> = { 'comment-level': commentLevel };
    if (version !== null && version >= EXISTING_CODE_FROM_VERSION) inputs['existing-code'] = existingCode;
    try {
      await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
        owner,
        repo,
        workflow_id: WORKFLOW_FILE,
        ref,
        inputs,
      });
    } catch (err) {
      const status = errorStatus(err);
      if (status === 422 && /unexpected inputs/i.test(errorMessage(err))) {
        // The old template runs on its own schedule until its update pull request is merged.
        deps.log(`${label}: skipped, the workflow still has its own schedule`);
        return DONE;
      }
      if (message.reason === 'nightly' && status === 404) {
        deps.log(`${label}: skipped, ${WORKFLOW_PATH} is not on ${ref}`);
        return DONE;
      }
      if (status === 404 || status === 422) {
        // GitHub has not registered the new workflow yet.
        if (attempts > MAX_RETRIES) {
          deps.log(`${label}: gave up after ${attempts} attempts, the workflow is still not registered; the message moves to the dead letter queue`);
        } else {
          deps.log(`${label}: workflow not registered yet, will retry in ${NOT_REGISTERED_DELAY_SECONDS}s (attempt ${attempts})`);
        }
        return { retry: true, delaySeconds: NOT_REGISTERED_DELAY_SECONDS };
      }
      throw err;
    }
    deps.log(`${label}: started ${which} on ${ref} with ${commentLevel} comments`);
    return DONE;
  } catch (err) {
    return failure(label, err, attempts, deps);
  }
}
