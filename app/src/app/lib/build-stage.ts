import type { BuildPhase } from '@bindings/BuildPhase';
import type { BuildStatus } from '@bindings/BuildStatus';

export interface StageFacts {
  done: boolean;
  /** The phase the backend reports for the change's build, or none when this session hosts no build of it. */
  phase: BuildPhase | 'none';
  anyStopped: boolean;
  stage: 'build-ready' | 'build-stopped' | 'build-finished';
}

export type BuildStage = 'not-started' | 'running' | 'running-one-stopped' | 'stopped' | 'cancelled' | 'reviewing' | 'review-finished' | 'done';

export interface AreaFacts {
  stage: BuildStage;
  hasSessions: boolean;
  hasChanges: boolean;
}

/** The name the page's arrangement and messages use for the backend's phase of the build. A change declared done is done whatever the build session still says. */
export function buildStage(f: StageFacts): BuildStage {
  if (f.done) return 'done';
  switch (f.phase) {
    case 'building':
      return f.anyStopped ? 'running-one-stopped' : 'running';
    case 'reviewing':
      return 'reviewing';
    case 'stopped':
      return 'stopped';
    case 'cancelled':
      return 'cancelled';
    case 'finished':
      return 'review-finished';
    case 'none':
      if (f.stage === 'build-ready') return 'not-started';
      return f.stage === 'build-stopped' ? 'stopped' : 'review-finished';
  }
}

export function shownAreas(f: AreaFacts): { activity: boolean; files: boolean } {
  return { activity: f.stage !== 'not-started' || f.hasSessions, files: f.hasChanges };
}

export function taskGroups(status: BuildStatus, master: string, masterHasRuns: boolean): string[] {
  const groups = status.repos.map((r) => r.repo).filter((r) => r !== master);
  if (masterHasRuns || status.tasks.some((t) => t.repo === master)) groups.push(master);
  return groups;
}
