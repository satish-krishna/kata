// Whether a change branch name is free. A name is taken when it matches, ignoring capitals, a branch already on this
// machine (local, or last fetched from the remote) in the master or any repository of the system, or when one of
// the two is a folder of the other (`feat` and `feat/x` cannot both exist). The change's own branch never counts.
// Nothing is fetched to check.
import { branchNames } from '../git/git.ts';

export type Repository = { repo: string; path: string };

export function branchClashes(name: string, repos: Repository[], own: string | null = null): string[] {
  const lower = name.toLowerCase();
  const problems: string[] = [];
  for (const { repo, path } of repos) {
    for (const existing of branchNames(path)) {
      if (own !== null && existing === own) continue;
      const other = existing.toLowerCase();
      if (other === lower) problems.push(`${name} is taken in ${repo} by the branch ${existing}`);
      else if (other.startsWith(lower + '/') || lower.startsWith(other + '/')) problems.push(`${name} clashes in ${repo} with the branch ${existing}: one would be a folder of the other`);
    }
  }
  return [...new Set(problems)];
}
