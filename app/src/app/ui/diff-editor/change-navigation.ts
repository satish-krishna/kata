/** The part of Monaco's ILineChange that navigation reads. */
export interface LineChangeLike {
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

export function nextChangeLine(_changes: readonly LineChangeLike[], _line: number): number | null {
  return null;
}

export function previousChangeLine(_changes: readonly LineChangeLike[], _line: number): number | null {
  return null;
}
