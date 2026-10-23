import type { BuildRow } from '@bindings/BuildRow';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { Part } from '@bindings/Part';

export function tieFiles(
  _rows: BuildRow[],
  _repo: string,
  _commits: CommitFiles[],
  _files: ChangedFile[],
  _part: Part,
): Map<string, string[]> {
  return new Map();
}
