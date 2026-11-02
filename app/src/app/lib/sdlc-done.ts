/* Pure logic of declaring a change done: the report the confirmation dialog shows, and whether the review of a
 * change covers its current work (the build page's stale-review notice). Kata checks nothing before declaring
 * done; the plugin's `change.done` verifies it. No Angular, no I/O. */

import type { Departure } from '@bindings/Departure';
import type { ParsedReviewSection } from '@bindings/ParsedReviewSection';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { RunLink } from '@bindings/RunLink';
import type { DoneStepKind } from '@bindings/DoneStepKind';
import type { RunRecord } from '@bindings/RunRecord';
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

export type ReviewScope = { workspaceId: string; system: string; change: string };
export type ReviewState = { kind: 'current'; link: RunLink } | { kind: 'current-document'; review: ParsedReviewSection } | { kind: ReviewMissing };

/** Whether `heads` (where each repository stands now) are the ones the review started from. */
function sameHeads(now: Record<string, string>, then: Record<string, string | undefined> | undefined): boolean {
  if (then === undefined) return false;
  return Object.keys(now).every((repo) => now[repo] === then[repo]);
}

/** The state of a change's latest review in its review document: stale when a repository it covered moved since. The master's head moves when the review is recorded, so the backend judges it instead: `master_moved` lists what the master committed since the head the review records, other than the review document. */
function documentState(document: ReviewRecord, heads: Record<string, string>, master: string | null): ReviewState {
  // A document with problems is not a review the Workbench can trust: a finding that failed its schema is dropped from the list, so "nothing found" would be a guess.
  if (document.problems.length > 0) return { kind: 'invalid' };
  const latest = document.reviews.at(-1);
  if (latest === undefined) return { kind: 'none' };
  const reviewed = latest.commits;
  const moved = Object.entries(heads).some(([repo, head]) => {
    if (repo === master) return false;
    const sha = reviewed[repo];
    return sha === undefined || sha.length < 4 || !head.startsWith(sha);
  });
  return moved || document.master_moved.length > 0 ? { kind: 'stale' } : { kind: 'current-document', review: latest };
}

/**
 * The state of the change's latest review. With a review document, its latest review decides: the commits it records
 * against where the repositories stand now, whatever the review run's exit code was. Without one, the review run
 * does: none when it was never run, unfinished when it did not exit 0, stale when a repository moved since it
 * started, otherwise current.
 */
export function reviewState(
  links: readonly RunLink[],
  records: readonly RunRecord[],
  heads: Record<string, string>,
  scope: ReviewScope,
  document: ReviewRecord | null = null,
  master: string | null = null,
): ReviewState {
  if (document !== null) return documentState(document, heads, master);
  let latest: RunLink | null = null;
  for (const l of links) {
    if (l.stage !== 'review' || l.workspace_id !== scope.workspaceId || l.system !== scope.system || l.change !== scope.change) continue;
    if (latest === null || l.started_at >= latest.started_at) latest = l;
  }
  if (latest === null) return { kind: 'none' };
  if (records.find((r) => r.id === latest.run_id)?.exit !== 0) return { kind: 'unfinished' };
  if (!sameHeads(heads, latest.heads)) return { kind: 'stale' };
  return { kind: 'current', link: latest };
}


/** The progress line each kind of step the plugin reports shows on. */
export const DONE_STEP_LINE: Record<DoneStepKind, ProgressStepId> = {
  verifying: 'running-checks',
  hook: 'running-checks',
  push: 'pushing',
  pullRequest: 'opening-prs',
};
