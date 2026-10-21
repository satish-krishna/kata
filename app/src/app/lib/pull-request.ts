/** The number at the end of a GitHub pull request address, or null when the address does not end in one. */
export function prNumber(url: string): string | null {
  const m = /\/pull\/(\d+)\/?$/.exec(url);
  return m === null ? null : m[1];
}
