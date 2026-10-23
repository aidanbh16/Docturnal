// The workflow file the app commits to each repository. It has no schedule: the app's hourly
// cron starts it at the time chosen in Docturnal's settings, with the chosen comment level.

export const WORKFLOW_PATH = '.github/workflows/docturnal.yml';
export const WORKFLOW_FILE = 'docturnal.yml';

export function workflowYaml(actionRepository: string): string {
  return `# Docturnal adds comments to your code and updates your docs, then opens a pull request
# for you to review. The Docturnal app starts this workflow every night at the time you
# choose in Docturnal's settings. The settings link is in each Docturnal pull request.
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

// An earlier Docturnal template, which started itself with a schedule trigger.
export function isOldTemplate(content: string): boolean {
  return /^\s*schedule:/m.test(content) && /uses:\s*[\w.-]+\/docturnal@/i.test(content);
}
