import { Component, computed, input } from '@angular/core';
import type { Mode } from '@bindings/Mode';
import type { RunSettings } from '@bindings/RunSettings';
import { settingRows } from '../core/given/run-preview.view-model';
import { GIVEN_STATUS_LABEL, type RunGiven } from '../lib/events';
import { groupRows, itemKindName, itemSourceLabel, recordedRows, type PresetRow } from '../lib/given';
import { GivenList } from './given-list';

/** The event schema leaves an unset value out; the generated run-settings type spells it null. */
const withValues = (s: RunGiven['settings']): RunSettings =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { source: v.source, value: v.value ?? null }])) as unknown as RunSettings;

/* What a run was given, read-only: every item with its kind, source and the words for its status, the settings and
 * limits the run ran with and where each came from, the names of the environment variables it saw, and the warnings.
 * A run with no record says so and nothing else; it never guesses from today's setup. */
@Component({
  selector: 'app-given-view',
  imports: [GivenList],
  templateUrl: './given-view.html',
  styleUrl: './given-view.css',
})
export class GivenView {
  readonly given = input.required<RunGiven | 'not-recorded'>();
  /** Only the label of a setting the run-spec supplied depends on it ("the job" or "Kata itself"). */
  readonly mode = input<Mode>('workbench');

  protected readonly recorded = computed(() => {
    const g = this.given();
    return g === 'not-recorded' ? null : g;
  });
  protected readonly groups = computed(() => groupRows(recordedRows(this.recorded()?.items ?? [])));
  /** Items Claude reported that Kata's list never held. */
  protected readonly unknown = computed(() => (this.recorded()?.items ?? []).filter((i) => i.source == null));
  protected readonly settings = computed(() => {
    const g = this.recorded();
    return g ? settingRows(withValues(g.settings), this.mode()) : [];
  });
  private readonly statusById = computed(() => new Map((this.recorded()?.items ?? []).map((i) => [i.id, GIVEN_STATUS_LABEL[i.status]])));

  protected readonly statusLabel = (row: PresetRow): string | null => this.statusById().get(row.key) ?? null;
  protected readonly sourceLabel = itemSourceLabel;
  protected readonly kindName = itemKindName;
  protected readonly label = GIVEN_STATUS_LABEL;
}
