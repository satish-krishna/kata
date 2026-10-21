/** The part of Monaco's ILineChange that navigation reads. */
export interface LineChangeLike {
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/**
 * The line in the modified editor where a change starts. A pure deletion has no modified
 * lines (end is 0) and its start names the line after which lines were removed.
 */
function anchor(change: LineChangeLike): number {
  return Math.max(1, change.modifiedStartLineNumber);
}

/** The first change below `line`, wrapping to the first change; `null` when there are none. */
export function nextChangeLine(changes: readonly LineChangeLike[], line: number): number | null {
  if (changes.length === 0) return null;
  const next = changes.find((c) => anchor(c) > line) ?? changes[0];
  return anchor(next);
}

/** The last change above `line`, wrapping to the last change; `null` when there are none. */
export function previousChangeLine(changes: readonly LineChangeLike[], line: number): number | null {
  if (changes.length === 0) return null;
  const previous = [...changes].reverse().find((c) => anchor(c) < line) ?? changes[changes.length - 1];
  return anchor(previous);
}
