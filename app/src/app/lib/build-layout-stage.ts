// The stages of the build page and the mode each one suits. Pure rules only, no Angular.

import type { BuildStage } from './build-stage';
import type { LayoutMode } from './build-layout';
import type { ReviewEntry } from '../sdlc/build/build-page.view-model';

export type LayoutStage = 'started' | 'running' | 'stopped' | 'finished';

export function layoutStage(_f: { stage: BuildStage; recorded: boolean; review: ReviewEntry }): LayoutStage {
  throw new Error('not implemented');
}

export function suitedMode(_s: LayoutStage): LayoutMode {
  throw new Error('not implemented');
}

export function onStageChange(_f: { to: LayoutStage; mode: LayoutMode; handSwitched: boolean }): { move: LayoutMode | null; suggested: LayoutMode | null } {
  throw new Error('not implemented');
}
