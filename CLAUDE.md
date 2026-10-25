# CLAUDE.md

This file guides all work on Docturnal. Read it before you change anything. If a request conflicts with this file, stop and ask before you proceed.

## Overview

**Docturnal**: "Your codebase, documented overnight."

Docturnal is free, private, and needs no setup from users. A user clicks Install on the Docturnal GitHub App and does nothing else. Every night, Docturnal adds comments to their code, updates their documentation, and opens a pull request for them to review.

Core promises. Every design decision protects these:

- **Free.** It runs only on GitHub's standard hosted runner, with no paid services.
- **Private.** Code never leaves the GitHub runner. No outside model servers or AI APIs, and no telemetry.
- **Zero setup.** Installing the app is the only step. Users never configure models, tokens, or secrets. An optional settings page lets them choose the run time, time zone, comment level, and what to do with existing code; the defaults are midnight, America/New_York, medium, and commenting existing code gradually. While the settings are still the defaults, opening the page saves the browser's time zone right away, so closing it gives midnight in the user's own time zone.
- **Safe.** The model never rewrites source files. A pull request is the only way changes reach the user's code, and a person always reviews it.

Docturnal's only offering is the public GitHub App, on GitHub-hosted runners. There is no mode without the app, no self-hosted runner support, no Ollama server of one's own, and no parallel jobs. A self-hosted version of the whole app may be built later, from git history, if a company asks for one.

## The three parts

This is one public repo with three parts.

### 1. GitHub Action (repo root and `src/`)

- A composite action. `action.yml` is at the repo root, and the code is in `src/`.
- Runs nightly on GitHub's standard hosted runner (`ubuntu-latest`), started by the app through `workflow_dispatch`. The workflow file has no schedule.
- Each run is one job: it plans the work (`planWork` in `src/changes.js`), does it (`src/process.js`), and applies it, writes the docs, and pushes (`src/apply.js`).
- Installs Ollama, pulls the models, adds comments, writes documentation, and pushes the result to `docturnal/update`.
- **Everything that runs in users' repositories is pinned** (see "Supply chain").
- Caches between runs the Ollama models and the Ollama install, keyed on the pinned version and its checksum. A cache entry is used only after every file in it matches its pin.
- **Never opens pull requests.** It only pushes a branch.

### 2. GitHub App backend (`app/`)

- A GitHub App named Docturnal, deployed as a Cloudflare Worker.
- On install, it queues each selected repo (Cloudflare Queue, one repo per message), commits `.github/workflows/docturnal.yml`, and starts the first run.
- An hourly cron (minute 7) dispatches `docturnal.yml` for every installation whose chosen local hour has arrived, passing `comment-level`, and `existing-code` to templates from version 4 on, as `workflow_dispatch` inputs. Daylight saving time is handled with `Intl.DateTimeFormat`. A repo is skipped that night if a Docturnal run is already queued, pending, or in progress. Every GitHub API call sends `X-GitHub-Api-Version: 2026-03-10`.
- Serves the optional settings page at `/setup`: GitHub sign-in, then a check that the user manages the installation (see "Settings access"). The sign-in token is revoked as soon as that check is done; the session never uses it. Settings live in Cloudflare KV, and no key is ever read and written back: one empty key per repo, which webhooks create and delete, and one settings key with the time, time zone, comment level, and existing-code choice (`gradual` or `none`), written only by the settings page (without it, the defaults apply). The settings key's metadata repeats the time, time zone, comment level, and existing-code choice, so the cron finds each installation's repos and choices by listing keys by prefix, with no read per installation; it reads a settings key only when its metadata predates the choices. One installation whose settings cannot be read is skipped that hour, never run with the defaults, and queue batches are sent as they fill, so one failure never stops the others. Nothing else, and never code. Uninstalling deletes every key with the installation's prefix.
- The workflow template (version 5) has one job, `docturnal`, which runs the Action with the `comment-level` and `existing-code` inputs, `time-budget-minutes: "90"`, and `job-timeout-minutes: "120"`. Its `timeout-minutes: 120` leaves at least 20 minutes after the time budget. The workflow has only `contents: write`, and no artifacts. Version 4 adds the `existing-code` input to version 3, and version 5 pins `actions/checkout` to a full commit SHA. The Worker sends `existing-code` only to version 4 or later, because GitHub rejects a dispatch with an input the workflow doesn't declare. The template refers to Docturnal's own Action by its release tag, `@v1`. The template carries a version line (`# Docturnal workflow version N.`), and its `concurrency` group lets only one run happen at a time per repo. A repo with an older version gets the current one through a pull request titled "Update Docturnal workflow", proposed once per version, at setup or before its nightly run, and listing every change since the repo's version. Raise `WORKFLOW_VERSION` in `app/src/workflow.ts` whenever the template changes, and describe the change in `VERSION_CHANGES` in `app/src/handlers.ts`.
- When the Action pushes `docturnal/update`, the app opens the pull request under its own name, or updates the open one. Its title is `last-run.md`'s first heading ("Docturnal: documentation" or "Docturnal: comments and documentation"), and its body is the rest.
- When a pull request from one of Docturnal's branches (`docturnal/update`, `docturnal/setup`, `docturnal/workflow-update`) in the same repository closes, merged or not, the app deletes that branch. After a merge, it keeps `docturnal/update` while a Docturnal run is queued, pending, or in progress, and the next closed pull request deletes it then. A pull request closed without merging loses its branch at once, so a run going then can't push the declined changes back. A branch that is already gone counts as deleted. The next run after a deletion starts fresh from the base branch.
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
     docturnal.yml with its comment-level and existing-code inputs

