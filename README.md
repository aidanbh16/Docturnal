<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->

# Docturnal

Your codebase, documented overnight.

## What it does

Docturnal is a GitHub App that adds comments to your code and keeps your documentation up to date. Every night, it reads the files that changed, adds comments that explain why the code does what it does, updates your `README.md` and the documents in `docs/`, and opens a pull request for you to review.

The models that write the comments and documents run on GitHub's own runner, inside your repository's workflow. Your code is not sent to any outside service. Nothing reaches your code until you merge the pull request.

## Architecture

The layers below work together to ensure that Docturnal functions correctly:

<!-- docturnal:layers -->
| Layer | Description |
| --- | --- |
| [GitHub Integration](docs/github-integration.md) | Handles GitHub API version, requests, tasks, sessions, and workflows for GitHub installations. |
| [Ollama Management](docs/ollama-management.md) | Manages Ollama releases and models, including hashing, updating model pinning, and computing checksums. |
| [Model Verification](docs/model-verification.md) | Verifies models and their configurations. |
| [Python Helper](docs/python-helper.md) | Provides utilities and scripts for Python-related tasks. |
| [Configuration and State Management](docs/configuration-and-state-management.md) | Manages application configuration and state, including links, reports, and safe paths. |
| [Documentation and Grounding](docs/documentation-and-grounding.md) | Handles documentation and grounding related tasks. |
| [Tests](docs/tests.md) | This folder contains test files that define and verify various aspects of the project, including action steps, anchors, big layers, check runs, comments, configuration, coverage, documentation, end-to-end tests, edges, excalidraw-like project, first run, Git repository, heavy level, and test helpers. |
<!-- /docturnal:layers -->

## Install

