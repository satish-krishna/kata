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

/** How long each step usually takes and the playful lines it rotates through. */
export const PROGRESS_STEPS: Record<ProgressStepId, { usualMs: number; lines: readonly string[] }> = {
  'reading-stages': { usualMs: 2_000, lines: [] },
  'reading-change': { usualMs: 1_000, lines: [] },
  'reading-diff': { usualMs: 3_000, lines: [] },
  'preparing-build': { usualMs: 5_000, lines: [] },
  'running-checks': { usualMs: 30_000, lines: [] },
  'pushing': { usualMs: 30_000, lines: [] },
  'opening-prs': { usualMs: 30_000, lines: [] },
};

/** What a step is called when it runs long. */
export const PROGRESS_NAMES: Record<ProgressStepId, string> = {
  'reading-stages': '',
  'reading-change': '',
  'reading-diff': '',
  'preparing-build': '',
  'running-checks': '',
  'pushing': '',
  'opening-prs': '',
};
