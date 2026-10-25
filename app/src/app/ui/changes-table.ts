import { Component, computed, input, output } from '@angular/core';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { formatWhen } from '../lib/sdlc-workspace';
import { changeLabel } from '../lib/sdlc';

type Group = { system: string; changes: ChangeInfo[] };

/* The workspace home's Changes table: the changes on the checked-out branch grouped by system with their stage,
 * then a second group of change branches checked out elsewhere, shown by folder name and no stage. */
@Component({
  selector: 'app-changes-table',
  imports: [HlmButtonImports, HlmTableImports],
  templateUrl: './changes-table.html',
})
export class ChangesTable {
  /** Changes on the currently checked-out branch. */
  readonly changes = input.required<ChangeInfo[]>();
  /** Change folder names of change branches that are not checked out. */
  readonly others = input.required<string[]>();
  /** Latest run start (epoch seconds) per `<system>/<change>`. */
  readonly lastRuns = input<Record<string, number>>({});
  readonly disabled = input(false);

  readonly open = output<ChangeInfo>();
  readonly openOther = output<string>();

  protected readonly groups = computed<Group[]>(() => {
    const bySystem = new Map<string, ChangeInfo[]>();
    for (const c of this.changes()) bySystem.set(c.system, [...(bySystem.get(c.system) ?? []), c]);
    return [...bySystem].map(([system, changes]) => ({ system, changes }));
  });

  protected label(c: ChangeInfo): string {
    return changeLabel(c).text;
  }

  protected tone(c: ChangeInfo): string {
    const t = changeLabel(c).tone;
    return t === 'muted' ? 'idle' : t;
  }

  protected lastRun(c: ChangeInfo): string {
    const at = this.lastRuns()[`${c.system}/${c.change}`];
    return at === undefined ? '—' : formatWhen(at);
  }
}
