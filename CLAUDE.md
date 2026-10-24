# CLAUDE.md

This file guides all work on Docturnal. Read it before you change anything. If a request conflicts with this file, stop and ask before you proceed.

## Overview

**Docturnal**: "Your codebase, documented overnight."

Docturnal is free, private, and needs no setup from users. A user clicks Install on the Docturnal GitHub App and does nothing else. Every night, Docturnal adds comments to their code, updates their documentation, and opens a pull request for them to review.

Core promises. Every design decision protects these:

- **Free.** It runs only on GitHub's standard hosted runner, with no paid services.
- **Private.** Code never leaves the GitHub runner. No outside model servers or AI APIs, and no telemetry.
- **Zero setup.** Installing the app is the only step. Users never configure models, tokens, or secrets. An optional settings page lets them choose the run time, time zone, and comment level; the defaults are midnight, America/New_York, and medium. While the settings are still the defaults, opening the page saves the browser's time zone right away, so closing it gives midnight in the user's own time zone.
- **Safe.** The model never rewrites source files. A pull request is the only way changes reach the user's code, and a person always reviews it.

## The three parts

This is one public repo with three parts.

### 1. GitHub Action (repo root and `src/`)

- A composite action. `action.yml` is at the repo root, and the code is in `src/`.
- Runs nightly on GitHub's standard hosted runner (`ubuntu-latest`), started by the app through `workflow_dispatch`. The workflow file has no schedule.
- Installs Ollama, pulls the models, adds comments, writes documentation, and pushes the result to `docturnal/update`.
- **Never opens pull requests.** It only pushes a branch.

### 2. GitHub App backend (`app/`)

- A GitHub App named Docturnal, deployed as a Cloudflare Worker.
- On install, it queues each selected repo (Cloudflare Queue, one repo per message), commits `.github/workflows/docturnal.yml`, and starts the first run.
- An hourly cron (minute 7) dispatches `docturnal.yml` for every installation whose chosen local hour has arrived, passing `comment-level` as a `workflow_dispatch` input. Daylight saving time is handled with `Intl.DateTimeFormat`. A repo is skipped that night if a Docturnal run is already queued, pending, or in progress. Every GitHub API call sends `X-GitHub-Api-Version: 2026-03-10`.
- Serves the optional settings page at `/setup` (GitHub sign-in, then a check with `GET /user/installations` that the user can access the installation). Settings live in Cloudflare KV, and no key is ever read and written back: one empty key per repo, which webhooks create and delete, and one settings key with the time, time zone, and comment level, written only by the settings page (without it, the defaults apply). The cron finds each installation's repos by listing keys by prefix. Nothing else, and never code. Uninstalling deletes every key with the installation's prefix.
- The workflow template carries a version line (`# Docturnal workflow version N.`), and its `concurrency` group lets only one run happen at a time per repo. A repo with an older version gets the current one through a pull request titled "Update Docturnal workflow", proposed once per version, at setup or before its nightly run. Raise `WORKFLOW_VERSION` in `app/src/workflow.ts` whenever the template changes.
- When the Action pushes `docturnal/update`, the app opens the pull request under its own name, or updates the open one.
- Only makes GitHub API calls. It never reads, stores, or forwards source code.

### 3. Tests (`test/`)

- Unit and integration tests for the Action and the app.
- Includes a mock Ollama server that implements the Ollama HTTP endpoints we use and returns canned responses, so tests never need a real model.

### How the parts talk to each other

```
User installs the app
  -> GitHub sends an `installation` / `installation_repositories` webhook to the Worker
  -> Worker commits .github/workflows/docturnal.yml
       (to the default branch; if that is blocked, to docturnal/setup with a setup PR)
  -> Worker dispatches the workflow (workflow_dispatch) for the first run

Every hour at minute 7 (Worker cron)
  -> For each installation whose chosen local hour has arrived, the Worker dispatches
     docturnal.yml with its comment-level input

Each dispatched run
  -> Action runs on the hosted runner, using the workflow's GITHUB_TOKEN
  -> Pre-check (no model, no Ollama install): checks out docturnal/update (if it exists)
     and merges the base branch into it, reads .docturnal/state.json, and finds files whose
     hash differs from the state
  -> No changes: logs "No changes since the last run" and skips every later step
  -> Changes: comments + docs + state + .docturnal/last-run.md
     -> force-pushes docturnal/update

GitHub sends a `push` webhook for docturnal/update to the Worker
  -> Worker reads .docturnal/last-run.md from that branch
  -> Opens the PR (docturnal/update -> default branch) or updates the open PR's body
```

