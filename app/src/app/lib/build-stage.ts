import type { BuildStatus } from '@bindings/BuildStatus';
import type { BuildPhase } from '../sdlc/build/build-driver';
import type { Situation } from './build-state';
import type { StageAction } from './sdlc';

export interface StageFacts {
  done: boolean;
  phase: BuildPhase | 'none';
  anyStopped: boolean;
  stage: 'build-ready' | 'build-stopped' | 'build-finished';
}

export type BuildStage = 'not-started' | 'running' | 'running-one-stopped' | 'stopped' | 'cancelled' | 'reviewing' | 'review-finished' | 'done';

export interface ReviewSituation {
  live: boolean;
  stopped: boolean;
}

export interface AreaFacts {
  stage: BuildStage;
  hasSessions: boolean;
  hasChanges: boolean;
}

export function buildStage(f: StageFacts): BuildStage {
  if (f.done) {
    if (f.phase !== 'none') throw new Error('a done change offers no action, so no driver begins');
    if (f.stage !== 'build-finished') throw new Error('done is only computed at build-finished');
    return 'done';
  }
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

const STAGE_ACTIONS: Record<BuildStage, StageAction[]> = {
  'not-started': ['start-build'],
  running: ['cancel-build'],
  'running-one-stopped': ['cancel-build'],
  reviewing: ['cancel-build'],
  stopped: ['continue-build', 'another-round'],
  cancelled: ['continue-build', 'another-round'],
  'review-finished': ['declare-done', 'another-round', 'run-review'],
  done: [],
};

export function buildActions(stage: BuildStage): StageAction[] {
  return [...STAGE_ACTIONS[stage]];
}

export function repoAction(situation: Situation, key: string, review: ReviewSituation): 'cancel' | 'continue' | null {
  if (key === 'review') {
    if (review.live) return 'cancel';
    return review.stopped ? 'continue' : null;
  }
  if (situation.kind === 'working') return 'cancel';
  if (situation.kind === 'stopped' && situation.from === 'driver') return 'continue';
  return null;
}

export function shownAreas(f: AreaFacts): { activity: boolean; files: boolean } {
  return { activity: f.stage !== 'not-started' || f.hasSessions, files: f.hasChanges };
}

export function taskGroups(status: BuildStatus, master: string, masterHasRuns: boolean): string[] {
  const groups = status.repos.map((r) => r.repo).filter((r) => r !== master);
  if (masterHasRuns || status.tasks.some((t) => t.repo === master)) groups.push(master);
  return groups;
}
