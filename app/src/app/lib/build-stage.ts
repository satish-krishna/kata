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

export function buildStage(_f: StageFacts): BuildStage {
  throw new Error('not implemented');
}

export function buildActions(_stage: BuildStage): StageAction[] {
  throw new Error('not implemented');
}

export function repoAction(_situation: Situation, _key: string, _review: ReviewSituation): 'cancel' | 'continue' | null {
  throw new Error('not implemented');
}

export function shownAreas(_f: AreaFacts): { activity: boolean; files: boolean } {
  throw new Error('not implemented');
}

export function taskGroups(_status: BuildStatus, _master: string, _masterHasRuns: boolean): string[] {
  throw new Error('not implemented');
}
