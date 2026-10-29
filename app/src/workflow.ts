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
// - 4: the existing-code input, for the "Existing code" setting.
// - 5: actions/checkout pinned to a full commit SHA instead of a version tag.
// - 6: the private-minutes input: a private repository's time budget, from the settings.
export const WORKFLOW_VERSION = 6;

// The job's timeout leaves at least 20 minutes after the Action's time budget, for setup and
// the commit, so a run never loses its work to the timeout. A private repository's runs count
// toward its owner's Actions minutes, so they get the settings' shorter budget.
const TIME_BUDGET_MINUTES = 90;
const PRIVATE_MINUTES = 30;
const JOB_TIMEOUT_MINUTES = 120;
const VERSION_LINE = /^# Docturnal workflow version (\d+)\.?\s*$/m;

export function workflowYaml(actionRepository: string): string {
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
      private-minutes:
        description: "The most minutes a night Docturnal works in a private repository. Public repositories get ${TIME_BUDGET_MINUTES}."
        type: choice
        options: ["15", "30", "60", "90"]
        default: "${PRIVATE_MINUTES}"

permissions:
  contents: write

# One run at a time: a run that starts while another is going waits for it, so two runs
# never push docturnal/update at once.
concurrency:
  group: docturnal
  cancel-in-progress: false

jobs:
  docturnal:
    runs-on: ubuntu-latest
    timeout-minutes: ${JOB_TIMEOUT_MINUTES}
    steps:
      # Pinned to a full commit SHA, so the code that checks out your repository cannot change
      # without a new version of this workflow.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: ${actionRepository}@v1
        with:
          comment-level: \${{ inputs['comment-level'] || 'medium' }}
          existing-code: \${{ inputs['existing-code'] || 'gradual' }}
          # Private repositories use the time limit from the settings; public ones ${TIME_BUDGET_MINUTES} minutes.
          time-budget-minutes: \${{ github.event.repository.private && (inputs['private-minutes'] || '${PRIVATE_MINUTES}') || '${TIME_BUDGET_MINUTES}' }}
          job-timeout-minutes: "${JOB_TIMEOUT_MINUTES}"
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
