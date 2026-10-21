/** A repository path split into its folder (empty at the root) and its file name. */
export function splitPath(path: string): { folder: string; name: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { folder: '', name: path } : { folder: path.slice(0, at), name: path.slice(at + 1) };
}

/** A branch for a header: a change branch is cut to `change/…`, and the base follows when it is known. The title keeps all of it. */
export function branchLabel(branch: string, base: string | null): { text: string; title: string } {
  const shown = branch.startsWith('change/') ? 'change/…' : branch;
  return base === null ? { text: shown, title: branch } : { text: `${shown} → ${base}`, title: `${branch} → ${base}` };
}
