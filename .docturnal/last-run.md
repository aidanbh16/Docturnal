# Docturnal: comments and documentation

## Progress

- **Documentation:** complete, with 7 layer documents and the README.
- **Comments:** 17 of 88 files commented at the medium level.
- **This pull request:** comments on 5 new or changed files.
- **Next:** comments on existing code in batches of up to 15 files, starting with batch 2 and the most important files. 71 existing files are left.

The latest run adds 19 comments to 4 files, updates 2 docs and updates the README. Review the changes, then merge the pull request to keep them.

## Comments added

| File | Comments added | Checked by a parser | Proposed comments |
| --- | --- | --- | --- |
| `app/src/handlers.ts` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `app/src/index.ts` | 1 | Yes (TypeScript) | proposed 15, 6 dropped by placement rules, 1 anchor not found, 3 dropped by the density limit, 4 restates the code, 1 added; earlier Docturnal comments: 6 kept |
| `app/src/setup.ts` | 3 | Yes (TypeScript) | proposed 8, 3 dropped by placement rules, 1 anchor not found, 1 dropped by the density limit, 3 added; earlier Docturnal comments: 3 kept, 1 removed (within 5 lines of another comment: 1) |
| `app/tests/setup.spec.ts` | 3 | Yes (TypeScript) | proposed 8, 1 dropped by placement rules, 4 anchor not found, 3 added |
| `app/tests/webhook.spec.ts` | 12 | Yes (TypeScript) | proposed 46, 2 dropped by placement rules, 5 anchor not found, 5 dropped by the density limit, 2 inaccurate, 20 restates the code, 12 added |

## Docs

- Updated `docs/github-integration.md`
- Updated `docs/tests.md`

## README

- Updated: "Project layout"

## Left for the next run

- `src/comments.js`: time budget
- `src/process.js`: time budget
- `src/restates.js`: time budget
- `test/anchors.test.js`: time budget
- `test/restates.test.js`: time budget
- `test/mock-ollama.js`: time budget
- `app/tests/mock-github.mjs`: time budget
- `test/git-repo.js`: time budget
- `test/edges.test.js`: time budget
- `test/coverage.test.js`: time budget
- `test/model-split.test.js`: time budget
- `test/parts.test.js`: time budget
- `test/e2e.sh`: time budget
- `test/comments.test.js`: time budget
- `test/helpers.js`: time budget
- `test/big-layers.test.js`: time budget
- `test/docs.test.js`: time budget
- `test/ownership.test.js`: time budget
- `test/supply-chain.test.js`: time budget
- `test/heavy.test.js`: time budget

## Models

- Comment model: `qwen2.5-coder:3b`
- Docs model: `qwen2.5-coder:7b`
- Comment level: medium