The Action and the app never call each other directly. The only channel between them is git: the branch, `.docturnal/state.json`, and `.docturnal/last-run.md`.

## Comment levels

The default is `medium`. Users change the level on the app's settings page (`/setup`), linked from every Docturnal pull request. The app passes it to the workflow as the `comment-level` `workflow_dispatch` input, and the workflow passes it to the Action. The run time and time zone are set on the same page. Nothing else is configurable.

| Level | Behavior |
|---|---|
| `low` | Sparse, single-line comments of a few words. |
| `medium` | Single-line comments that can be longer, placed less sparsely. |
| `heavy` | A mix of single-line and multiline comments. |
| `off` | No comments. Documentation only. |

Comments explain intent and non-obvious behavior. They do not restate the code. Docturnal never removes or changes existing comments, and never adds a comment where one already exists.

## Documentation rules

- `README.md` at the repository root is the main document. It gives an overview of the codebase, and its Architecture (or Documentation) section links to every layer document. Docturnal no longer writes `docs/README.md`; if one with the marker exists, the next run's pull request removes it. One without the marker is never removed.
- `docs/` holds only the layer documents, one per architecture layer, such as `docs/<layer>.md`. The model decides what the layers are. Store the layer-to-file mapping in `.docturnal/state.json` so that layers stay stable between runs. "Related layers" links stay relative within `docs/`, and each layer document links back to the main document as `../README.md`.
- Regenerate a layer document only when files in that layer change.
- Every generated layer document starts with this marker on its first line:
  `<!-- Generated by Docturnal. Edits to this file are replaced the next time its layer changes. -->`
- If a file in `docs/` has no marker, Docturnal treats it as written by a person and never overwrites it.

### The README is shared with people

`README.md` never carries the marker. Its first line is a hidden comment instead: `<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->`. The code is in `src/readme.js`.

- `.docturnal/readme.json` saves the README as Docturnal last wrote it: the full text, and each section (split by H2 heading; the text before the first H2 is the intro) with a normalized heading, a hash, and its owner (`docturnal` or `person`). It also keeps a list of suppressed headings and computed blocks.
- Each run compares the current README with the saved one, section by section:
  - A saved section that is gone: a person deleted it. Its heading is suppressed and never written again.
  - A section that changed: a person edited it, and it becomes theirs.
  - A section that is not in the saved README: a person added it, and it is theirs. If its heading was suppressed, it is no longer.
  - A section identical to the saved one keeps its owner. Docturnal may regenerate its own.
- Docturnal's own standard sections (intro, Overview, Architecture, Getting started, Project structure) are regenerated when the code or the layers change, unless suppressed. A new standard section goes in its standard position; otherwise the person's order stays. A person's section with a standard heading or an alias of one (for example "Installation" for Getting started) counts as that section, so Docturnal does not add a second one.
- A person's section is polished once per change, never regenerated: rewritten for clarity under the same writing rules, with no new information and the heading text kept exactly. The saved hash is the polished result's, so an unchanged section is not rewritten again.
- Polish safeguard: if the rewrite drops or changes any link, image, badge, inline code span, code block, number, or HTML tag of the original, adds a link, command, number, or heading, or is under 70% of the original's word count, the original stays and the report says "kept in your wording".
- Computed blocks (the layers table, the available-scripts table, the directory tree) sit between hidden markers, such as `<!-- docturnal:layers -->` and `<!-- /docturnal:layers -->`. A block that is present is refreshed, even inside a person's section. A block a person removed is suppressed and not added again until they put the markers back.
- On the first run in a repo whose README Docturnal never saved, every existing section belongs to a person (kept and polished), and the missing standard sections and blocks are added.
- Never delete or drop a person's content, and never re-add suppressed content. A run where nothing in the README needs updating leaves it byte for byte unchanged.
- Write for human readers, not for LLMs. Follow the Google developer documentation style:
  - Second person ("you"), active voice, present tense.
  - Sentence-case headings.
  - Short paragraphs.
  - No filler or marketing words, such as "simply," "easily," "powerful," or "seamless."
  - No emojis.
  - No mention of AI, models, or Docturnal in the body text. The marker, and the README's hidden comment, are the only exceptions.
