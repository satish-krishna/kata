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
  template: `
    <hlm-dialog [state]="leftovers() ? 'open' : 'closed'" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        @if (leftovers(); as l) {
          <div hlmDialogTitle>What the run left behind</div>
          <div class="k-left">
            @if (l.new_commits.length > 0) {
              <section class="k-left__group" aria-label="Commits that landed">
                <h3 class="k-left__head">Committed during the run</h3>
                <ul class="k-left__list">
                  @for (c of l.new_commits; track $index) {
                    <li class="k-mono">{{ c }}</li>
                  }
                </ul>
              </section>
            }
            @if (l.discardable.length > 0) {
              <section class="k-left__group" aria-label="Files that can be discarded">
                <h3 class="k-left__head">Uncommitted files from this run</h3>
                <ul class="k-left__list">
                  @for (p of l.discardable; track p) {
                    <li class="k-left__row">
                      <hlm-checkbox [aria-label]="p" [checked]="selected().has(p)" (checkedChange)="toggle(p, $event)" />
                      <span class="k-mono">{{ p }}</span>
                    </li>
                  }
                </ul>
                <p class="k-left__note">An intent or spec draft is never pre-checked: discarding it loses the interview.</p>
              </section>
            }
            @if (l.touched_dirty.length > 0) {
              <section class="k-left__group" aria-label="Files changed before and during the run">
                <h3 class="k-left__head">Left alone</h3>
                <ul class="k-left__list">
                  @for (p of l.touched_dirty; track p) {
                    <li class="k-left__row"><span class="k-mono">{{ p }}</span><span class="k-left__tag">changed before and during this run</span></li>
                  }
                </ul>
              </section>
            }
            @for (repo of l.product_repos_changed; track repo) {
              <p class="k-left__warn">the run changed files in {{ repo }}; ai-sdlc should not write there</p>
            }
            @for (repo of l.product_repos_unchecked; track repo) {
              <p class="k-left__warn">could not check {{ repo }}</p>
            }
          </div>
          <hlm-dialog-footer>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="close.emit()">Close</button>
            <button
              hlmBtn
              variant="danger"
              size="sm"
              type="button"
              [disabled]="chosen().length === 0"
              (click)="discard.emit(chosen())"
            >Discard selected ({{ chosen().length }})</button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
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
