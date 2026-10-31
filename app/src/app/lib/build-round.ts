import type { Finding } from './sdlc';

export type RoundFinding = { key: string; finding: Finding; repo: string | null };
export type RoundOffer = { review: number | null; repos: string[]; findings: RoundFinding[] };
export type RoundPicks = {
  picked: ReadonlySet<string>;
  assigned: Readonly<Record<string, string>>;
  notes: Readonly<Record<string, string>>;
};
export type RoundRequest = { repo: string; instructions: string; summary: string };
export type RoundPlan = { blocked: string | null; requests: RoundRequest[] };
export type RoundReview = { number: number | null; findings: Finding[] };

export function roundOffer(_review: RoundReview | null, repos: string[]): RoundOffer {
  return { review: null, repos, findings: [] };
}

export function defaultPicks(_offer: RoundOffer): RoundPicks {
  return { picked: new Set(), assigned: {}, notes: {} };
}

export function roundPlan(_offer: RoundOffer, _picks: RoundPicks): RoundPlan {
  return { blocked: null, requests: [] };
}
