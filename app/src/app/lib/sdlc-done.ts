/* Pure logic of declaring a change done: the report the dialog shows, whether it can be confirmed, whether the
 * review covers the current work, and how a check's outcome is named. No Angular, no I/O. */

import type { CheckOutcome } from '@bindings/CheckOutcome';
import type { CheckSpec } from '@bindings/CheckSpec';
import type { Departure } from '@bindings/Departure';
import type { Offender } from '@bindings/Offender';
import type { ParsedReviewSection } from '@bindings/ParsedReviewSection';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { RemoteClash } from '@bindings/RemoteClash';
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

/** One repository the change opens a pull request in, with the checks it must pass and what they came to. */
export type DoneRepo = { repo: string; base: string; checks: CheckSpec[]; result: RepoChecks | null };

/** Everything the done dialog shows. */
export type DoneReport = {
  /** The GitHub account signed in on this machine; null when not known. */
  account: string | null;
  /** Why the repositories are not ready for pull requests; null when they are. */
  notReady: string | null;
  repos: DoneRepo[];
  /** The change's branch as the repositories have it; null when it could not be read. */
  branch: string | null;
  /** The repositories whose GitHub branch holds work this machine's does not; confirming waits until none is listed. */
  clashes: RemoteClash[];
  offenders: Offender[];
  departures: Departure[];
  review: DoneReview;
  /** The file the checks are read from. */
  checksPath: string;
  /** Why the checks file could not be used, with where; null when it could. */
  checksError: string | null;
};

export const REVIEW_MISSING_TEXT: Record<ReviewMissing, string> = {
  none: 'The change has not been reviewed.',
  unfinished: 'The review did not finish.',
  stale: 'The work changed since it was reviewed.',
  invalid: 'The review document does not pass its checks.',
};

export const FAILED_NOTE = 'The check ran and failed. Ask for another round to fix it.';
export const COULD_NOT_RUN_NOTE = 'The check could not run to completion. Fix the environment, not the code.';

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

export type CheckLabel = 'passed' | 'failed' | 'could not run' | 'no checks' | 'not run';
export type CheckTone = 'success' | 'error' | 'warning' | 'idle';

/** How one check ended, in words. */
export function outcomeLabel(outcome: CheckOutcome): 'passed' | 'failed' | 'could not run' {
  return outcome.kind === 'Passed' ? 'passed' : outcome.kind === 'Failed' ? 'failed' : 'could not run';
}

/** What a repository's checks came to: the first that did not pass, else passed; no checks and not run have their own words. */
export function checkLabel(result: RepoChecks | null): CheckLabel {
  if (result === null) return 'not run';
  if (result.none || result.results.length === 0) return 'no checks';
  const bad = result.results.find((r) => r.outcome.kind !== 'Passed');
  return bad ? outcomeLabel(bad.outcome) : 'passed';
}

/** The andon color of a label: jade, crimson, amber, and muted for the rest. */
export function checkTone(label: CheckLabel): CheckTone {
  switch (label) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'error';
    case 'could not run':
      return 'warning';
    default:
      return 'idle';
  }
}

/** One configured check of a repository and how it ended; a check after the first that did not pass was never run. */
export function specLabel(repo: DoneRepo, spec: CheckSpec): CheckLabel {
  const got = repo.result?.results.find((r) => r.name === spec.name);
  return got ? outcomeLabel(got.outcome) : 'not run';
}

/** A check that did not pass, with the words the dialog says about it. */
export type CheckProblem = {
  repo: string;
  name: string;
  kind: 'failed' | 'couldNotRun';
  heading: string;
  note: string;
  tail: string;
};

/** Every check that failed or could not run, in repository order. */
export function checkProblems(repos: readonly DoneRepo[]): CheckProblem[] {
  const out: CheckProblem[] = [];
  for (const r of repos) {
    for (const c of r.result?.results ?? []) {
      if (c.outcome.kind === 'Failed') {
        const exit = c.outcome.exit === null ? 'no exit code' : `exit ${c.outcome.exit}`;
        out.push({ repo: r.repo, name: c.name, kind: 'failed', heading: `${c.name} · ${exit}`, note: FAILED_NOTE, tail: c.tail });
      } else if (c.outcome.kind === 'CouldNotRun') {
        out.push({ repo: r.repo, name: c.name, kind: 'couldNotRun', heading: `${c.name} · ${c.outcome.reason}`, note: COULD_NOT_RUN_NOTE, tail: c.tail });
      }
    }
  }
  return out;
}

/** The review's high-severity findings: the ones that hold the pull requests until the engineer acknowledges them. */
export function highFindings(report: DoneReport): Finding[] {
  return hasReview(report.review) ? report.review.findings.filter((f) => f.severity === 'high') : [];
}

/** Whether the pull requests may open. A high-severity finding blocks until `acknowledged`; medium, low and unrated
 * findings never block; everything else listed does, acknowledged or not. */
export function canConfirm(report: DoneReport, acknowledged = false): boolean {
  if (report.notReady !== null || report.checksError !== null || report.offenders.length > 0) return false;
  if (!hasReview(report.review)) return false;
  if (highFindings(report).length > 0 && !acknowledged) return false;
  return report.repos.every((r) => r.result !== null && r.result.results.every((c) => c.outcome.kind === 'Passed'));
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The time a review ran, as the dialog shows it; a review document records only a date, shown as written. */
export function reviewedAt(ms: number | string): string {
  if (typeof ms === 'string') return ms;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
