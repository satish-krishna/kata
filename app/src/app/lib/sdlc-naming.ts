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

/** Why a system's unusable naming setting stops a new change (R3.2), worded for the dialog or a toast. */
export function namingRefusal(system: string, baseBranch: string | undefined, problem: string): string {
  const base = baseBranch ?? 'the base branch';
  return `Naming for ${system} cannot be used: ${problem}. The setting must be fixed in .ai-sdlc.json and committed to ${base}; until then no change can start here.`;
}
