import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { Leftovers } from '@bindings/Leftovers';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

/** An `intent.md` or `spec.md` is the PO's interview in progress: discarding it loses the session. */
const DRAFTS = new Set(['intent.md', 'spec.md']);
const isDraft = (path: string): boolean => DRAFTS.has(path.split(/[\\/]/).pop() ?? '');

/* What a run that did not succeed left behind: commits that landed, files that can be discarded (with a
 * checkbox each), files already dirty that the run touched (no checkbox: kata cannot tell whose edits they are)
 * and a warning for product repos that changed or could not be checked. Nothing outside the checked list is ever discarded. */
@Component({
  selector: 'app-leftover-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmCheckbox],
  templateUrl: './leftover-dialog.html',
})
export class LeftoverDialog {
  /** What to show; the dialog is open exactly while this is set. */
  readonly leftovers = input.required<Leftovers | null>();

  readonly discard = output<string[]>();
  readonly close = output<void>();

  /** The checked paths. Restarts from the pre-checked set whenever a new report arrives. */
  protected readonly selected = linkedSignal<Leftovers | null, Set<string>>({
    source: this.leftovers,
    computation: (l) => new Set((l?.discardable ?? []).filter((p) => !isDraft(p))),
  });

  /** The checked paths, in the order the report lists them. */
  protected readonly chosen = computed(() => (this.leftovers()?.discardable ?? []).filter((p) => this.selected().has(p)));

  protected toggle(path: string, on: boolean): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.leftovers()) this.close.emit();
  }
}
