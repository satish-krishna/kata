// When a change is finished, defined once for `state` and `list` (GRAMMAR.md, "Listing a system's changes"): its intent is
// rejected in `HEAD`, or it has no change copy and its intent is on the master's base branch.
import { join } from 'node:path';
import { copiesFolder } from '../events/context.ts';
import { baseBranch } from '../git/git.ts';
import { real } from '../workspace/resolve.ts';
import { statusOf } from './fix-state.ts';
import type { Placement } from './place.ts';
import type { SystemRead } from './system-read.ts';

export type Finished = null | 'rejected' | 'merged';

/**
 * Per placed change: `rejected` when the intent's `status` in the `HEAD` of its holder is `rejected`; else `merged` when
 * no change copy exists for it and its intent is in the tree of the master's base branch, local or the remote's copy;
 * else null. Rejected is checked first. Without a base branch nothing is merged. All base lookups are one git process.
 */
export function finishedOf(p: Placement): Map<string, Finished> {
  const out = new Map<string, Finished>();
  const masterRead = p.reads.get(p.master) as SystemRead;
  for (const [top, read] of p.reads) read.loadTexts(p.placed.filter((c) => c.top === top).map((c) => `intent/${p.system}/${c.change}/intent.md`));

  const base = baseBranch(p.master);
  const onBase = (change: string): string[] =>
    base === null ? [] : [`refs/heads/${base}`, `refs/remotes/origin/${base}`].map((rev) => `${rev}:intent/${p.system}/${change}/intent.md`);
  const open: string[] = [];
  for (const { change, top } of p.placed) {
    const path = `intent/${p.system}/${change}/intent.md`;
    const text = (p.reads.get(top) as SystemRead).headText(path);
    if (text !== null && statusOf(text, `HEAD:${path}`) === 'rejected') {
      out.set(change, 'rejected');
    } else {
      out.set(change, null);
      if (!p.copies.includes(real(join(copiesFolder(p.workspace), change)))) open.push(change);
    }
  }
  masterRead.resolve(open.flatMap(onBase));
  for (const change of open) if (onBase(change).some((name) => masterRead.objectOf(name) !== null)) out.set(change, 'merged');
  return out;
}
