import type { StatusText } from '../sdlc/build/build-page.view-model';
import { findingKey, type RoundGroup, type RoundOffer } from './build-round';
import type { Finding, Severity } from './sdlc';
import type { FindingGroup } from './sdlc-findings';

export type TaskLine = { id: string; name: string; status: StatusText; finished: boolean; departure: string | null };

export type TaskFilter = 'all' | 'open' | 'departed' | 'done';

export type TaskListView = {
  fold: { range: string; done: number; departed: number; open: boolean } | null;
  rows: { line: TaskLine; showDeparture: boolean }[];
  empty: string | null;
};

export type FilterCounts = { all: number; open: number; departed: number; done: number };

const departedOf = (lines: TaskLine[]) => lines.filter((t) => t.departure !== null);
const plain = (lines: TaskLine[]) => lines.map((line) => ({ line, showDeparture: false }));

export function taskList(tasks: TaskLine[], filter: TaskFilter, open: boolean, picked: string | null): TaskListView {
  const finished = tasks.filter((t) => t.finished);
  const unfinished = tasks.filter((t) => !t.finished);
  switch (filter) {
    case 'open':
      return { fold: null, rows: plain(unfinished), empty: unfinished.length === 0 ? 'Nothing open.' : null };
    case 'departed':
      return { fold: null, rows: departedOf(finished).map((line) => ({ line, showDeparture: true })), empty: null };
    case 'done':
      return { fold: null, rows: plain(finished), empty: null };
    case 'all': {
      if (finished.length === 0) return { fold: null, rows: plain(tasks), empty: null };
      const shown = open || finished.some((t) => t.id === picked);
      const first = finished[0].id;
      const last = finished[finished.length - 1].id;
      return {
        fold: {
          range: finished.length === 1 ? first : `${first}–${last}`,
          done: finished.length,
          departed: departedOf(finished).length,
          open: shown,
        },
        rows: plain(shown ? [...finished, ...unfinished] : unfinished),
        empty: null,
      };
    }
  }
}

export function filterCounts(tasks: TaskLine[]): FilterCounts {
  const finished = tasks.filter((t) => t.finished);
  return {
    all: tasks.length,
    open: tasks.length - finished.length,
    departed: departedOf(finished).length,
    done: finished.length,
  };
}

export type ReviewRow = { key: string; finding: Finding; summary: string };
export type ReviewRowsView = {
  counts: { severity: Severity; n: number }[];
  total: number;
  groups: { repo: string | null; rows: ReviewRow[]; low: ReviewRow[] }[];
};

/** The rows the Review group lists for the latest review's findings. `all` is the review's findings in the order listed, for the `#<n>` key. */
export function reviewRows(groups: FindingGroup[], all?: Finding[]): ReviewRowsView {
  const flat = groups.flatMap((g) => g.findings);
  const order = all ?? flat;
  const row = (finding: Finding): ReviewRow => {
    const at = order.indexOf(finding);
    return { key: findingKey(finding, at === -1 ? flat.indexOf(finding) : at), finding, summary: summaryOf(finding.text) };
  };
  const counts = SEVERITIES.map((severity) => ({ severity, n: flat.filter((f) => f.severity === severity).length })).filter((c) => c.n > 0);
  return {
    counts,
    total: flat.length,
    groups: groups.filter((g) => g.findings.length > 0).map((g) => ({
      repo: g.repo,
      rows: g.findings
        .filter((f) => f.severity !== 'low')
        .sort((a, b) => rank(a) - rank(b))
        .map(row),
      low: g.findings.filter((f) => f.severity === 'low').map(row),
    })),
  };
}

/** The groups of the round dialog: the Review group's, in its order. */
export function roundGroups(offer: RoundOffer, groups: FindingGroup[], all: Finding[]): RoundGroup[] {
  const offered = new Map(offer.findings.map((f) => [f.key, f]));
  return reviewRows(groups, all).groups.map((g) => ({
    repo: g.repo,
    findings: [...g.rows, ...g.low].flatMap((r) => offered.get(r.key) ?? []),
  }));
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const rank = (f: Finding): number => (f.severity === null ? SEVERITIES.length : SEVERITIES.indexOf(f.severity));

/** The first sentence of a finding's text (up to the first full stop and space, or line break), the whole text when it has none. */
export function summaryOf(text: string): string {
  const line = text.split(/\r?\n/)[0];
  const stop = line.indexOf('. ');
  return stop === -1 ? line : line.slice(0, stop + 1);
}