Select **Install** on the [Docturnal GitHub App page](https://github.com/apps/docturnal-app) and choose your repositories. That is the only step.

For each repository, the app adds `.github/workflows/docturnal.yml` to the default branch and starts the first run. If branch protection stops the app from committing to the default branch, it opens a pull request titled "Set up Docturnal" with the workflow file instead. The first run starts when you merge it.

### Available scripts

<!-- docturnal:scripts -->
| Command | Runs |
| --- | --- |
| `npm run test` | `node --test` |
<!-- /docturnal:scripts -->

## Settings

After you install the app, GitHub takes you to Docturnal's settings page. You sign in with GitHub, and the page checks that you manage the installation: on a personal account, that it is your account; in an organization, that you have admin access to every repository Docturnal is installed on, as an owner does. The settings apply to all of those repositories, so collaborators with less access can't change them. Each Docturnal pull request also ends with a **Change Docturnal settings** link to the same page.

You can choose:

- **Time:** the hour when Docturnal runs each day.
- **Time zone:** the time zone of that hour. Daylight saving time is handled for you.
- **Comment level:** low, medium, heavy, or off. See [Comment levels](#comment-levels).
- **Existing code:** **Comment gradually**, the default, comments the code you already have in small batches, the most important files first. **Only new and changed code** leaves existing code alone and comments only what you add or change.
- **Time limit for private repositories:** 15, 30, 60, or 90 minutes a night. Each run in a private repository counts toward your free GitHub Actions minutes, so Docturnal stops after this long and continues the next night. Public repositories always get 90 minutes.

The defaults are midnight, New York time, medium comments, existing code commented gradually, and 30 minutes a night in private repositories. While the settings are still the defaults, opening the page saves your browser's time zone, so midnight is in your time zone even if you close the page without saving. The settings apply to every repository in the installation.

## What you get

- **First, documentation for the whole project.** The first pull request, titled "Docturnal: documentation", contains your `README.md` and a document for each part of your code, and no code comments.
- **Then comments, in pull requests you can review in minutes.** Each night, new and changed code is commented first. Then, if the setting allows, one batch of existing code, at most 15 files, the most important first and kept to one part of the project where it can be. A pull request holds at most one such batch: the next batch waits until you merge or close it.
- **Progress in every pull request.** Each one opens with how far the documentation and the comments are, such as "Comments: 45 of 300 files", what the pull request holds, what comes next, and the night's time limit.

There is never more than one open Docturnal pull request. It comes from the `docturnal/update` branch, and later nights add their changes to it until you merge or close it, so you review one pull request rather than one per night. Its title says what it holds: "Docturnal: documentation", or "Docturnal: comments and documentation" once it has comments. Its description lists the comments added to each file, the documents updated, the README sections changed, the files that were skipped or left for the next night, and the models used. It never includes the comment text or your code.

After the pull request closes, merged or not, Docturnal deletes its branch. If a Docturnal run is still going at that moment, the branch stays until a later Docturnal pull request closes. The next night that finds changes starts a new pull request. Docturnal deletes its other branches, `docturnal/setup` and `docturnal/workflow-update`, the same way when their pull requests close.

When Docturnal's workflow file changes, the app opens a pull request titled "Update Docturnal workflow" with the new version. If you close that pull request, Docturnal keeps running with the workflow you have, and offers the update once more 14 days later, with a note on why it matters. If you close it a second time, Docturnal doesn't offer that version again, but always offers a newer one. You can open the update any time with the "Update the Docturnal workflow" button on the settings page, which appears while a repository uses an older workflow. Until you update, each Docturnal pull request says which version the repository uses.

## Comment levels

| Level | What Docturnal aims for |
| --- | --- |
| `low` | A few short, single-line comments on the most important functions and classes: the ones exported or used by other files. |
| `medium` | Single-line comments that can be longer, on exported and widely used functions, classes, components, and types, and on the most complex blocks of code. This is the default. |
| `heavy` | A block comment above every function, method, class, and component, a short comment on each constant, and single-line comments on complex blocks of code. |
| `off` | No comments. Docturnal only updates your documentation. |

Docturnal decides where comments go before it asks the model anything. It reads your code with a parser and lists the functions, classes, and exported declarations that have no comment yet, and the complex blocks: code nested three levels deep, regular expressions, bitwise math, numbers other than 0, 1, and -1, and long conditions. Exported and widely used code comes first. The model then writes one short comment for each spot, seeing only that code. Each night, a file gets at most 3 new comments at `low`, 8 at `medium`, and 20 at `heavy`, its most important spots first, and the rest follow in a later batch. Every file in the night's work gets its most important spots before any file gets more, so a large file never takes the whole night. Each level limits how many single-line comments a file gets, and comments already in the file count toward the limit. Block comments above functions at `heavy` do not count toward it. After you change the level, files you change are commented at the new level, and existing files follow in the same small batches as existing code.

## How comments are checked

The model never edits your files. It only writes the text of comments for the spots Docturnal chose, and Docturnal decides which ones to insert and checks every file before writing it:

- **New lines only.** A comment is inserted as a whole new line above the code it describes. Docturnal never changes, moves, or deletes a line of your code, and never adds a comment where one already exists.
- **Placed by Docturnal.** The model never says where a comment goes. Each comment goes directly above the line Docturnal chose for it, so no comment ends up above the wrong code.
- **Checked for accuracy and usefulness.** A second request asks whether each comment is true of the code under it, and whether it tells you something the code does not already say. Comments that are wrong are dropped, and so are new single-line comments that only restate the code or repeat the comment of the function around them. A word-by-word comparison with the code catches restatements the model misses.
- **Verified by a parser.** For JavaScript, TypeScript, and Python, Docturnal parses the file after inserting comments and confirms that the program is unchanged apart from the comments. A comment that fails this check is dropped. For every language, removing the inserted lines must give back the original file byte for byte. Other languages are checked with placement rules, so a comment never lands inside a string or a block comment.
- **Files with syntax errors are skipped.** A JavaScript, TypeScript, or Python file that does not parse is not commented, and the pull request says so.
- **Only its own comments.** Docturnal records each comment it inserts. On a later run, it may replace or remove a comment it wrote, for example one that turns out to be wrong, which it replaces in the same run, or a single-line comment above a function that becomes a block comment at `heavy`. It removes all of its comments at `off`. It never changes or removes a comment you wrote. If you edit one of Docturnal's comments, it becomes yours.

## What Docturnal writes

| Path | What it is |
| --- | --- |
| `README.md` | The main document: an overview of your code, with links to every layer document. See [README rules](#readme-rules). |
| `docs/<layer>.md` | One document for each part of your code, such as the API or the database layer. Docturnal decides the layers and keeps them stable between runs. |
| `docs/<part>/<sub>.md` | In a large project, the documents of one part, such as one package's components or its tests, and below them `docs/<part>/<sub>/<sub>.md`. See [Large projects](#large-projects). |
| `.docturnal/state.json` | What the last run saw: file hashes, summaries, the layers, and the comments Docturnal inserted. |
| `.docturnal/readme.json` | The README as Docturnal last wrote it, with who owns each section. |
| `.docturnal/last-run.md` | The pull request description. |
| `.github/workflows/docturnal.yml` | The workflow that the app starts each night. |

Each layer document starts with a hidden marker. Docturnal rewrites a layer document only when files in that layer change, and never overwrites a file in `docs/` that does not have the marker.

The layers follow your folders, and a large folder is split into a few layers by what its files do. The model groups the files by their purposes and names each group, and every group is checked against its files. When the grouping fails the checks twice, the files are grouped by which of them import each other. Each layer document describes only what its files' summaries and definitions say: a sentence they don't support is left out, and nothing is said twice. Tables in the documents are computed from your code, such as the table of files in each layer, and the Configuration section lists only the environment variables, inputs, and configuration files the code itself reads.

### Large projects

A project with two or more workspace packages, or 100 source files or more, is documented in parts. Each package (a folder with its own `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or similar, or one your workspace settings name) is a part, and so is each other top-level folder, such as an app, examples, a docs site, or scripts. A document never holds files from two parts, and a part's tests have a document of their own.

Each part has a document at `docs/<part>.md`, named after its package or folder. Any document with more than about 40 source files also has a document for each of its subfolders, such as `docs/<part>/<sub>.md`, down to three levels, and one that is still too big is divided within its own folder. The README's Architecture section lists at most 12 parts, with links to their documents, and each document lists its own. With more than 12, the folder that holds the most parts, such as `packages/`, becomes one part: its description lists the packages it holds, and each package gets its own documents below it, such as `docs/packages/excalidraw.md` and `docs/packages/excalidraw/components.md`. The first run writes every part's document first, then the larger documents, then the tests; documents that don't fit in the time are written on the next run, and the pull request says how many.

## README rules

`README.md` is shared between you and Docturnal. Its first line is a hidden comment that says so.

- **Your text is kept exactly.** A section you add or edit is yours, and Docturnal never rewrites it, on the first run or after.
- **Your deletions are never re-added.** If you delete a section, Docturnal does not write it again.
- **Adding a section back makes it yours.** Docturnal keeps your version and no longer treats the section as deleted.
- **Docturnal's own sections**, such as the overview and the architecture, are rewritten when your code changes, unless you edited them.
- **Tables Docturnal computes**, such as the table of layer documents, the available scripts, and the directory tree, sit between hidden markers and stay current wherever they are. If you delete one, it stays deleted until you put its markers back.
- **Deleting the whole README** counts as deleting every section, so Docturnal does not create it again.

On the first run in a repository that already has a README, every existing section stays yours, and Docturnal adds only the sections and tables that are missing. A run with nothing to update leaves `README.md` exactly as it is.

## Excluding files

To keep Docturnal away from some paths, add a `.docturnalignore` file to the root of your repository. It uses the same patterns as `.gitignore`:

```text
# Generated code
src/generated/
*.pb.go

# Test fixtures that tests compare byte for byte
test/fixtures/
```

Docturnal never comments a matching file and leaves it out of the documentation. A change to `.docturnalignore` counts as a change, so the next run picks it up.

Docturnal also skips files that are generated, vendored, binary, minified, or very large, and anything in `.github/`, `.docturnal/`, and `docs/`, apart from its own layer documents.

## How your code is protected

- **The app never reads your code.** The app only makes GitHub API calls: it commits the workflow file, starts runs, opens pull requests, and deletes its branches. It reads only two files: its own workflow file, to check its version, and `.docturnal/last-run.md`, which Docturnal writes and which never contains code.
- **The models run on GitHub's runner.** The workflow installs Ollama on the runner, downloads the models, and runs them there, listening only on the runner itself. Your code goes to these local models and nowhere else.
- **What runs is pinned.** Docturnal installs one fixed Ollama release from Ollama's official GitHub releases and checks every file against checksums stored in this repository, with no install script and no administrator rights. It checks every file of each model against fixed digests too, and the actions it uses are pinned to exact commits. If anything doesn't match, the run stops and changes nothing.
- **Generated text adds no outside links.** Docs and comments link to a web address only when your repository already has it, and never add images from other sites or HTML.
- **Nothing goes to an outside AI service.** Docturnal uses no AI APIs and no telemetry. The run's network traffic is the checkout of your repository, the downloads of Ollama from GitHub, the models, and the Action's one dependency, and the push of the `docturnal/update` branch back to your repository.
- **The app stores only your settings.** It keeps the run time, time zone, comment level, the Existing code choice, the time limit for private repositories, and the names of the repositories it is installed on. It stores no code.
- **Minimum permissions.** The app asks for write access to contents, workflows, pull requests, and actions, and read access to metadata.

## How nightly runs work

- **Documentation first.** The first run reads every file and writes the documentation, with one short request for each folder. For a project of up to about 1,000 source files, the documentation arrives in the first pull request. It adds no comments.
- **New and changed code next.** Each later run compares your files with the hashes from the last run, and comments the new and changed ones before anything else. Comments come before docs: the run keeps only the time it needs for the docs that your changes touch, and docs it doesn't reach are updated the next night. A night comments about 40 changed files of 200 lines each, up to 8 comments each at `medium`.
- **Existing code in batches.** After that, if time remains and no batch is waiting in an open pull request, the run comments one batch of existing files. It ranks them by importance: entry points, such as the files `package.json` names and route or handler files, then files many others import, complex files, and files that changed recently.
- **Quiet nights stop early.** A short check runs first. If nothing changed and no batch is due, the run stops there, before Ollama or any model is installed, which usually takes under a minute.
- **One run at a time.** A run that starts while another is going waits for it, and the nightly run is skipped if a Docturnal run is already queued or in progress.
- **Only Docturnal's own work.** Docturnal runs only on your default branch. If someone adds a commit to the open Docturnal pull request, Docturnal stops adding to it until you merge or close it, so the pull request never mixes its changes with someone else's.
- **Work is never lost to a timeout.** Each run stops starting new work when its time budget is close to running out, and commits what is finished. The budget is 90 minutes in a public repository, and the time limit from the settings, 30 minutes by default, in a private one. The job's timeout leaves at least 20 minutes after that budget. Files that are left over are listed in the pull request and go first on the next night; a file cut short keeps the comments it got, and a later batch adds the rest.

## Supported languages

Docturnal comments JavaScript, TypeScript (including JSX and TSX), Python, C, C++, C#, Java, Go, Rust, Swift, Kotlin, Scala, Dart, PHP, Ruby, Shell, R, Perl, PowerShell, SQL, Lua, Haskell, CSS, SCSS, and Less.

A parser verifies the result for JavaScript, TypeScript, and Python. The other languages are checked with placement rules only.

## Limitations

- **Small models on CPUs.** GitHub's standard runners have no GPU, so Docturnal uses small code models: `qwen2.5-coder:3b` for comments and `qwen2.5-coder:7b` for documents. On runners with less memory, such as the ones for private repositories, the documents may be written with the smaller model, and the pull request says so. The comments and documents are good drafts, not expert review.
- **Speed.** Models on a CPU are slow. In a very large repository, the first run writes the documentation for the folders it reached, lists the others in the README, and adds them the next night. Commenting all the existing code takes many nights, one batch each.
- **GitHub Actions minutes.** Runs in public repositories are free. Runs in private repositories use your account's included GitHub Actions minutes. A night with nothing to do stops before Ollama is installed, which usually takes under a minute.

## Uninstalling

When you uninstall the app, it deletes your stored settings. GitHub then gives it no access to your repositories, so it cannot clean up after itself. To remove Docturnal completely, delete these yourself:

- `.github/workflows/docturnal.yml`. Only the app starts it, so it no longer runs on its own.
- The `.docturnal/` folder.
- Any `docturnal/` branches, such as `docturnal/update`, and any open Docturnal pull requests.

Comments and documents that you merged stay in your code.

## Project layout

This repository has three parts:

| Path | Contents |
| --- | --- |
| `action.yml`, `src/` | The GitHub Action that runs on the runner, in plain Node.js. |
| `app/` | The GitHub App backend, a Cloudflare Worker. See [`app/README.md`](app/README.md) and [`app/DEPLOY.md`](app/DEPLOY.md). |
| `test/` | Tests for the Action, including a mock Ollama server. |

To work on it, you need Node.js 20 or later:

- Install the dependencies with `npm install`.
- Run the Action tests with `npm test`.
- Run the end-to-end runs against a local git remote with `bash test/e2e.sh`.
- Run the app tests with `npm test` in the `app` folder.

<!-- docturnal:tree -->
```text
.
├── app/
│   ├── scripts/
│   ├── src/
│   └── tests/
├── pins/
├── scripts/
├── src/
├── test/
├── .docturnalignore
├── .gitignore
├── CLAUDE.md
├── LICENSE
├── README.md
├── action.yml
├── package-lock.json
└── package.json
```
<!-- /docturnal:tree -->

## License

Copyright (c) 2026 Aidan Holton. All rights reserved.

The source code is published so you can verify what Docturnal does with your code. It is not open source: you may use Docturnal only by installing the official [Docturnal app](https://github.com/apps/docturnal-app), or under a separate written license from the author. See [LICENSE](LICENSE).
