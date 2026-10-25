// The workflow file the app commits to each repository. It has no schedule: the app's hourly
// cron starts it at the time chosen in Docturnal's settings, with the chosen comment level.

export const WORKFLOW_PATH = '.github/workflows/docturnal.yml';
export const WORKFLOW_FILE = 'docturnal.yml';

// Raise this whenever the template changes. Repositories with an older version get an
// "Update Docturnal workflow" pull request, once per version.
// - 0: the earliest template, started by its own schedule.
// - 1: started by the app, with the comment-level input. It has no version line.
// - 2: adds the concurrency group, so a second run waits for the first.
// - 3: actions/checkout v7, which runs on Node.js 24 instead of the deprecated Node.js 20.
// - 4: plan, work, and finish jobs, so large passes run on several runners at once, and the
//      existing-code input.
export const WORKFLOW_VERSION = 4;

// Each job's timeout leaves at least 20 minutes after the Action's time budget, for setup and
// the commit, so a run never loses its work to the timeout.
const TIME_BUDGET_MINUTES = 90;
const JOB_TIMEOUT_MINUTES = 120;
const VERSION_LINE = /^# Docturnal workflow version (\d+)\.?\s*$/m;

export function workflowYaml(actionRepository: string): string {
  const inputs = `          comment-level: \${{ inputs['comment-level'] || 'medium' }}
          existing-code: \${{ inputs['existing-code'] || 'gradual' }}`;
  return `# Docturnal adds comments to your code and updates your docs, then opens a pull request
# for you to review. The Docturnal app starts this workflow every night at the time you
# choose in Docturnal's settings. The settings link is in each Docturnal pull request.
# Docturnal workflow version ${WORKFLOW_VERSION}.
name: Docturnal

on:
  workflow_dispatch:
    inputs:
      comment-level:
        description: "How many comments to add: low, medium, heavy, or off (docs only)."
        type: choice
        options: ["low", "medium", "heavy", "off"]
        default: "medium"
      existing-code:
        description: "Existing code: gradual (comment it in small batches) or none (only new and changed code)."
        type: choice
        options: ["gradual", "none"]
        default: "gradual"

permissions:
  contents: write
  # Lets the finish and cleanup jobs delete this run's artifacts, which hold content from your code.
  actions: write

# One run at a time: a run that starts while another is going waits for it, so two runs
# never push docturnal/update at once.
concurrency:
  group: docturnal
  cancel-in-progress: false

jobs:
  # Decides tonight's work. On a night with no changes, the run ends here.
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      has-work: \${{ steps.docturnal.outputs.has-work }}
      shards: \${{ steps.docturnal.outputs.shards }}
      max-parallel: \${{ steps.docturnal.outputs.max-parallel }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: docturnal
        uses: ${actionRepository}@v1
        with:
          mode: plan
${inputs}

  # Each work job reads or comments one share of the files. A large pass, such as the first
  # one, uses several at once: up to 8 for a public repository, 2 for a private one.
  work:
    needs: plan
    if: needs.plan.outputs.has-work == 'true' && needs.plan.outputs.shards != '[]'
    runs-on: ubuntu-latest
    timeout-minutes: ${JOB_TIMEOUT_MINUTES}
    strategy:
      # The other work jobs keep going when one fails, and finish applies what they did.
      fail-fast: false
      max-parallel: \${{ fromJSON(needs.plan.outputs.max-parallel) }}
      matrix:
        shard: \${{ fromJSON(needs.plan.outputs.shards) }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: ${actionRepository}@v1
        with:
          mode: work
          shard: \${{ matrix.shard }}
${inputs}
          time-budget-minutes: "${TIME_BUDGET_MINUTES}"
          job-timeout-minutes: "${JOB_TIMEOUT_MINUTES}"

  # Applies every work job's results, writes the docs, and pushes docturnal/update. It runs
  # only when every work job succeeded, so a failed job never leaves a partial pull request.
  finish:
    needs: [plan, work]
    if: \${{ !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.has-work == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: ${JOB_TIMEOUT_MINUTES}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: ${actionRepository}@v1
        with:
          mode: finish
${inputs}
          time-budget-minutes: "${TIME_BUDGET_MINUTES}"
          job-timeout-minutes: "${JOB_TIMEOUT_MINUTES}"

  # When the run is cancelled, finish doesn't run; this deletes the artifacts the work jobs
  # uploaded, which hold content from your code.
  cleanup:
    needs: [plan, work, finish]
    if: always() && needs.plan.outputs.has-work == 'true' && needs.finish.result == 'skipped'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${actionRepository}@v1
        with:
          mode: cleanup
`;
}

// True when a step uses the Docturnal action: the configured action repository, or any
// repository named docturnal.
function usesDocturnal(content: string, actionRepository: string): boolean {
  const names = ['[\\w.-]+/docturnal'];
  if (actionRepository) names.push(actionRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`uses:\\s*(?:${names.join('|')})@`, 'i').test(content);
}

// An earlier Docturnal template, which started itself with a schedule trigger.
export function isOldTemplate(content: string, actionRepository = ''): boolean {
  return /^\s*schedule:/m.test(content) && usesDocturnal(content, actionRepository);
}

// The template version of a workflow file, or null when the file does not run Docturnal.
export function templateVersion(content: string, actionRepository = ''): number | null {
  if (!usesDocturnal(content, actionRepository)) return null;
  const line = VERSION_LINE.exec(content);
  if (line) return Number(line[1]);
  return isOldTemplate(content, actionRepository) ? 0 : 1;
}
