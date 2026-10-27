/** The long steps that show progress. */
export const PROGRESS_STEP_IDS = [
  'reading-stages',
  'reading-change',
  'reading-diff',
  'preparing-build',
  'running-checks',
  'pushing',
  'opening-prs',
] as const;

export type ProgressStepId = (typeof PROGRESS_STEP_IDS)[number];

/*
 * How long each step usually takes and the playful lines it rotates through. Every line names the step's action in
 * plain words (the test pins the verb), is in sentence case and ends in the "…" the app already uses. The plain label
 * with its counts sits next to the line and never rotates.
 */
export const PROGRESS_STEPS: Record<ProgressStepId, { usualMs: number; lines: readonly string[] }> = {
  'reading-stages': {
    usualMs: 2_000,
    lines: [
      'Reading every change on the shelf…',
      'Reading how far each change has come…',
      'Reading the folders, stage by stage…',
      'Reading what each change has so far…',
      'Reading the changes, one folder at a time…',
    ],
  },
  'reading-change': {
    usualMs: 1_000,
    lines: [
      'Reading the change from disk…',
      'Reading the intent, spec and plan…',
      'Reading what this change has so far…',
      'Reading the change, document by document…',
    ],
  },
  'reading-diff': {
    usualMs: 3_000,
    lines: [
      'Reading what changed…',
      'Reading the changes on each branch…',
      'Reading the diff of every repository…',
      'Reading what the branches hold…',
      'Reading the changes, repository by repository…',
    ],
  },
  'preparing-build': {
    usualMs: 5_000,
    lines: [
      'Checking the repositories before building…',
      'Checking every repository is ready…',
      'Checking the branches are where they should be…',
      'Checking nothing is left over from last time…',
      'Checking the ground before the build starts…',
    ],
  },
  'running-checks': {
    usualMs: 30_000,
    lines: [
      'Running the checks in your repositories…',
      'Running the checks, one repository at a time…',
      'Running the checks and waiting for their verdict…',
      'Running the checks, no shortcuts…',
    ],
  },
  'pushing': {
    usualMs: 30_000,
    lines: [
      'Pushing the change branch up to GitHub…',
      'Pushing the commits to the remote…',
      'Pushing the branch and waiting for GitHub…',
      'Pushing the commits, one repository at a time…',
    ],
  },
  'opening-prs': {
    usualMs: 30_000,
    lines: [
      'Opening a pull request…',
      'Opening the pull request on GitHub…',
      'Opening pull requests, one repository at a time…',
      'Opening the pull request and linking the change…',
    ],
  },
};

/** What a step is called in the notice for a step that runs long: "<name> is taking longer than usual (<n> s)". */
export const PROGRESS_NAMES: Record<ProgressStepId, string> = {
  'reading-stages': 'Reading the changes',
  'reading-change': 'Reading the change',
  'reading-diff': 'Reading what changed',
  'preparing-build': 'Preparing the build',
  'running-checks': 'Running the checks',
  'pushing': 'Pushing the change branch',
  'opening-prs': 'Opening pull requests',
};
