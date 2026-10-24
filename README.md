# Docturnal

Your codebase, documented overnight.

Docturnal is a GitHub App that adds comments to your code and keeps your documentation up to date. Every night it works on GitHub's standard runner and opens a pull request for you to review. Your code never leaves the runner: the models run on the runner itself, and nothing goes to outside services.

## How it works

1. You install the Docturnal GitHub App on a repository. The app adds `.github/workflows/docturnal.yml` and starts the first run.
2. Each night, at the time you choose on the settings page, the app starts the workflow. A cheap check runs first; if nothing changed since the last run, the workflow stops there.
3. When something changed, the Docturnal Action comments the changed files, updates the docs, and pushes the `docturnal/update` branch.
4. The app opens a pull request from that branch, or updates the open one. Nothing reaches your code until you merge it.

## What Docturnal writes in your repository

| Path | What it is |
| --- | --- |
| `README.md` | The main document. Docturnal shares it with you; see [Your README](#your-readme). |
| `docs/<layer>.md` | One document per architecture layer. Each starts with a Docturnal marker, links to the other layers, and links back to `README.md`. |
| `.docturnal/state.json` | What the last run saw: file hashes, summaries, and the layers. |
| `.docturnal/readme.json` | The README as Docturnal last wrote it, with who owns each section. |
| `.docturnal/last-run.md` | The pull request description. |
| `.github/workflows/docturnal.yml` | The workflow the app starts each night. |

Docturnal never overwrites a file in `docs/` that lacks its marker, and it never changes your code itself. The model only proposes comments; Docturnal inserts them and checks that the code is otherwise unchanged.

## Your README

`README.md` starts with a hidden comment, `<!-- This README is maintained by Docturnal. Your additions and deletions are kept. -->`, instead of a marker.

- **Sections you add or edit are yours.** Docturnal polishes each one once for clarity, keeping your heading, links, badges, code, and numbers exactly. If a polish would lose any of them, your wording stays and the pull request says so.
- **Sections you delete stay deleted.** Docturnal never adds them back. If you add one back, it is yours.
- **Docturnal's own sections**, such as Overview and Architecture, are rewritten when your code changes.
- **Tables Docturnal computes**, the layers table, the scripts table, and the directory tree, sit between hidden `<!-- docturnal:... -->` markers. Docturnal keeps them current wherever they are. Delete one, and it stays deleted.

On the first run in a repository with a README you wrote, every section stays yours, and Docturnal adds only the sections and tables that are missing.

## Repository layout

| Path | Contents |
| --- | --- |
| `action.yml`, `src/` | The GitHub Action, in plain Node.js. |
| `app/` | The GitHub App backend, a Cloudflare Worker. See [`app/README.md`](app/README.md) and [`app/DEPLOY.md`](app/DEPLOY.md). |
| `test/` | Tests for the Action, including a mock Ollama server. |

## Development

You need Node.js 20 or later.

- Install the dependencies with `npm install`.
- Run the Action tests with `npm test`.
- Run the end-to-end runs against a local git remote with `bash test/e2e.sh`.
- Run the app tests with `npm test` in the `app` folder.
