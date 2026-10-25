# Testing the parallel run on GitHub

This plan checks what the local tests can't: the job matrix built from the plan's outputs, artifacts passed between jobs and deleted afterward, `runner.environment`, and the real behavior of GitHub when a job fails or a run is cancelled. It uses the `beta` tag, so installs on `v1` are not affected.

It takes about an hour of wall time, most of it waiting for runs. Each run of the scratch repository uses Actions minutes on up to 4 runners at once; a public repository doesn't pay for them.

## Before you start

Push the code to `aidanbh16/Docturnal`, then point the `beta` tag at it. Leave `v1` where it is.

```sh
git tag -f beta
git push -f origin beta
```

Create the scratch repository with the script. It writes 61 source files in 4 folders (`src/api`, `src/core`, `src/data`, `src/util`) that import each other, plus a file with a space in its path, one with a Unicode name, and one with Windows line endings. With `--create`, it also creates the repository on GitHub with the `gh` CLI, pushes it, and turns on the setting that lets the workflow's token open pull requests.

Without `gh`, create an empty public repository on GitHub (no README, license, or `.gitignore`), then build and push:

```sh
bash test/github/make-scratch-repo.sh ../docturnal-scratch
cd ../docturnal-scratch
git remote add origin https://github.com/aidanbh16/docturnal-scratch.git
git push -u origin main
```

Then turn on the setting by hand: in the repository, open **Settings**, then **Actions**, then **General**. Under **Workflow permissions**, select **Allow GitHub Actions to create and approve pull requests**, and click **Save**.

The workflow it installs is `test/github/docturnal-beta.yml`. It runs only when you start it, from the repository's **Actions** tab, under **Docturnal**, with **Run workflow**. Don't install the Docturnal app on this repository: the workflow opens its own pull requests, and the app would dispatch its own runs.

## The runs

Run them in this order. Each one builds on the one before.

**1. A first run with one failed worker.** Start the workflow with `break-shard` set to `1`. The plan job's last step should print `shards: [0,1,2,3]` and `max-parallel: 4`, and four work jobs should start at once. Shard 1 fails at once, on purpose. The other three should keep going rather than be cancelled, and `finish` should still run. Its log should show the warning that shard 1's files wait for the next run, and end with "deleted 4 artifacts of this run" (the plan and three shards). A pull request titled "Docturnal: documentation" should open. Its progress section should say the documentation is not complete yet, and it should have no comments in any file. On the run's summary page, the **Artifacts** section should be empty.

**2. The rest of the documentation.** Start the workflow with no inputs changed. It should read only shard 1's files, about 15, in one work job, since that's fewer than 40. The same pull request should be updated, and its progress section should now say the documentation is complete. Check that `README.md` and the layer documents under `docs/` exist on `docturnal/update`, and that no source file changed.

**3. The first batch.** Start the workflow again. One work job should comment at most 15 files, all from one layer if it has enough of them; the helpers in `src/util` are imported most, so expect them first. The pull request's title should change to "Docturnal: comments and documentation", and its progress section should name batch 1. Open `src/util/crlf.js` and `src/util/grüße.js` if they were in the batch: the comments should use the file's line endings and leave every original line as it was.

**4. One batch at a time.** Start the workflow once more, without merging. The plan should find no new batch, since batch 1 is still open; it should log "No changes since the last run", and the work and finish jobs should be skipped.

**5. A reviewer's commit during a run.** Edit one file on `src/` on `main` (so the run has work), then start the workflow. While the work job runs, add a commit to `docturnal/update` from the pull request's **Files changed** tab, for example by editing `README.md` there. The `finish` job should warn that `docturnal/update` changed while the run was going, and not push. Your commit should still be the branch's latest. Then delete that commit's change, or keep it; either is fine for the next steps.

**6. A squash merge.** Merge the pull request with **Squash and merge**. Start the workflow. The plan should treat batch 1 as merged and pick batch 2, and a new pull request should open.

**7. A cancelled run.** Change the comment level to `heavy` when you start it, so there's more work, then cancel the run while the work job runs. The `finish` job should be skipped and the `cleanup` job should run, logging "deleted N artifacts of this run". The **Artifacts** section should end up empty.

**8. Two runs at once.** Start the workflow twice in a row. The second run should wait as pending until the first one ends, because of the `concurrency` group.

**9. A private repository.** Make a second scratch repository with `--private` and a new name, and start its first run. The plan should print `max-parallel: 2`, and only two work jobs should run at a time.

## What to send back

For any run that doesn't match, send the run's URL and the log of the job that went wrong. Delete the scratch repositories when you're done, since they hold Docturnal-generated pull requests and nothing else.
