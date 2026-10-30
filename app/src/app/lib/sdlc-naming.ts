import type { StartTrack } from './sdlc';

/** The conventional commit types a change can be named by. */
export type WorkType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf' | 'test' | 'build' | 'ci' | 'chore' | 'revert';

export const WORK_TYPES: readonly WorkType[] = [];

export function defaultWorkType(_route: StartTrack): WorkType {
  return 'chore';
}

export function orderedWorkTypes(_route: StartTrack): WorkType[] {
  return [];
}
