import type { Finding } from './sdlc';

/** The findings of one repository, or the ones naming none when `repo` is null. */
export type FindingGroup = { repo: string | null; findings: Finding[] };

/**
 * Groups findings by the repository they name. Named groups come first: the review's repositories in `repos` order,
 * then any repository a finding names that `repos` lacks, in first-seen order. Findings naming none go last in a group
 * with no repository; when no finding names one, that is the only group, empty or not. Order within a group is the order given.
 */
export function groupFindings(findings: Finding[], repos: string[]): FindingGroup[] {
  const named = new Map<string, Finding[]>();
  const unnamed: Finding[] = [];
  for (const f of findings) {
    if (f.repo === undefined) unnamed.push(f);
    else (named.get(f.repo) ?? named.set(f.repo, []).get(f.repo)!).push(f);
  }
  const order = [...repos.filter((r) => named.has(r)), ...[...named.keys()].filter((r) => !repos.includes(r))];
  const groups: FindingGroup[] = order.map((repo) => ({ repo, findings: named.get(repo)! }));
  return unnamed.length > 0 || groups.length === 0 ? [...groups, { repo: null, findings: unnamed }] : groups;
}