Each dispatched run
  -> Action runs on the hosted runner, using the workflow's GITHUB_TOKEN
  -> Pre-check (no model, no Ollama install): checks out docturnal/update (if it exists)
     and merges the base branch into it, reads .docturnal/state.json, and finds the work:
     the documentation pass, new and changed files, and one batch of existing code
  -> No work: logs "No changes since the last run" and skips every later step
  -> Work: summaries or comments, then docs + state + .docturnal/last-run.md
     -> pushes docturnal/update only if it is still what the run started from

GitHub sends a `push` webhook for docturnal/update to the Worker
  -> Worker reads .docturnal/last-run.md from that branch
  -> Opens the PR (docturnal/update -> default branch) or updates the open PR's title and body
```

The Action and the app never call each other directly. The only channel between them is git: the branch, `.docturnal/state.json`, and `.docturnal/last-run.md`.

## Comment levels

The default is `medium`. Users change the level on the app's settings page (`/setup`), linked from every Docturnal pull request. The app passes it to the workflow as the `comment-level` `workflow_dispatch` input, and the workflow passes it to the Action. The run time, the time zone, and "Existing code" (comment it gradually, or only new and changed code) are set on the same page. Nothing else is configurable. A change of level reaches existing files through the batches, so with "Existing code" set to only new and changed code, files keep their earlier level until they change.

| Level | Behavior |
|---|---|
| `low` | Sparse, single-line comments of a few words. |
| `medium` | Single-line comments that can be longer, placed less sparsely. |
| `heavy` | A block comment (JSDoc `/** */` in JavaScript and TypeScript) above every function, class, and component, a short single-line comment on each constant and magic number, plus single-line comments on non-obvious logic such as calculations, loops, and edge cases. |
| `off` | No comments. Documentation only. |

Only single-line comments are limited by the level's density limit and the minimum gap between comments. At `heavy`, a block comment above a function, class, or component never counts toward either limit and is never dropped by them, and neither does an existing comment there. A comment on a top-level constant may sit on the line next to another one. After the model's first answer, the Action finds the functions, classes, and components that still have no comment directly above them (with the TypeScript parser for JavaScript and TypeScript, `ast` for Python, and the declaration patterns for other languages) and sends one follow-up request asking for a block comment for each, by name and line.

Comments explain intent and non-obvious behavior: why, constraints, units, and edge cases. They never narrate what the syntax already says. Docturnal never adds a comment where one already exists.

### Docturnal's own comments

Docturnal may replace or remove comments it wrote itself, and never anyone else's. The code is in `src/owned.js`.

- `.docturnal/state.json` records each comment Docturnal inserts: the file, the exact text, and a hash of the code line under it.
- On a later run, a comment run whose text still matches a record exactly is Docturnal's. Before the model sees the file, these comments are taken out. Each one then competes with the new proposals for its line. It is kept when it is still accurate and fits the level, and an earlier comment wins over a new one on the same line. It is restyled when the level changed (for example, a `//` line above a function becomes a block at `heavy`). It is replaced or removed when the accuracy check marks it inaccurate, and removed at `off`.
- A comment a person edited no longer matches its record, so it is theirs and is never touched. When the same text appears more than once, the record's hash picks the comment.
- Comments Docturnal inserted before records existed have none, so they count as a person's.

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
- **No invented links** (`src/links.js`). In generated layer docs, README sections Docturnal writes, file and layer summaries, and code comments, a web link is kept only when the same URL already appears in the repository: its tracked text files, the existing README, or `package.json`'s `homepage`, `repository`, and `bugs`. Any other link becomes plain text, a bare URL is removed, a code line or code span with such a URL is dropped, a comment with one is rejected ("link not found in the repository"), images from outside URLs and raw HTML (HTML comments included) are removed, and Docturnal adds its own markers after this. The log gives the count of what was dropped, never the URLs.

