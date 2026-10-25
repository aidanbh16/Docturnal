# Docturnal for teams

Docturnal for teams lets you run Docturnal without the Docturnal GitHub App, and if you need it, entirely on your own machines. Use it when your organization's policies don't allow third-party GitHub Apps, or don't allow source code to be processed on GitHub-hosted runners.

The GitHub App remains the easiest way to use Docturnal. Everything on this page is opt-in: you turn it on in your own workflow file.

## Choose a level

| | Level 1: Action only | Level 2: your own machines |
| --- | --- | --- |
| GitHub App | Not installed | Not installed |
| Where the run happens | GitHub-hosted runner | Your self-hosted runner |
| Where the models run | On the runner | On the runner, or on an Ollama server in your network |
| Who opens the pull request | The Action, with the workflow's token | The Action, with the workflow's token |
| Where the settings live | Your workflow file | Your workflow file |

Docturnal for teams works on GitHub.com and on GitHub Enterprise Server. The Action reads the `GITHUB_API_URL` that every runner sets, so it calls the right API on its own. GitHub Enterprise Server has no GitHub-hosted runners, so there, both levels run on your self-hosted runners.

## Level 1: the Action without the app

At this level, you add Docturnal's workflow file to your repository yourself. GitHub runs it on a hosted runner, and the Action opens the pull request itself. Nothing is installed in your organization, and your code goes nowhere but GitHub's runner, where the models run.

### Set up Level 1

1. Turn on **Allow GitHub Actions to create and approve pull requests**, in your repository's **Settings > Actions > General > Workflow permissions**. If it is greyed out, turn it on first in your organization's **Settings > Actions > General**. Without it, the Action pushes its branch but cannot open the pull request, and the run fails with a message that names this setting.
2. Turn on **Automatically delete head branches**, in your repository's **Settings > General > Pull Requests**. The app deletes Docturnal's branch after its pull request closes; without the app, this setting does it.
3. Add the workflow file below as `.github/workflows/docturnal.yml`, and commit it to your default branch.
4. To start the first run now rather than at the scheduled time, open the **Actions** tab, select **Docturnal**, and select **Run workflow**.

### Workflow for Level 1

```yaml
name: Docturnal

on:
  schedule:
    # Every day at 05:00 UTC, which is midnight in New York in winter.
    # Cron schedules always use UTC.
    - cron: "0 5 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

# One run at a time: a run that starts while another is going waits for it.
concurrency:
  group: docturnal
  cancel-in-progress: false

jobs:
  docturnal:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: aidanbh16/Docturnal@v1
        with:
          open-pr: "true"
          comment-level: medium
```

### Settings at Level 1

Without the app, there is no settings page. You change the settings in the workflow file:

