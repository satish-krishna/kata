/* Which review findings a change shows: the latest review of its review document when it has one, otherwise
 * the closing words of its review run, read the way they were before the document existed. No Angular, no I/O. */

import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { Finding } from './sdlc';

/** One review of the document, with its findings in the order the document lists them (most serious first). */
export type ShownReview = { number: number; reviewedAt: string; findings: Finding[] };

export type ReviewShown =
  /** Neither a document nor a review run: the change has not been reviewed. */
  | { kind: 'none' }
  /** No document: the findings parsed from the run's closing words, to be labeled as the older layout. */
  | { kind: 'words'; findings: Finding[] }
  /** The latest review, and the earlier ones newest first. A latest review with no findings means reviewed, nothing found. */
  | { kind: 'document'; latest: ShownReview; earlier: ShownReview[] };

type Section = ReviewRecord['reviews'][number];

/** One review of the document, as the Workbench shows it. */
export function shownSection(section: Section): ShownReview {
  return {
    number: section.number,
    reviewedAt: section.reviewed_at,
    findings: section.findings.map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, text: f.text })),
  };
}

/**
 * `record` is the review document, or null when the change has none; `words` is the findings read from the
 * review run's closing words, or null when no review run was found. The document wins whenever it is there.
 * A document with no review in it is a document problem the check reports, and shows as no review.
 */
export function shownReview(record: ReviewRecord | null, words: Finding[] | null): ReviewShown {
  if (record !== null) {
    const all = record.reviews.map(shownSection);
    const latest = all.at(-1);
    return latest === undefined ? { kind: 'none' } : { kind: 'document', latest, earlier: all.slice(0, -1).reverse() };
  }
  return words === null ? { kind: 'none' } : { kind: 'words', findings: words };
}