## Model rules

- Docturnal only ever uses Ollama on GitHub's standard hosted runner. Do not add support for paid or larger runners, self-hosted runners, outside model servers, or AI APIs, and do not add options for them.
- Two roles:
  - **Comment model:** a small, fast code model, because it handles many calls.
  - **Docs model:** the largest model that fits the runner's available memory, because it handles few calls.
- Model choice is automatic. The Action detects the available memory at run time and picks from a ranked candidate list in `src/`. Users never configure models. Every model it can pick has a pinned digest (see "Supply chain").
- Ollama listens only on `127.0.0.1`. Use a fixed seed and low temperature for repeatable output.
- Every call goes through `src/ollama.js`, which uses `node:http` with `stream: true`, not `fetch`. A large model on a CPU runner can take minutes to load and answer, so the client has no timeout of its own: the run's time budget is the only limit on a call. Every call uses the same `num_ctx`, so Ollama never reloads a model to change it.
- Each call is logged with what it was for, the model, and its duration, and a failure also with its error and cause. Prompts, code, and replies are never logged.
- Treat every model response as untrusted input. Parse it strictly, validate it, and drop anything invalid. A bad response skips that unit of work. It never fails the whole run or produces a broken file.

## Safety rules

- **The model never rewrites source files.** It proposes `{line, text}` comment pairs. Our code inserts them and then verifies the result.
- Insertion rules:
  - The model proposes `{line, anchor, text, kind}`, where `anchor` is the exact trimmed text of the line the comment belongs above. The comment goes above the line whose trimmed text matches the anchor, the given line first and then the nearest within 5 lines, looking below first. With no match, it is dropped and counted as "anchor not found". Out-of-range, duplicate, or ill-formed proposals are dropped.
  - Insert whole new lines only. Never edit, move, or delete an existing line, except to take out a comment Docturnal recorded as its own.
  - Line comments longer than 100 characters wrap onto more comment lines with the same indentation. Wrapped lines are balanced, so the last one is never left with a single short word.
  - Match the indentation of the target line, and use the file's comment syntax and line endings.
  - Reject text that could end a comment early or inject code, such as `*/` or newlines in single-line comments.
- Verification, required before a file is written:
  - With Docturnal's recorded comments taken out, the file is byte-for-byte identical to the original with only those lines removed, and with the inserted lines removed, the result is byte-for-byte identical to that.
  - For JavaScript and TypeScript, parse the result with the `typescript` package and confirm it introduces no new syntax errors and the same tokens apart from comments.
  - If verification fails, discard all changes to that file.
- Skip every path that `.docturnalignore` at the repository root matches. It uses `.gitignore` patterns, which git itself evaluates (`git ls-files --ignored --exclude-from`), and both the pre-check and the main run read it. A matched file is never commented and is left out of the documentation, and a change to the file counts as a change: its hash is in `.docturnal/state.json`.
- Skip JavaScript, TypeScript, and Python files that do not parse before Docturnal touches them, and list them in `last-run.md` ("skipped, the file has syntax errors"). Skip files that are generated, vendored, binary, minified, very large, or covered by `.gitignore`, as well as anything under `.github/`, `.docturnal/`, and `docs/`, unless they are Docturnal-owned generated docs.
- **Code never goes to an outside service.** The Action makes network calls only to download the pinned Ollama release from GitHub, pull the pinned models, install its one npm dependency, and push to GitHub. The app backend never reads source code. It only makes GitHub API calls. It may read `.docturnal/last-run.md`, which the Action generates.
- App permissions are the minimum needed, and no more:
  - Contents: write
  - Workflows: write
  - Pull requests: write
  - Actions: write
  - Metadata: read
