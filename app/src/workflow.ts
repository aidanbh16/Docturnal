// The workflow file the app commits to each repository. It has no schedule: the app's hourly
// cron starts it at the time chosen in Docturnal's settings, with the chosen comment level.

export const WORKFLOW_PATH = '.github/workflows/docturnal.yml';
export const WORKFLOW_FILE = 'docturnal.yml';

// Raise this whenever the template changes. Repositories with an older version get an
// "Update Docturnal workflow" pull request, once per version.
// - 0: the earliest template, started by its own schedule.
// - 1: started by the app, with the comment-level input. It has no version line.
// - 2: adds the concurrency group, so a second run waits for the first.
export const WORKFLOW_VERSION = 2;
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
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ${actionRepository}@v1
        with:
          comment-level: \${{ inputs['comment-level'] || 'medium' }}
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
