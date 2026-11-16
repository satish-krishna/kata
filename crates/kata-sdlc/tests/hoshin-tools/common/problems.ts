// How problems are printed and ordered: `<file>:<line>: <message>`, by file and then line.
import type { Problem } from './types.ts';

/** `<file>:<line>: <message>` */
export function formatProblem(p: Problem): string {
  return `${p.file}:${p.line}: ${p.message}`;
}

/** Problems sort by file, then line, then message, so output is deterministic. */
export function sortProblems(problems: Problem[]): Problem[] {
  return [...problems].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}