- Webhooks: verify every signature. Keep secrets, such as the app private key and webhook secret, only in Worker secrets, never in the repo. Do not log payload contents beyond what you need for debugging. A payload over 25 MB, the most GitHub sends, is refused with 413 before it is read.
- The Action only pushes to `docturnal/update`. It never pushes to the default branch or any other branch.
- **The Action runs only on the default branch** (from the event's `repository.default_branch`). A run started on another branch stops with "Docturnal runs only on the default branch", so no one can offer a branch's changes under Docturnal's name.
- **Docturnal builds only on its own commits.** When `docturnal/update` has a commit, beyond the base, whose author or committer is not Docturnal's bot, the run does not add to it ("has commits from someone other than Docturnal"); it waits until that pull request is merged or closed.
- **No symbolic links** (`src/safe-path.js`). Docturnal never reads or writes through a link at `README.md`, `docs/`, `.docturnal/`, or the project files it reads for facts, or a folder above them. A linked `.docturnal/` stops the run with a clear message; a linked README is left alone; a linked doc counts as a person's; a linked `package.json` is not read. Source files that are links, and submodules, are never processed.
- **The pull request body cannot be steered by repository content.** File names go in code spans longer than any run of backticks in them, with control characters replaced; README headings and layer names have Markdown, mentions, and autolinks escaped.
- **Comment text** is rejected when it has invisible or text-direction Unicode characters, and, in C and C++, the trigraph `??/`.
- **Layer slugs and doc names** read from `.docturnal/state.json` must be plain slugs; anything that could be a path is dropped.
- The Run step gets no token of its own: the push uses the credentials `actions/checkout` set up. The Action makes no GitHub API calls. Its one dependency is installed with `npm ci --ignore-scripts`, from `package-lock.json`.

## Supply chain

Everything that runs in users' repositories is pinned, so a change upstream never reaches them without a commit here.

- **Ollama.** `action.yml` pins one version (`OLLAMA_VERSION`). `pins/ollama.json` holds, for that version and each architecture (linux amd64 and arm64), the release archive's SHA-256 and the SHA-256 of every file the install uses (the binary and the CPU libraries) and every link's target. `src/install-ollama.js` downloads the official archive from GitHub releases, checks its SHA-256 before extracting anything, extracts only the binary and the CPU libraries into the runner's temporary folder (no install script, no system service, no sudo), and checks every file. A mismatch fails the run with a clear message. A cached install is used only when every file matches, so an extra or changed library is never loaded.
- **Models.** `pins/models.json` holds each model's digest: the SHA-256 of its manifest on registry.ollama.ai, the ID ollama.com shows. After the pull, `src/verify-models.js` checks the digest `/api/tags` reports and, on the runner, that the manifest on disk hashes to the pin and every file it names hashes to its own digest. A mismatch fails the run with a clear message. A model without a pin is never run.
- **Upgrading** is deliberate: `scripts/update-ollama.sh <version>` downloads both archives, requires Ollama's `sha256sum.txt`, GitHub's asset digest, and its own SHA-256 to agree, records every file's hash (`scripts/archive-hashes.js`), and refreshes the model digests. Then set `OLLAMA_VERSION` in `action.yml` and commit.
- **Actions.** Every third-party action in `action.yml` and the workflow template is pinned to a full commit SHA, with its version in a comment. Raise `WORKFLOW_VERSION` when the template's pins change.

## Settings access

Settings apply to every repository in an installation, so only someone who manages it may change them. The check needs no app permission beyond the minimum.

- **A personal account:** the signed-in user's login must equal the account's login (`GET /user`).
- **An organization:** the user must have admin permission on every repository in the installation. `GET /user/installations/{id}/repositories` returns the user's permission on each repository they can see; the installation's total, asked as the app (`GET /installation/repositories` with an installation token), shows whether that is all of them. Checking organization ownership directly would need the "Members" permission, which the app does not have. An installation with more than 3,000 repositories is refused, since the check reads at most 30 pages.
- The page names who can change the settings when it refuses. The checks after an install or an update still retry while GitHub catches up.

## Settings page headers

Every response from the Worker has `X-Content-Type-Options: nosniff` and `Strict-Transport-Security`. Every page has a `Content-Security-Policy` with a new nonce for each response: `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'`. The page's one inline style and one inline script carry the nonce, and the page has no inline event handlers or style attributes. The time-zone auto-save is a same-origin `fetch`, which `connect-src 'self'` allows.

## Nightly behavior

- `.docturnal/state.json` records each file's hash (taken after comments), summary, symbols, the comment level it was commented at (null for a summary only), why it was skipped if it was, and Docturnal's comments (see "Docturnal's own comments"), plus the layers, the generated doc slugs, whether the documentation is complete, how many batches of existing code were made, and what the open pull request holds (`pending`: the docs, the changed files, and its one batch). Deleted files are removed from the state. In a state from before this, every summarized file counts as commented at the level then, and the documentation counts as complete only when every code file has an entry: a first run that was cut short finishes its documentation pass for the files it missed, rather than commenting them all at once.
- **The first run documents the project.** Until the documentation is complete, each run reads every file without a summary for its current content and writes the layer docs and the README with the docs model. It adds no comments. Its pull request is titled "Docturnal: documentation" and says comments follow in small batches.
- **One model call per folder, not per file** (`src/structure.js`, `src/folders.js`). Each file's structure comes from the parsers: its exports, functions, classes, imports, and leading comment (TypeScript's parser for JavaScript and TypeScript, declaration patterns for other languages). One call to the comment model gets a compact digest of a folder (file names, exports, imports between its files, each file's leading comment or first line of code), at most 40 files and within the context, and returns a short summary of the folder and a one-line purpose for each file. A larger folder is split into parts. A file the answer leaves out gets a description built from its structure; a folder whose answer is unusable has its files recorded as `summaryFailed`. Folder summaries are kept in `.docturnal/state.json` (`folders`).
- **Layers and docs fit the context at any size.** When the files of a project do not fit one layer-planning prompt, the layers are planned from the folder summaries, and each layer names folders. A layer doc's prompt lists each file with its summary, or its summary alone, or, when that is too long, the layer's folders and their summaries. The README prompt lists each layer's folders instead of its files when needed.
- **The docs are always written.** In the documentation pass, folder summaries stop starting 40 minutes before the end of `time-budget-minutes` (but not before a third of it), so the layers, the layer docs, and the README are written in the same run. Layer docs stop starting 8 minutes before the end, so the README is always written. Folders not reached are listed in the README's layers block ("Not described yet: …"), and are read on the next run.
- **Benchmark.** A run with a documentation pass logs one line: source files, folders, model calls (and how many were for summaries), and minutes for summaries, layers, layer docs, the README, and the whole run. Counts and times only.
- **New and changed code first.** After that, files that are new or whose hash differs from the state are commented, checked, and re-summarized every run, and their layer docs updated. They always come before the backlog.
- **Existing code in batches.** Files that are up to date but not commented at the current level form the backlog; a change of level puts every file back in it, and at `off`, the files with Docturnal's comments, to remove them. With "Existing code" set to `gradual`, after the changed files and if time remains, a run adds one batch of at most `backlog-batch-size` files (15). Never more than one open Docturnal pull request: while the open one holds a batch (the update branch has commits the base does not), no other batch is added, though changed files still are. A batch is ordered by importance (`src/importance.js`): entry points (`package.json` main, bin, and exports, index files, route and handler files), fan-in from the import graph (TypeScript's import scanner for JavaScript and TypeScript, simple patterns for other languages), complexity, and commits in the last 90 days. It is kept within the layer of its most important file, filled from the next layers only when that one is smaller than a batch. With `none`, there are no batches.
- **The push.** The run replaces `docturnal/update` with `--force-with-lease` against the commit it started from (or "must not exist" when there was none). If a person added a commit to it during the run, or the app deleted it because its pull request was closed without merging, the push is refused and the run's work waits for the next run. The app keeps the branch of a merged pull request while a run is going, and deletes a declined one's at once.
- **An open pull request.** `docturnal/update` holds an open pull request when it has commits the base lacks and merging the base into it leaves changes; after a squash or rebase merge it leaves none.
- **Files the model can't summarize.** An unusable summary (with a fixed seed, it would be the same every night) is recorded as `summaryFailed`, so the documentation pass can end; the file is still commented in a batch. The pass is done when the state says so, or when every code file has an entry.
- **A batch that changed no file** doesn't hold the next batch back.
- **Never lose work to the timeout.** A run stops starting work when its time budget is nearly used, and commits what is finished. `job-timeout-minutes` lets the Action warn when the budget leaves less than 20 minutes before the job's timeout.
- If `origin/docturnal/update` exists, the run checks it out and merges the base branch into it, so an open pull request keeps its changes. If the merge conflicts, the run starts fresh from the base. The result is force-pushed.
- Each run comments every file first with the comment model, then writes all docs with the docs model, so the model is swapped only once. New files stop starting at `time-budget-minutes` minus 25 minutes; files not reached wait for the next run.
- Between the two, an accuracy check lists each selected comment, earlier and new, with only the 1 to 5 code lines under it, at most 8 comments per request with a short answer limit, and asks three yes or no questions: whether it accurately describes that code, whether it adds information a competent reader could not get from the code (intent, a reason, a unit, a constraint, or an edge case), and whether it only repeats the comment of the function it is in, which the item shows. Comments marked inaccurate are dropped and counted as "inaccurate". A new line comment that only restates the code or repeats its function's comment is dropped and counted as "restates the code"; comments already in the file, Docturnal's or a person's, and block comments are never dropped for this, so nothing churns and every function at `heavy` keeps its block comment. After the model's answers, a word match in `src/restates.js` catches restatements it let through: it drops a new line comment as "restates the code" when at least 0.6 of its content words (stopwords removed, identifiers split, lightly stemmed) appear in the 1 to 5 code lines under it, counting words the syntax implies (`return` says "returns", `+=` says "adds", `Math.min` says "up to", and so on). A comment that gives a reason ("because", "to avoid", "must", and the like), names an edge case (zero, negative, empty, null, overflow), or names a unit the code does not is kept. It never applies to block comments, comments on constants or declarations, or comments already in the file. The log gives the score of each comment it drops, never the text. The check uses the docs model when the time left before `time-budget-minutes` minus 15 minutes is at least the time the comment model took (the docs model loads next anyway), and otherwise the comment model. The docs model is loaded first, with `keep_alive`, so the check does not start against a cold model; if it cannot load, the comment model is used for the rest of the run. A check that fails with the docs model is tried once more with the comment model. A file whose check still fails, or is not reached in time, is left unchanged for the next run, and the log says "<file>: deferred to the next run, <reason>". A run that defers files and has nothing else to commit says so, rather than "No changes since the last run".
- Layers are re-planned only when the set of summarized files changes. If the docs model cannot load (out of memory or a load error), the doc is written with the comment model and marked "written with the fallback model" in `last-run.md`.
- A night with no changes makes no model calls, no commit, and no push, and leaves the state timestamp alone. A pre-check step (`src/precheck.js`, Node built-ins only) runs first: it sets up the branch, loads the state, and hashes the in-scope files with the same code as `main.js`. It outputs `changed=true` when it is the first run or the documentation is not complete, a file is new, changed, or deleted, existing code waits for a batch and no batch is open, a generated doc is missing, a person edited `README.md` (so their section gets polished), or a `docs/README.md` with the marker is left to remove. Otherwise it logs "No changes since the last run", and every later step, including model selection and the Ollama install, is skipped.
- Write `.docturnal/last-run.md` as the pull request's title (its first heading) and body. It opens with a progress section: the documentation's status, "Comments: X of Y files", what the pull request holds (the documentation, changed files, batch N and its layers), and what comes next. Below that, it lists comments added per file and whether a parser checked each file, a count per file of comments proposed, dropped by placement rules, anchor not found, dropped by the length limit or the density limit, inaccurate, restates the code, rejected by the safety check, and added, and of Docturnal's earlier comments kept, restyled, and removed (never comment text or code), files skipped and why, docs updated or removed, the README sections updated, polished, kept in your wording, and not re-added because you removed them (by heading only), comments rejected by the safety check, files left for the next run, and the models used. It follows the same writing style as the docs.

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
| PR titles | `Docturnal: documentation`, `Docturnal: comments and documentation` |
| Ignore file | `.docturnalignore` at the repository root |
| Pins | `pins/ollama.json`, `pins/models.json` |
| Doc marker (layer docs) | `<!-- Generated by Docturnal. Edits to this file are replaced the next time its layer changes. -->` |

Do not rename these. Other parts and users' repos depend on them.

## Folder layout

```
action.yml          Composite action definition (repo root), which pins the Ollama version
pins/               Checksums of the pinned Ollama release and digests of the pinned models
scripts/            update-ollama.sh and archive-hashes.js, for upgrading the pins
package.json        Runtime dependency: typescript only
src/                Action code (Node 20+, plain CommonJS, no build step)
app/                GitHub App backend (Cloudflare Worker)
test/               Tests for the Action and app, including the mock Ollama server
README.md           Project README
LICENSE             All rights reserved; source published for verification only
.docturnalignore    Paths Docturnal skips in its own repository (test fixtures)
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
