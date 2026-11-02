/* Pure logic of declaring a change done: the report the dialog shows, whether it can be confirmed, whether the
 * review covers the current work. No Angular, no I/O. */

import type { Departure } from '@bindings/Departure';
import type { Offender } from '@bindings/Offender';
import type { ParsedReviewSection } from '@bindings/ParsedReviewSection';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { Finding } from './sdlc';

/** Why there is no review of the current work. */
export type ReviewMissing = 'none' | 'unfinished' | 'stale' | 'invalid';

/** The review of the current work with its findings, or the reason there is none. */
export type DoneReview = ReviewOnShow | { missing: ReviewMissing };

/** A review of the current work: `at` is the time its run started, or the date its document records; `older` marks findings read from a run's closing words because the change has no review document. */
export type ReviewOnShow = { at: number | string; findings: Finding[]; older?: boolean };

/** One repository the change opens a pull request in, with its checks as the plugin recorded them; null for a repository the build does not run checks in. */
export type DoneRepo = { repo: string; base: string; view: RepoCheckView | null };

/** Everything the done dialog shows. */
export type DoneReport = {
  /** The GitHub account signed in on this machine; null when not known. */
  account: string | null;
  /** Why the repositories are not ready for pull requests; null when they are. */
  notReady: string | null;
  repos: DoneRepo[];
  /** The change's branch as the repositories have it; null when it could not be read. */
  branch: string | null;
  offenders: Offender[];
  departures: Departure[];
  review: DoneReview;
};

export const REVIEW_MISSING_TEXT: Record<ReviewMissing, string> = {
  none: 'The change has not been reviewed.',
  unfinished: 'The review did not finish.',
  stale: 'The work changed since it was reviewed.',
  invalid: 'The review document does not pass its checks.',
};

/** True for a review of the current work. */
export function hasReview(review: DoneReview): review is ReviewOnShow {
  return 'findings' in review;
}

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

/** The review's high-severity findings: the ones that hold the pull requests until the engineer acknowledges them. */
export function highFindings(report: DoneReport): Finding[] {
  return hasReview(report.review) ? report.review.findings.filter((f) => f.severity === 'high') : [];
}

/** Whether the pull requests may open. A high-severity finding blocks until `acknowledged`; medium, low and unrated
 * findings never block; everything else listed does, acknowledged or not. */
export function canConfirm(report: DoneReport, acknowledged = false): boolean {
  if (report.notReady !== null || report.offenders.length > 0) return false;
  if (!hasReview(report.review)) return false;
  return highFindings(report).length === 0 || acknowledged;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The time a review ran, as the dialog shows it; a review document records only a date, shown as written. */
export function reviewedAt(ms: number | string): string {
  if (typeof ms === 'string') return ms;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
