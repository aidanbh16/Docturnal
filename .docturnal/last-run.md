# Docturnal: comments and documentation

## Progress

- **Documentation:** complete, with 7 layer documents and the README.
- **Comments:** 66 of 97 files commented at the medium level.
- **This pull request:** comments on 51 new or changed files and batch 2 of existing code, 15 files in the Documentation and Grounding, Model Verification and Tests layers.
- **Next:** batch 3 of existing code, after you merge or close this pull request. 30 existing files are left.
- **Time limit:** 90 minutes a night.

The latest run adds 28 comments to 15 files, updates 7 docs, updates the README and removes 2 docs. Review the changes, then merge the pull request to keep them.

## Comments added

| File | Comments added | Checked by a parser | Proposed comments |
| --- | --- | --- | --- |
| `app/src/handlers.ts` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `app/src/scheduler.ts` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `app/src/settings.ts` | 2 | Yes (TypeScript) | proposed 2, 2 added |
| `app/src/setup.ts` | 1 | Yes (TypeScript) | proposed 1, 1 added; earlier Docturnal comments: 6 kept |
| `app/src/workflow.ts` | 1 | Yes (TypeScript) | proposed 1, 1 added |
| `app/tests/fake-kv.ts` | 1 | Yes (TypeScript) | proposed 1, 1 added |
| `app/tests/setup.spec.ts` | 0 | Yes (TypeScript) | proposed 0, 0 added; earlier Docturnal comments: 3 kept |
| `app/tests/webhook.spec.ts` | 0 | Yes (TypeScript) | proposed 0, 0 added; earlier Docturnal comments: 12 kept |
| `src/analyze.js` | 7 | Yes (TypeScript) | proposed 8, 1 restates the code, 7 added |
| `src/apply.js` | 0 | Yes (TypeScript) | proposed 3, 3 inaccurate, 0 added |
| `src/changes.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/comments.js` | 1 | Yes (TypeScript) | proposed 2, 1 inaccurate, 1 added |
| `src/docs.js` | 2 | Yes (TypeScript) | proposed 7, 5 inaccurate, 2 added |
| `src/git.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/importance.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/install-ollama.js` | 1 | Yes (TypeScript) | proposed 3, 2 restates the code, 1 added |
| `src/internal-error.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/layers.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/own.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/parts.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/process.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/python-helper.py` | 3 | Yes (Python) | proposed 6, 1 inaccurate, 2 restates the code, 3 added |
| `src/python.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/readme.js` | 0 | Yes (TypeScript) | proposed 7, 7 restates the code, 0 added; earlier Docturnal comments: 0 kept, 1 removed (inaccurate: 1) |
| `src/report.js` | 1 | Yes (TypeScript) | proposed 1, 1 added |
| `src/restates.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/state.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/targets.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/check-run.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/comment-cost.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/comments.test.js` | 0 | Yes (TypeScript) | proposed 4, 4 inaccurate, 0 added |
| `test/coverage.test.js` | 0 | Yes (TypeScript) | proposed 1, 1 inaccurate, 0 added |
| `test/declarations.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/e2e.sh` | 0 | No, placement rules only | proposed 0, 0 added |
| `test/excalidraw-files.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/heavy.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/helpers.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/internal-errors.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/mock-ollama.js` | 1 | Yes (TypeScript) | proposed 1, 1 added |
| `test/model-split.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/nightly.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/ownership.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/proposals.test.js` | 0 | Yes (TypeScript) | proposed 1, 1 restates the code, 0 added |
| `test/prototype-keys.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/replies.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/restates.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/round-robin.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/speed-model.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/targets.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/usefulness.test.js` | 2 | Yes (TypeScript) | proposed 3, 1 restates the code, 2 added |
| `src/languages.js` | 1 | Yes (TypeScript) | proposed 4, 3 restates the code, 1 added |
| `src/grounding.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/configuration.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/clusters.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/split.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/ollama.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/models.js` | 3 | Yes (TypeScript) | proposed 3, 3 added |
| `src/verify-models.js` | 1 | Yes (TypeScript) | proposed 1, 1 added |
| `src/precheck.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/accuracy.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `src/verify.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `app/tests/mock-github.mjs` | 0 | Yes (TypeScript) | proposed 4, 4 restates the code, 0 added |
| `test/git-repo.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |
| `test/edges.test.js` | 0 | Yes (TypeScript) | proposed 4, 1 inaccurate, 3 restates the code, 0 added |
| `test/parts.test.js` | 0 | Yes (TypeScript) | proposed 0, 0 added |

## Docs

- Updated `docs/app-registration.md`
- Updated `docs/ollama-management.md`
- Updated `docs/model-verification.md`
- Updated `docs/python-integration.md`
- Updated `docs/configuration-and-state-management.md`
- Updated `docs/documentation-and-grounding.md`
- Updated `docs/tests.md`
- Removed `docs/github-integration.md` because its layer no longer exists
- Removed `docs/python-helper.md` because its layer no longer exists

## README

- Updated: "Architecture"

## Models

- Comment model: `qwen2.5-coder:3b`
- Docs model: `qwen2.5-coder:7b`
- Comment level: medium
