import type { StartTrack } from './sdlc';

/** The conventional commit types a change can be named by. */
export type WorkType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf' | 'test' | 'build' | 'ci' | 'chore' | 'revert';

/** The eleven types, in the order the picker lists them after the route's default. */
export const WORK_TYPES: readonly WorkType[] = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];

/** The full pipeline starts as a feature; a described change (triage) starts as a fix. */
export function defaultWorkType(route: StartTrack): WorkType {
  return route === 'full' ? 'feat' : 'fix';
}

/** Every type, the route's default first and the rest in their listed order. */
export function orderedWorkTypes(route: StartTrack): WorkType[] {
  const first = defaultWorkType(route);
  return [first, ...WORK_TYPES.filter((t) => t !== first)];
}