- **Run time and time zone:** the `cron` line. Cron always uses UTC, so convert your local time to UTC, and remember that the conversion changes when daylight saving time starts or ends. For example, `0 5 * * *` is midnight in New York in winter and 1 AM in summer.
- **Comment level:** the `comment-level` input: `low`, `medium`, `heavy`, or `off`. See [Comment levels](../README.md#comment-levels).
- **Existing code:** the `existing-code` input: `gradual`, the default, comments your existing code in batches of up to `backlog-batch-size` files after the first run documents the project; `none` comments only new and changed code. See [What you get](../README.md#what-you-get).

The app also opens an "Update Docturnal workflow" pull request when its workflow file changes. Without the app, update your workflow file yourself when a new version of Docturnal needs it.

## Level 2: your own machines

At this level, the run happens on a self-hosted runner, a machine of yours that GitHub sends the job to. Your code never leaves your machines: the runner checks out the repository, and the models run either on the runner or on an Ollama server in your network.

### Register a self-hosted runner

Follow GitHub's guide to [adding self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners). You can add the runner to one repository or to your organization. Give it a label, such as `docturnal`, if you want only some jobs to run on it.

The runner needs:

- **Linux, on x64 or arm64.** Docturnal installs Ollama only on Linux.
- **The GitHub Actions runner, version 2.327.1 or later.** `actions/checkout@v7` needs it.
- **Node.js 20 or later, git, and curl.**
- **Python 3.8 or later**, if your repository has Python files. Docturnal uses it to check that each comment it adds leaves the Python program unchanged. Without it, Python files get no comments.
- **For models on the runner:** either Ollama already installed and on the `PATH`, or `sudo` without a password, so the Ollama installer can run. Enough memory for the models: about 8 GB for the default models, more for larger ones.

### Models on the runner, or on your Ollama server

You can run the models in one of two places:

- **On the runner.** Leave `ollama-url` empty. Docturnal uses the Ollama on the runner's `PATH`, or installs it, and starts its own Ollama server on a free port, so it never conflicts with an Ollama service that is already running. It keeps the models in `~/.docturnal/models`, or in the folder you set with `models-dir`, so they are downloaded only once. Docturnal never stores models or Ollama in GitHub's cache on a self-hosted runner.
- **On an Ollama server in your network.** Set `ollama-url` to the server's URL. Docturnal then installs, starts, and caches nothing: it checks that the server answers, and asks it to pull any missing model. Companies often run this server on a machine with a GPU, which can run much larger models than a CPU can.

> **Warning:** `ollama-url` receives your source code. Point it only at a server inside your own network.

Before it sends any code, Docturnal resolves the server's host name and checks every address it resolves to. It uses the server only if all of them are loopback or private addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`, or `fe80::/10`. It checks again each time it connects, so a DNS answer that changes later cannot send your code elsewhere. If the host resolves to a public address, the run fails with a message that says so. The run log shows the host and the addresses, never your code.

If your server really has a public address and you are sure it is yours, set `allow-public-ollama` to `"true"`. Then your source code goes to that address, across whatever network lies in between. Use HTTPS in that case, and prefer a private network or a VPN.

For an HTTPS server with a certificate from your company's own certificate authority, set the `NODE_EXTRA_CA_CERTS` environment variable on the runner to the path of that authority's certificate.

### Workflow for Level 2

This workflow runs on a self-hosted runner with the `docturnal` label and uses an Ollama server in your network:

```yaml
name: Docturnal

on:
  schedule:
    # Every day at 05:00 UTC. Cron schedules always use UTC.
    - cron: "0 5 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

# One run at a time: a run that starts while another is going waits for it.
concurrency:
  group: docturnal
  cancel-in-progress: false

jobs:
  docturnal:
    runs-on: [self-hosted, linux, docturnal]
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: aidanbh16/Docturnal@v1
        with:
          open-pr: "true"
          comment-level: medium
          ollama-url: http://ollama.internal.example.com:11434
          model: qwen2.5-coder:14b
          docs-model: qwen2.5-coder:32b
```

Set up the repository the same way as for Level 1: turn on **Allow GitHub Actions to create and approve pull requests** and **Automatically delete head branches**.

To run the models on the runner instead, remove the `ollama-url`, `model`, and `docs-model` lines. Docturnal then picks the models from the runner's memory.

### Choose the models

With `ollama-url`, `model` and `docs-model` are normal settings:

- `model` writes the comments. It handles many short requests, so a fast code model works best.
- `docs-model` writes the documents, and checks the comments when the run has time for it. It handles few long requests, so choose the largest model your server runs well.

Use any model name your Ollama server can pull, such as `qwen2.5-coder:32b`. Left as `auto`, they are `qwen2.5-coder:3b` and `qwen2.5-coder:7b`. If a model is missing, Docturnal asks the server to pull it. To stop that, set `pull-models` to `"false"`: a missing model then fails the run with a message that names it, and you pull it on the server with `ollama pull`.

## Run big passes in parallel (optional)

The workflows above run in one job. That suits most nights, which comment a few changed files and one small batch. A big pass, such as the first run that reads every file, takes much less time when it is split across several jobs that run at once.

For that, use these jobs instead of one: `plan` decides the work and splits it, each `work` job reads or comments its share, and `finish` applies every share, writes the docs, and opens the pull request. With fewer than 40 files to process, the plan uses a single work job. If a work job fails or runs out of time, the others keep going, and `finish` applies what they did; the failed job's files wait for the next run. If you cancel the run, `finish` doesn't run, and a small `cleanup` job deletes the artifacts the work jobs uploaded. To try a failed run again, use **Re-run all jobs**: the artifacts are deleted when a run ends, so re-running only the failed jobs can't find the plan.

The work jobs pass their results to `finish` as artifacts of the run. Those results contain content from your code, such as the commented files. Docturnal keeps them for one day at most, and `finish` deletes them as soon as it is done, which needs `actions: write`. While they exist, they are stored where your GitHub server stores artifacts: on GitHub.com, GitHub's storage. If your policies don't allow code-derived content there, keep the single-job workflow.

`max-jobs` sets the most work jobs that run at once. Without it, Docturnal uses up to 8 for a public repository and 2 for a private one, since every job uses Actions minutes. On self-hosted runners, set it to the number of runners free for Docturnal, and with `ollama-url`, to what your Ollama server can serve at once.

```yaml
name: Docturnal

on:
  schedule:
    # Every day at 05:00 UTC. Cron schedules always use UTC.
    - cron: "0 5 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  # Lets the finish and cleanup jobs delete this run's artifacts, which hold content from your code.
  actions: write

concurrency:
  group: docturnal
  cancel-in-progress: false

jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      has-work: ${{ steps.docturnal.outputs.has-work }}
      shards: ${{ steps.docturnal.outputs.shards }}
      max-parallel: ${{ steps.docturnal.outputs.max-parallel }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: docturnal
        uses: aidanbh16/Docturnal@v1
        with:
          mode: plan
          max-jobs: "4"
          comment-level: medium
          existing-code: gradual

  work:
    needs: plan
    if: needs.plan.outputs.has-work == 'true' && needs.plan.outputs.shards != '[]'
    runs-on: ubuntu-latest
    timeout-minutes: 120
    strategy:
      # The other work jobs keep going when one fails, and finish applies what they did.
      fail-fast: false
      max-parallel: ${{ fromJSON(needs.plan.outputs.max-parallel) }}
      matrix:
        shard: ${{ fromJSON(needs.plan.outputs.shards) }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: aidanbh16/Docturnal@v1
        with:
          mode: work
          shard: ${{ matrix.shard }}
          comment-level: medium
          existing-code: gradual
          time-budget-minutes: "90"
          job-timeout-minutes: "120"

  finish:
    needs: [plan, work]
    if: ${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.has-work == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: aidanbh16/Docturnal@v1
        with:
          mode: finish
          open-pr: "true"
          comment-level: medium
          existing-code: gradual
          time-budget-minutes: "90"
          job-timeout-minutes: "120"

  # When the run is cancelled, finish doesn't run; this deletes the work jobs' artifacts.
  cleanup:
    needs: [plan, work, finish]
    if: always() && needs.plan.outputs.has-work == 'true' && needs.finish.result == 'skipped'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: aidanbh16/Docturnal@v1
        with:
          mode: cleanup
```

Give the `plan`, `work`, and `finish` jobs the same `comment-level` and `existing-code`. For Level 2, change every `runs-on` to your runners' labels, and add your `ollama-url`, `model`, and `docs-model` to the `work` and `finish` jobs.

## Inputs for teams

| Input | Default | What it does |
| --- | --- | --- |
| `open-pr` | `"false"` | `"true"` makes the Action open the pull request, or update the open one, after it pushes `docturnal/update`. Needs `pull-requests: write`. |
| `github-token` | The workflow's token | The token for opening the pull request. |
| `ollama-url` | Empty | An Ollama server of your own. When it is set, Docturnal doesn't install, start, or cache Ollama. |
| `allow-public-ollama` | `"false"` | `"true"` lets `ollama-url` resolve to a public address. Read the warning above first. |
| `pull-models` | `"true"` | With `ollama-url`: whether to ask the server to pull missing models. |
| `models-dir` | `~/.docturnal/models` | On a self-hosted runner without `ollama-url`: the folder that keeps the models between runs. |
| `model`, `docs-model` | `auto` | The models. Set them when you use `ollama-url`. |
| `comment-level` | `medium` | `low`, `medium`, `heavy`, or `off`. |
| `existing-code` | `gradual` | `gradual` comments existing code in batches after the first run documents the project; `none` comments only new and changed code. |
| `backlog-batch-size` | `15` | The most existing files one batch comments. |
| `time-budget-minutes` | `90` | How long a run may spend on comments and documents. When it is nearly used up, the run stops starting new files and commits what is finished. |
| `job-timeout-minutes` | Empty | The job's `timeout-minutes`. Docturnal warns in the log when `time-budget-minutes` leaves less than 20 minutes before it, since a job that times out loses its work. |
| `mode` | `all` | `all` runs the whole run in one job. `plan`, `work`, `finish`, and `cleanup` are the jobs of a parallel run. |
| `shard` | `0` | For a `work` job: its share of the plan, from the matrix. |
| `max-jobs` | Empty | For a `plan` job: the most work jobs at once. Empty: 8 for a public repository, 2 for a private one. |

## What network access each mode needs

Docturnal makes no calls beyond the ones listed here, and none of them carry your code except the push to your repository and the requests to your own Ollama server.

**The app (default), and Level 1:**

- Your GitHub server: the checkout, the push of `docturnal/update`, the Actions cache, and at Level 1, the pull request.
- `github.com`: the latest Ollama release, read from its release page.
- `ollama.com`: the Ollama installer, when Ollama is not cached.
- The Ollama model registry, `registry.ollama.ai`: the models, when they are not cached.
- The npm registry: the Action's one dependency, `typescript`.

**Level 2, models on the runner:**

- Your GitHub server: the checkout, the push, and the pull request.
- `ollama.com`: the Ollama installer, only when Ollama is not on the runner's `PATH`.
- `registry.ollama.ai`: only for models that are not yet in the models folder.
- The npm registry: `typescript`.

**Level 2 with `ollama-url`:**

- Your GitHub server: the checkout, the push, and the pull request.
- Your Ollama server.
- The npm registry: `typescript`.

The runner contacts nothing about Ollama besides your server: no installer, no release check, and no model registry. When `pull-models` is `"true"` and a model is missing, your Ollama server pulls it from its own registry, not the runner.

npm uses the registry configured on the runner. To keep the runner off the internet, point npm at an internal mirror, for example by setting `NPM_CONFIG_REGISTRY` on the runner.

A parallel run also uploads its plan and its work jobs' results as artifacts to your GitHub server, and downloads them in the next job, as described in [Run big passes in parallel](#run-big-passes-in-parallel-optional).

On GitHub Enterprise Server, `actions/checkout` and the Docturnal action are also downloaded from your server, so they must be available there: either through GitHub Connect, or as copies of the repositories that your workflow file names in its `uses:` lines. A parallel run also uses `actions/upload-artifact` and `actions/download-artifact`.

## Troubleshooting

| Message | What to do |
| --- | --- |
| GitHub Actions is not allowed to create pull requests in *repository* | Turn on **Allow GitHub Actions to create and approve pull requests**, as the message says. The `docturnal/update` branch was pushed, so the next run opens the pull request. |
| The token cannot open pull requests in *repository* | Add `pull-requests: write` to the workflow's `permissions`. |
| Docturnal cannot reach the Ollama server at *URL* | Check `ollama-url`, and that the server is running and reachable from the runner. |
| The Ollama server *host* resolves to the public address *address* | Point `ollama-url` at a server inside your network. See the warning above. |
| The Ollama server at *URL* does not have the model *model*, and pull-models is "false" | Run `ollama pull model` on the server, or set `pull-models` to `"true"`. |
| Docturnal installs Ollama only on Linux x64 and arm64 runners | Install Ollama on the runner yourself, or set `ollama-url`. |
