// The stages of the build page and the mode each one suits. Pure rules only, no Angular.

import type { BuildStage } from './build-stage';
import type { LayoutMode } from './build-layout';
import type { ReviewEntry } from '../sdlc/build/build-page.view-model';

export type LayoutStage = 'started' | 'running' | 'stopped' | 'finished';

export function layoutStage(f: { stage: BuildStage; recorded: boolean; review: ReviewEntry }): LayoutStage {
  switch (f.stage) {
    case 'running':
    case 'running-one-stopped':
      return f.recorded ? 'running' : 'started';
    case 'reviewing':
      return 'running';
    case 'review-finished':
    case 'done':
      // A stale review counts as in; a finished change with no review counts as stopped.
      return f.review === 'finished' || f.review === 'stale' ? 'finished' : 'stopped';
    case 'not-started':
    case 'stopped':
    case 'cancelled':
      return 'stopped';
  }
}

export function suitedMode(s: LayoutStage): LayoutMode {
  switch (s) {
    case 'started':
    case 'stopped':
      return 'overview';
    case 'running':
      return 'watch';
    case 'finished':
      return 'review';
  }
}

export function onStageChange(f: { to: LayoutStage; mode: LayoutMode; handSwitched: boolean }): { move: LayoutMode | null; suggested: LayoutMode | null } {
  const suited = suitedMode(f.to);
  if (f.mode === suited) return { move: null, suggested: null };
  // A change into stopped never moves the page; it only marks Overview as suggested.
  if (f.to === 'stopped') return { move: null, suggested: suited };
  return f.handSwitched ? { move: null, suggested: suited } : { move: suited, suggested: null };
}
