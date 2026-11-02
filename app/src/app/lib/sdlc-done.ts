/* Declaring a change done: the report the confirmation dialog shows and the words for a review that does not cover
 * the current work. Whether it does is decided in Rust (`kata_sdlc::review::standing`). Kata checks nothing before
 * declaring done; the plugin's `change.done` verifies it. No Angular, no I/O. */

import type { Departure } from '@bindings/Departure';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { DoneStepKind } from '@bindings/DoneStepKind';
import type { ProgressStepId } from './progress-steps';

/** Why there is no review of the current work. */
export type ReviewMissing = 'none' | 'unfinished' | 'stale' | 'invalid';

/** Everything the done dialog shows before the plugin is asked. */
export type DoneReport = {
  repos: DoneRepo[];
  /** The change's branch as the repositories have it; null when it could not be read. */
  branch: string | null;
  departures: Departure[];
};

/** One repository the change opens a pull request in, with its checks as the plugin recorded them; null for a repository the build does not run checks in. */
export type DoneRepo = { repo: string; base: string; view: RepoCheckView | null };

export const REVIEW_MISSING_TEXT: Record<ReviewMissing, string> = {
  none: 'The change has not been reviewed.',
  unfinished: 'The review did not finish.',
  stale: 'The work changed since it was reviewed.',
  invalid: 'The review document does not pass its checks.',
};

/** The progress line each kind of step the plugin reports shows on. */
export const DONE_STEP_LINE: Record<DoneStepKind, ProgressStepId> = {
  verifying: 'running-checks',
  hook: 'running-checks',
  push: 'pushing',
  pullRequest: 'opening-prs',
};
