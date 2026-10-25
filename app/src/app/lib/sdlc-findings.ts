import type { Finding } from './sdlc';

/** The findings of one repository, or the ones naming none when `repo` is null. */
export type FindingGroup = { repo: string | null; findings: Finding[] };

export function groupFindings(_findings: Finding[], _repos: string[]): FindingGroup[] {
  return [];
}
