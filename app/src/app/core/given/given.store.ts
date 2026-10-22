import { Injectable, signal } from '@angular/core';
import type { PresetRow } from '../../lib/given';

export type BuildChoices = { off: ReadonlySet<string> };

/** Where the session's and each build's choices are kept: in memory only, gone when the Workbench closes. */
@Injectable({ providedIn: 'root' })
export class GivenStore {
  private readonly keys = signal<ReadonlySet<string>>(new Set());
  private readonly builds = new Map<string, BuildChoices>();

  /** Keys switched off this session. Each change replaces the set, so a snapshot a caller holds never changes. */
  readonly session = this.keys.asReadonly();

  /**
   * Record the choices shown in a preview: a switchable row's key is added when off and removed when on.
   * Keys of items the preview does not list are left alone. The rows already carry their keys
   * (`givenKey` of the workdir they were resolved in), so `workdir` is not used to recompute them.
   */
  remember(rows: readonly PresetRow[], _workdir: string): void {
    const next = new Set(this.keys());
    for (const row of rows) {
      if (row.locked !== null || row.item.brought_by !== null) continue;
      if (row.off) next.add(row.key);
      else next.delete(row.key);
    }
    this.keys.set(next);
  }

  build(key: string): BuildChoices | null {
    return this.builds.get(key) ?? null;
  }

  setBuild(key: string, choices: BuildChoices): void {
    this.builds.set(key, { off: new Set(choices.off) });
  }
}
