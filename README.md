<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->

# Docturnal

Your codebase, documented quickly.

## What it does

Docturnal is a GitHub App that adds comments to your code and keeps your documentation up to date. Every night, it reads the files that changed, adds comments explaining why the code does what it does, updates your `README.md` and the documents in `docs/`, and opens a pull request for you to review.

The models that write the comments and documents run on GitHub's own runner, inside your repository's workflow. Your code is not sent to any outside service. Nothing reaches your code until you merge the pull request.

## Architecture

<!-- docturnal:layers -->
| Layer | Description |
| --- | --- |
| [User Interface](docs/user-interface.md) | Handles the app registration page and setup page. |
| [API Routes](docs/api-routes.md) | Manages webhook and queue requests for the app. |
| [Data Access](docs/data-access.md) | Manages per-installation settings in Cloudflare KV. |
| [Workflow Management](docs/workflow-management.md) | Manages the workflow file committed to each repository. |
| [GitHub Integration](docs/github-integration.md) | Manages the GitHub API version used by the app. |
| [Security](docs/security.md) | Manages signed, short-lived tokens for the setup page. |
| [Testing](docs/testing.md) | Contains tests for various components of the app. |
<!-- /docturnal:layers -->

## Install

To install the Docturnal GitHub App, go to the [Docturnal GitHub App page](https://github.com/apps/docturnal-app) and select **Install**. Choose the repositories you want to use with Docturnal.

For each repository, the app adds a `.github/workflows/docturnal.yml` file to the default branch and starts the first run. If branch protection rules prevent the app from committing to the default branch, it will open a pull request titled "Set up Docturnal" with the workflow file instead. The first run will start when you merge this pull request.

### Available scripts

<!-- docturnal:scripts -->
| Command | Runs |
| --- | --- |
| `npm run test` | `node --test` |
<!-- /docturnal:scripts -->

## Settings

After installing the app, GitHub takes you to Docturnal's settings page. You sign in with GitHub, and the page checks that you have the necessary permissions: on a personal account, it must be your account; in an organization, you need admin access to every repository where Docturnal is installed. These settings apply to all repositories, so collaborators with less access can't change them. Each Docturnal pull request includes a **Change Docturnal settings** link to the same page.

You can choose:

- **Time:** the hour when Docturnal runs each day.
- **Time zone:** the time zone for that hour. Daylight saving time is automatically handled.
- **Comment level:** low, medium, heavy, or off. See [Comment levels](#comment-levels).
- **Existing code:** **Comment gradually**, the default, comments existing code in small batches, starting with the most important files. **Only new and changed code** leaves existing code untouched and comments only what you add or change.

The defaults are midnight, New York time, medium comments, and existing code commented gradually. When the settings are still at their defaults, opening the page saves your browser's time zone, so midnight will be in your time zone even if you close the page without saving. These settings apply to every repository in the installation.

## What you get

- **First, documentation for the whole project.** The first pull request, titled "Docturnal: documentation," includes your `README.md` and a document for each part of your code, with no code comments.
- **Then comments, in pull requests you can review in minutes.** Each night, new and changed code is commented first. If the setting allows, one batch of existing code, up to 15 files, is reviewed, starting with the most important files and keeping them focused on one part of the project. Each pull request contains at most one such batch; the next batch waits until you merge or close it.
- **Progress in every pull request.** Each pull request shows how far the documentation and comments are, such as "Comments: 45 of 300 files," what the pull request includes, and what comes next.

There is always only one open Docturnal pull request, which comes from the `docturnal/update` branch. Each night, changes are added to this branch until you merge or close it, allowing you to review all changes in one pull request. The title of the pull request indicates what it contains: "Docturnal: documentation," or "Docturnal: comments and documentation" once comments are added. The description lists the comments added to each file, documents updated, changes made to the `README.md`, files skipped or left for the next night, and the models used. It never includes the comment text or your code.

After the pull request closes, whether merged or not, Docturnal deletes its branch. If a Docturnal run is still in progress at that moment, the branch stays until a later Docturnal pull request closes. The next night that finds changes starts a new pull request. Docturnal also deletes its other branches, `docturnal/setup` and `docturnal/workflow-update`, in the same way when their pull requests close.

When Docturnal's workflow file changes, the app opens a pull request titled "Update Docturnal workflow" with the new version. It proposes each version once. If you close that pull request, Docturnal continues running with the workflow you have.

## Comment levels

| Level | What Docturnal aims for |
| --- | --- |
| `low` | A few short, single-line comments on the most important or surprising code. |
| `medium` | Single-line comments that can be longer, placed less sparsely. This is the default. |
| `heavy` | Block comments above every function, class, and component, short comments on each constant, and single-line comments on calculations, loops, edge cases, and magic numbers. |
| `off` | No comments. Docturnal only updates your documentation. |

Each level limits the number of single-line comments a file can have, and existing comments count toward this limit. Block comments above functions at `heavy` do not count toward the limit. After changing the level, files you modify are commented at the new level, and existing files follow in small batches like existing code.

## How comments are checked

How comments are checked

Docturnal inserts comments as new lines above the code they describe. Here’s how it ensures comments are accurate and useful:

- **New lines only:** Comments are added as whole new lines above the code they describe. Docturnal never changes, moves, or deletes existing lines of code, and it never adds a comment where one already exists.
- **Placed by anchor:** Each comment is linked to the exact text of the line it should be above. Docturnal places the comment above the matching line, and it drops the comment if no nearby line matches.
- **Checked for accuracy and usefulness:** A second request verifies whether each comment is true for the code below it and whether it adds new information. Comments that are incorrect or redundant are dropped. A word-by-word comparison with the code catches restatements the model might miss.
- **Verified by a parser:** For JavaScript, TypeScript, and Python, Docturnal parses the file after inserting comments and confirms that the program remains unchanged except for the comments. A comment that fails this check is dropped. For every language, removing the inserted lines must return the original file exactly. Other languages are checked with placement rules, ensuring comments don’t land inside strings or block comments.
- **Files with syntax errors are skipped:** JavaScript, TypeScript, or Python files that don’t parse correctly are not commented, and the pull request will indicate this.
- **Only its own comments:** Docturnal records each comment it inserts. On a later run, it may replace or remove a comment it wrote, such as one that turns out to be wrong or a single-line comment above a function that becomes a block comment at `heavy`. It removes all of its comments at `off`. It never changes or removes a comment you wrote. If you edit one of Docturnal’s comments, it becomes yours.

## What Docturnal writes

| Path | What it is |
| --- | --- |
| `README.md` | The main document: an overview of your code, with links to every layer document. See [README rules](#readme-rules). |
| `docs/<layer>.md` | One document for each part of your code, such as the API or the database layer. Docturnal decides the layers and keeps them stable between runs. |
| `.docturnal/state.json` | What the last run saw: file hashes, summaries, the layers, and the comments Docturnal inserted. |
| `.docturnal/readme.json` | The README as Docturnal last wrote it, with who owns each section. |
| `.docturnal/last-run.md` | The pull request description. |
| `.github/workflows/docturnal.yml` | The workflow that the app starts each night. |

Each layer document starts with a hidden marker. Docturnal rewrites a layer document only when files in that layer change, and never overwrites a file in `docs/` that does not have the marker.

## README rules

`README.md` is shared between you and Docturnal. Its first line is a hidden comment that says so.

- **Your additions are kept.** A section you add or edit is yours. Docturnal polishes it for clarity, keeping your heading, links, badges, code, and numbers. If a polish would change any of them, your wording stays.
- **Your deletions are never re-added.** If you delete a section, Docturnal does not write it again.
- **Adding a section back makes it yours.** Docturnal keeps your version and no longer treats the section as deleted.
- **Docturnal's own sections**, such as the overview and the architecture, are rewritten when your code changes, unless you edited them.
- **Tables Docturnal computes**, such as the table of layer documents, the available scripts, and the directory tree, sit between hidden markers and stay current wherever they are. If you delete one, it stays deleted until you put its markers back.
- **Deleting the whole README** counts as deleting every section, so Docturnal does not create it again.

On the first run in a repository that already has a README, every existing section stays yours, and Docturnal adds only the sections and tables that are missing. A run with nothing to update leaves `README.md` exactly as it is.

## Excluding files

To keep Docturnal from commenting on certain files, add a `.docturnalignore` file to your repository's root. This file uses the same patterns as `.gitignore`:

```text
# Generated code
src/generated/
*.pb.go

# Test fixtures that tests compare byte for byte
test/fixtures/
```

Docturnal ignores any file that matches these patterns and leaves them out of the documentation. Changes to `.docturnalignore` are considered changes, so the next run will pick them up.

Docturnal also skips files that are generated, vendored, binary, minified, or very large, and anything in `.github/`, `.docturnal/`, and `docs/`, except for its own layer documents.

## How your code is protected

- **The app never reads your code.** It only makes GitHub API calls to commit workflow files, start runs, open pull requests, and delete branches. It reads only two files: its own workflow file to check its version, and `.docturnal/last-run.md`, which Docturnal writes and does not contain any code.
- **The models run on GitHub's runner.** The workflow installs Ollama on the runner, downloads the models, and runs them there, listening only on the runner itself. Your code goes to these local models and nowhere else.
- **What runs is pinned.** Docturnal installs one fixed Ollama release from Ollama's official GitHub releases and checks every file against checksums stored in this repository. It also checks every file of each model against fixed digests and uses actions pinned to exact commits. If anything doesn't match, the run stops and makes no changes.
- **Generated text adds no outside links.** Docs and comments link to a web address only if your repository already has it, and they never include images from other sites or HTML.
- **Nothing goes to an outside AI service.** Docturnal uses no AI APIs and no telemetry. The run's network traffic includes the checkout of your repository, downloads of Ollama from GitHub, the models, and the Action's one dependency, as well as the push of the `docturnal/update` branch back to your repository.
- **The app stores only your settings.** It keeps the run time, time zone, comment level, the Existing code choice, and the names of the repositories it is installed on. It does not store any code.
- **Minimum permissions.** The app requests write access to contents, workflows, pull requests, and actions, and read access to metadata.

## How nightly runs work

- **Documentation first.** The first run reads every file and writes the documentation, requesting one short summary for each folder. For a project with up to about 1,000 source files, the documentation is ready in the first pull request. It doesn't add any comments.
- **New and changed code next.** Each subsequent run compares your files with the hashes from the last run and comments on new and changed files before anything else.
- **Existing code in batches.** After that, if time remains and no batch is waiting in an open pull request, the run comments on one batch of existing files. It ranks them by importance: entry points like `package.json`, route or handler files, files many others import, complex files, and files that changed recently.
- **Quiet nights stop early.** A short check runs first. If nothing changed and no batch is due, the run stops there, usually taking under a minute.
- **One run at a time.** A run that starts while another is going waits for it, and the nightly run is skipped if a Docturnal run is already queued or in progress.
- **Only Docturnal's own work.** Docturnal runs only on your default branch. If someone adds a commit to the open Docturnal pull request, Docturnal stops adding to it until you merge or close it, so the pull request never mixes its changes with someone else's.
- **Work is never lost to a timeout.** Each run stops starting new files when its time budget, 90 minutes by default, is close to running out, and commits what is finished. The job's timeout leaves at least 20 minutes after that budget. Files that are left over are listed in the pull request and go first on the next night.

## Supported languages

Docturnal supports JavaScript, TypeScript (including JSX and TSX), Python, C, C++, C#, Java, Go, Rust, Swift, Kotlin, Scala, Dart, PHP, Ruby, Shell, R, Perl, PowerShell, SQL, Lua, Haskell, CSS, SCSS, and Less.

A parser verifies the result for JavaScript, TypeScript, and Python. The other languages are checked using placement rules only.

## Limitations

- **Small models on CPUs:** GitHub's standard runners don't have GPUs, so Docturnal uses smaller code models: `qwen2.5-coder:3b` for comments and `qwen2.5-coder:7b` for documents. On runners with less memory, like those for private repositories, documents might be written using the smaller model, and the pull request will indicate this. The comments and documents are good drafts, not expert reviews.
- **Speed:** Models on a CPU are slow. In a very large repository, the first run writes documentation for the folders it reaches, lists the others in the README, and adds them the next night. Commenting all existing code takes many nights, one batch at a time.
- **GitHub Actions minutes:** Runs in public repositories are free. Runs in private repositories use your account's included GitHub Actions minutes. A night with nothing to do stops before Ollama is installed, which usually takes under a minute.

## Uninstalling

When you uninstall the app, it deletes your stored settings. GitHub then removes access to your repositories, so it can't clean up. To fully remove Docturnal, delete these:

- `.github/workflows/docturnal.yml`. Only the app starts it, so it no longer runs on its own.
- The `.docturnal/` folder.
- Any `docturnal/` branches, like `docturnal/update`, and any open Docturnal pull requests.

Comments and documents you merged stay in your code.

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

You can use the source code to verify what Docturnal does with your code. However, Docturnal is not open source. You can only use it by installing the official [Docturnal app](https://github.com/apps/docturnal-app) or under a separate written license from the author. See [LICENSE](LICENSE).
