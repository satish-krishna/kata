import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { formatWhen } from '../lib/sdlc-workspace';
import { changeLabel } from '../lib/sdlc';
import type { ChangeRow } from '../core/sdlc/sdlc-stages.store';

type Group = { system: string; changes: ChangeRow[] };

/** What a row opens: the change's system and folder name. */
export type OpenedChange = { system: string; change: string };

/* The workspace home's Changes table: the changes on the checked-out branch grouped by system with their stage,
 * then a second group of change branches checked out elsewhere, shown by folder name and no stage. A change whose
 * stage is not read yet says Reading in its place; a stage read earlier in this session shows as it was, marked
 * as being checked while a pass reads it again. */
@Component({
  selector: 'app-changes-table',
  imports: [HlmButtonImports, HlmTableImports],
  templateUrl: './changes-table.html',
})
export class ChangesTable {
  /** Changes on the currently checked-out branch, each with what this session has read of it. */
  readonly rows = input.required<ChangeRow[]>();
  /** Change folder names of change branches that are not checked out. */
  readonly others = input.required<string[]>();
  /** Latest run start (epoch seconds) per `<system>/<change>`. */
  readonly lastRuns = input<Record<string, number>>({});
  readonly disabled = input(false);

  readonly open = output<OpenedChange>();
  readonly openOther = output<string>();

  protected readonly groups = computed<Group[]>(() => {
    const bySystem = new Map<string, ChangeRow[]>();
    for (const c of this.rows()) bySystem.set(c.system, [...(bySystem.get(c.system) ?? []), c]);
    return [...bySystem].map(([system, changes]) => ({ system, changes }));
  });

  /** What the Stage cell says: the stage, the error that stopped the read, or Reading when nothing is known yet. */
  protected label(c: ChangeRow): string {
    if (c.info !== null) return changeLabel(c.info).text;
    return c.error ?? 'Reading';
  }

  protected tone(c: ChangeRow): string {
    if (c.info === null) return c.error === null ? 'idle' : 'error';
    const t = changeLabel(c.info).tone;
    return t === 'muted' ? 'idle' : t;
  }

  protected lastRun(c: ChangeRow): string {
    const at = this.lastRuns()[`${c.system}/${c.change}`];
    return at === undefined ? '—' : formatWhen(at);
  }
}