- Code identifiers in backticks. Use relative links between documents.

## Model rules

- Docturnal only ever uses Ollama on GitHub's standard hosted runner. Do not add support for paid or larger runners, self-hosted runners, outside model servers, or AI APIs, and do not add options for them.
- Two roles:
  - **Comment model:** a small, fast code model, because it handles many calls.
  - **Docs model:** the largest model that fits the runner's available memory, because it handles few calls.
- Model choice is automatic. The Action detects the available memory at run time and picks from a ranked candidate list in `src/`. Users never configure models.
- Ollama listens only on `127.0.0.1`. Use a fixed seed and low temperature for repeatable output.
- Treat every model response as untrusted input. Parse it strictly, validate it, and drop anything invalid. A bad response skips that unit of work. It never fails the whole run or produces a broken file.

## Safety rules

- **The model never rewrites source files.** It proposes `{line, text}` comment pairs. Our code inserts them and then verifies the result.
- Insertion rules:
  - `line` refers to a line in the original file, counted from 1. Out-of-range, duplicate, or ill-formed pairs are dropped. One model response is read as counting from 0 only on clear evidence: a line 0, or at least two pairs that all fail placement as given and all fit after adding 1.
  - Insert whole new lines only. Never edit, move, or delete an existing line.
  - Match the indentation of the target line, and use the file's comment syntax and line endings.
  - Reject text that could end a comment early or inject code, such as `*/` or newlines in single-line comments.
- Verification, required before a file is written:
  - With the inserted lines removed, the file is byte-for-byte identical to the original.
  - For JavaScript and TypeScript, parse the result with the `typescript` package and confirm it introduces no new syntax errors and the same tokens apart from comments.
  - If verification fails, discard all changes to that file.
- Skip files that are generated, vendored, binary, minified, very large, or covered by `.gitignore`, as well as anything under `.github/`, `.docturnal/`, and `docs/`, unless they are Docturnal-owned generated docs.
- **Code never goes to an outside service.** The Action makes network calls only to install Ollama, pull models, and push to GitHub. The app backend never reads source code. It only makes GitHub API calls. It may read `.docturnal/last-run.md`, which the Action generates.
- App permissions are the minimum needed, and no more:
  - Contents: write
  - Workflows: write
  - Pull requests: write
  - Actions: write
  - Metadata: read
- Webhooks: verify every signature. Keep secrets, such as the app private key and webhook secret, only in Worker secrets, never in the repo. Do not log payload contents beyond what you need for debugging.
- The Action only pushes to `docturnal/update`. It never pushes to the default branch or any other branch.

## Nightly behavior

