// hoshin's own files in a repository: what the master repository holds for hoshin (`intent/` and the marker
// `.hoshin.json`), as opposed to its product files. When the master is listed as one of a system's product
// repositories, they are left out of its uncommitted files (another run may be writing them) and out of the commits
// that make its context stale.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyPaths } from '../git/git.ts';

export const OWN_FILES = ['intent', '.hoshin.json'];

/** Pathspecs leaving hoshin's own files out. */
export const excludingOwnFiles = (): string[] => OWN_FILES.map((p) => `:(exclude)${p}`);

/** Whether the repository holds the marker: it is the master (or a copy of it). */
export const holdsMarker = (repoPath: string): boolean => existsSync(join(repoPath, '.hoshin.json'));

/** The repository's uncommitted files, leaving out hoshin's own when the repository is the master. */
export const uncommittedFiles = (repoPath: string): string[] => dirtyPaths(repoPath, holdsMarker(repoPath) ? OWN_FILES : []);
