import type { Finding } from './sdlc';

export type RoundFinding = { key: string; finding: Finding; repo: string | null };
/** The findings of one repository, or of those naming none when `repo` is null, as the dialog lists them. */
export type RoundGroup = { repo: string | null; findings: RoundFinding[] };
export type RoundOffer = { review: number | null; repos: string[]; findings: RoundFinding[] };
export type RoundPicks = {
  picked: ReadonlySet<string>;
  assigned: Readonly<Record<string, string>>;
  notes: Readonly<Record<string, string>>;
};
export type RoundRequest = { repo: string; instructions: string; summary: string };
export type RoundPlan = { blocked: string | null; requests: RoundRequest[] };
/** The latest review: its number (null for the older layout) and its findings in the order listed. */
export type RoundReview = { number: number | null; findings: Finding[] };

const DEFAULT_PICKED = new Set<string>(['critical', 'high', 'medium']);

/** A finding's key in the lists of a round and of the Review group: its id, else `#<n>` by its place in the review (`index` counts from 0). */
export const findingKey = (finding: Finding, index: number): string => finding.id ?? `#${index + 1}`;

/** What a round may fix: every finding of the latest review, none when there is no review. */
export function roundOffer(review: RoundReview | null, repos: string[]): RoundOffer {
  if (review === null) return { review: null, repos, findings: [] };
  return {
    review: review.number,
    repos,
    findings: review.findings.map((finding, i) => ({
      key: findingKey(finding, i),
      finding,
      repo: finding.repo ?? null,
    })),
  };
}

/** Critical, high and medium findings picked; a finding with no severity is not. */
export function defaultPicks(offer: RoundOffer): RoundPicks {
  const picked = new Set(
    offer.findings.filter((f) => f.finding.severity !== null && DEFAULT_PICKED.has(f.finding.severity)).map((f) => f.key),
  );
  return { picked, assigned: {}, notes: {} };
}

function block(f: RoundFinding): string {
  const { severity, concern, file, line, text } = f.finding;
  const head = `${f.key} (${[severity ?? 'no severity', concern].filter((p) => p !== undefined).join(', ')})`;
  const where = file === undefined ? '' : ` ${file}${line === undefined ? '' : `:${line}`}`;
  const body = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  return `- ${head}${where}\n${body}`;
}

/** One request per repository with a picked finding or a note, or the reason the round cannot start. */
export function roundPlan(offer: RoundOffer, picks: RoundPicks): RoundPlan {
  const picked = offer.findings
    .filter((f) => picks.picked.has(f.key))
    .map((f) => ({ f, repo: f.repo ?? picks.assigned[f.key] ?? null }));
  const unassigned = picked.filter((p) => p.repo === null).map((p) => p.f.key);
  if (unassigned.length > 0) return { blocked: `Choose a repository for ${unassigned.join(', ')}.`, requests: [] };

  const requests: RoundRequest[] = [];
  for (const repo of offer.repos) {
    const mine = picked.filter((p) => p.repo === repo).map((p) => p.f);
    const note = (picks.notes[repo] ?? '').trim();
    if (mine.length === 0 && note === '') continue;
    const parts: string[] = [];
    if (mine.length > 0) {
      const which = offer.review === null ? 'the latest review' : `review ${offer.review}`;
      parts.push(`Fix these findings from ${which} of this change in this repository.\n${mine.map(block).join('\n')}`);
    }
    if (note !== '') parts.push(`Also from the engineer:\n${note}`);
    const keys = mine.map((f) => f.key).join(', ');
    const summary = [repo, ...(keys === '' ? [] : [keys]), ...(note === '' ? [] : ['with a note'])].join(' · ');
    requests.push({ repo, instructions: parts.join('\n\n'), summary });
  }
  if (requests.length === 0) return { blocked: 'Pick a finding or write a note.', requests: [] };
  return { blocked: null, requests };
}
