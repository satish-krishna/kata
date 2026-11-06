import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { formatWhen } from '../lib/sdlc-workspace';
import type { ChangeOffer } from '@bindings/ChangeOffer';
import type { HomeAction } from '@bindings/HomeAction';
import type { StageLabel } from '@bindings/StageLabel';

/** One line of the home page's change list: a change folder and what the plugin says it shows and offers. */
export type ChangeRow = {
  system: string;
  change: string;
  title: string | null;
  /** The plugin's whole answer for the change; null while a listed row's stage is being read. */
  offer: ChangeOffer | null;
  /** What the row reads; null while it is being read. */
  label: StageLabel | null;
  /** What the row offers first, as the backend decided; null on a legacy row and while being read. */
  action: HomeAction | null;
  /** The read of this row failed. */
  failed: boolean;
};

type Group = { system: string; changes: ChangeRow[] };

/** What a row opens: the change's system and folder name. */
export type OpenedChange = { system: string; change: string };

/* The workspace home's Changes table: the changes on the checked-out branch grouped by system with the stage label the
 * plugin's answer gave each, then a second group of change branches checked out elsewhere, shown by folder name and no stage. */
@Component({
  selector: 'app-changes-table',
  imports: [HlmButtonImports, HlmTableImports],
  templateUrl: './changes-table.html',
})
export class ChangesTable {
  /** Changes on the currently checked-out branch, each with its offer from the plugin's answer. */
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

  protected tone(c: ChangeRow): string {
    const t = c.label?.tone ?? 'muted';
    return t === 'muted' ? 'idle' : t;
  }

  protected lastRun(c: ChangeRow): string {
    const at = this.lastRuns()[`${c.system}/${c.change}`];
    return at === undefined ? '—' : formatWhen(at);
  }
}
