import type { BuildRow } from '@bindings/BuildRow';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { Part } from '@bindings/Part';

/**
 * The tasks each changed file is tied to, keyed by path; an empty array means not tied to a task.
 * Tasks come in the order the rows appear in, which is plan order.
 */
export function tieFiles(
  rows: BuildRow[],
  repo: string,
  commits: CommitFiles[],
  files: ChangedFile[],
  part: Part,
): Map<string, string[]> {
  const ties = new Map<string, string[]>();
  const mine = rows.filter((r) => r.repo === repo);

  // For each commit, the indexes of the rows that list it.
  const listedBy = commits.map(() => new Set<number>());
  mine.forEach((r, i) => {
    for (const short of r.commits) {
      const prefix = short.toLowerCase();
      const hits = commits.flatMap((c, ci) => (c.sha.toLowerCase().startsWith(prefix) ? [ci] : []));
      if (hits.length === 1) listedBy[hits[0]].add(i);
    }
  });

  for (const f of files) {
    const tasks: string[] = [];
    if (part !== 'uncommitted') {
      const owners = new Set<number>();
      commits.forEach((c, ci) => {
        if (c.files.includes(f.path) && listedBy[ci].size === 1) owners.add([...listedBy[ci]][0]);
      });
      for (const i of [...owners].sort((a, b) => a - b)) {
        if (!tasks.includes(mine[i].task)) tasks.push(mine[i].task);
      }
    }
    ties.set(f.path, tasks);
  }
  return ties;
}