- `.docturnal/state.json` records each file's hash (taken after comments), summary, and symbols, plus the layers and the generated doc slugs. A file is processed when it is new or its hash differs from the state. Deleted files are removed from the state. Changing the comment level reprocesses every file.
- If `origin/docturnal/update` exists, the run checks it out and merges the base branch into it, so an open pull request keeps its changes. If the merge conflicts, the run starts fresh from the base. The result is force-pushed.
- Each run comments every file first with the comment model, then writes all docs with the docs model, so the model is swapped only once. New files stop starting at `time-budget-minutes` minus 25 minutes; files not reached wait for the next run.
- Layers are re-planned only when the set of summarized files changes. If the docs model cannot load (out of memory or a load error), the doc is written with the comment model and marked "written with the fallback model" in `last-run.md`.
- A night with no changes makes no model calls, no commit, and no push, and leaves the state timestamp alone. A pre-check step (`src/precheck.js`, Node built-ins only) runs first: it sets up the branch, loads the state, and hashes the in-scope files with the same code as `main.js`. It outputs `changed=true` when a file is new, changed, or deleted, the comment level changed, a generated doc is missing, a person edited `README.md` (so their section gets polished), or a `docs/README.md` with the marker is left to remove. Otherwise it logs "No changes since the last run", and every later step, including model selection and the Ollama install, is skipped.
- The first run, with no state file, processes the whole repo, within runner time limits.
- Write `.docturnal/last-run.md` as the pull request body. It lists comments added per file and whether a parser checked each file, a count per file of comments proposed, dropped by placement rules, the length limit, or the density limit, rejected by the safety check, and added (never comment text or code), docs updated or removed, the README sections updated, polished, kept in your wording, and not re-added because you removed them (by heading only), comments rejected by the safety check, files left for the next run, and the models used. It follows the same writing style as the docs.

## Names

| Thing | Name |
|---|---|
| Product and GitHub App | `Docturnal` |
| Update branch | `docturnal/update` |
| Setup branch | `docturnal/setup` |
| Workflow update branch | `docturnal/workflow-update` |
| Repo key (KV) | `install:<installation ID>:repo:<owner>/<name>` |
| Settings key (KV) | `install:<installation ID>:settings` |
| Settings page | `/setup` on the Worker |
| Workflow file | `.github/workflows/docturnal.yml` |
| State file | `.docturnal/state.json` |
| Main document | `README.md` at the repository root |
| README state | `.docturnal/readme.json` |
| README comment | `<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->` |
| README block markers | `<!-- docturnal:layers -->`, `<!-- docturnal:scripts -->`, `<!-- docturnal:tree -->`, each closed by `<!-- /docturnal:NAME -->` |
| PR body | `.docturnal/last-run.md` |
| Doc marker (layer docs) | `<!-- Generated by Docturnal. Edits to this file are replaced the next time its layer changes. -->` |

Do not rename these. Other parts and users' repos depend on them.

## Folder layout

```
action.yml          Composite action definition (repo root)
package.json        Runtime dependency: typescript only
src/                Action code (Node 20+, plain CommonJS, no build step)
app/                GitHub App backend (Cloudflare Worker)
test/               Tests for the Action and app, including the mock Ollama server
docs/               Docturnal's own documentation
README.md           Project README
CLAUDE.md           This file
```

## Code conventions

- **Action:** Node 20+, plain JavaScript in CommonJS (`require` / `module.exports`). No build step, no bundler, no TypeScript source. The only runtime dependency is `typescript`, used as a parser. Use Node built-ins for everything else, such as `fetch`, `child_process`, `fs`, and `node:test`.
- **App:** plain JavaScript for Cloudflare Workers. Use Web Crypto for webhook signatures and app JWTs. Keep runtime dependencies to zero where you can, and justify any you add.
- **Tests:** `node:test` and `node:assert`. Tests never call a real model or the real GitHub API.
- Keep modules small and single-purpose. Prefer clear code over clever code.

## Build order

Work in this order. Finish and test each step before you start the next. Do not skip ahead.

1. **Spec**: this file.
2. **Action scaffold**: `action.yml`, `package.json`, `src/` entry point, Ollama install and model selection, mock Ollama server, and the test harness.
3. **Comment engine**: file selection, prompts per comment level, `{line, text}` parsing, insertion, and verification.
4. **Docs generator**: layer detection, per-layer documents, the main document (`README.md`), the marker, and style rules.
5. **State and branch push**: `.docturnal/state.json`, change detection, the no-change exit, `.docturnal/last-run.md`, and the force-push to `docturnal/update`.
6. **App backend**: Worker webhook handling, install flow (workflow commit, setup branch, first-run dispatch), and opening and updating pull requests.
7. **App registration and deploy**: GitHub App manifest with the minimum permissions, Worker secrets, and deployment.
8. **README and release**: project README, versioned release and tags for the Action, and the install link.
