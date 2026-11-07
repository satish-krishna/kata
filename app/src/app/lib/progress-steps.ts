/** The long steps that show progress. */
export const PROGRESS_STEP_IDS = [
  'listing-changes',
  'reading-open-stages',
  'reading-stages',
  'reading-change',
  'reading-diff',
  'checking-base',
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
  'listing-changes': {
    usualMs: 1_000,
    lines: [
      'Listing the changes on the shelf…',
      'Listing every change by name…',
      'Listing the changes, open and finished…',
      'Listing what the system holds…',
    ],
  },
  'reading-open-stages': {
    usualMs: 3_000,
    lines: [
      'Reading how far each open change has come…',
      'Reading the open changes, stage by stage…',
      'Reading what each open change has so far…',
      'Reading the open changes, one folder at a time…',
    ],
  },
  'reading-stages': {
    usualMs: 8_000,
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
  'checking-base': {
    usualMs: 510_000,
    lines: [
      'Checking which checks already fail on the base…',
      'Checking the base before anything is built on it…',
      'Checking the base branch, check by check…',
      'Checking what the base already gets wrong…',
      'Checking the base so the build can be told apart from it…',
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
  'listing-changes': 'Listing the changes',
  'reading-open-stages': 'Reading the changes',
  'reading-stages': 'Reading the changes',
  'reading-change': 'Reading the change',
  'reading-diff': 'Reading what changed',
  'checking-base': 'Checking the base',
  'preparing-build': 'Preparing the build',
  'running-checks': 'Running the checks',
  'pushing': 'Pushing the change branch',
  'opening-prs': 'Opening pull requests',
};

/** The plain label of each step, with the facts that stay put while the playful line rotates. */
export const progressLabels = {
  readingChange: (): string => 'Reading the change',
  readingDoc: (stem: string): string => `Reading ${stem}.md`,
  findingRepos: (): string => 'Finding the repositories with changes',
  readingDiff: (repo: string): string => `Reading the changes in ${repo}`,
  checkingBase: (): string => 'Checking the base before building',
  preparingBuild: (): string => 'Checking the repositories before building',
  preparingReview: (): string => 'Checking the repositories before the review',
};
