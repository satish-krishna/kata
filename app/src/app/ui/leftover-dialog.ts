import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { Leftovers } from '@bindings/Leftovers';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

/** One repository's report as the dialog shows it. */
export type RepoReport = { repo: string; data: Leftovers };
/** The files of one repository the operator chose to discard. */
export type RepoChoice = { repo: string; paths: string[] };

/** An `intent.md` or `spec.md` is the PO's interview in progress: discarding it loses the session. */
const DRAFTS = new Set(['intent.md', 'spec.md']);
const isDraft = (path: string): boolean => DRAFTS.has(path.split(/[\\/]/).pop() ?? '');

/* What a run left behind, one section per repository: commits that landed, files that can be discarded (with a
 * checkbox each), files already dirty that the run touched (no checkbox: kata cannot tell whose edits they are)
 * and a warning for product repos that changed or could not be checked. Each repository keeps its own selection.
 * Nothing outside the checked list is ever discarded. */
@Component({
  selector: 'app-leftover-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmCheckbox],
  templateUrl: './leftover-dialog.html',
})
export class LeftoverDialog {
  /** What to show; the dialog is open exactly while this is set. */
  readonly leftovers = input.required<RepoReport[] | null>();
  /** The edits are a build's: the dialog is titled for the build and its close button says Keep all. */
  readonly build = input(false);

  readonly discard = output<RepoChoice[]>();
  readonly close = output<void>();

  /** The checked paths of each repository. Restarts from the pre-checked set whenever a new report arrives. */
  protected readonly selected = linkedSignal<RepoReport[] | null, ReadonlyMap<string, ReadonlySet<string>>>({
    source: this.leftovers,
    computation: (reports) =>
      new Map((reports ?? []).map((r) => [r.repo, new Set(r.data.discardable.filter((p) => !isDraft(p)))] as const)),
  });

  /** Repositories are named when there is more than one to tell apart. */
  protected readonly named = computed(() => this.build() || (this.leftovers()?.length ?? 0) > 1);

  /** The checked paths per repository, in the order the reports list them; a repository with none checked is left out. */
  protected readonly chosen = computed<RepoChoice[]>(() =>
    (this.leftovers() ?? [])
      .map((r) => ({ repo: r.repo, paths: r.data.discardable.filter((p) => this.selected().get(r.repo)?.has(p)) }))
      .filter((c) => c.paths.length > 0),
  );

  protected readonly count = computed(() => this.chosen().reduce((n, c) => n + c.paths.length, 0));

  protected isChecked(repo: string, path: string): boolean {
    return this.selected().get(repo)?.has(path) ?? false;
  }

  protected label(repo: string, path: string): string {
    return this.named() ? `${repo} ${path}` : path;
  }

  protected toggle(repo: string, path: string, on: boolean): void {
    this.selected.update((all) => {
      const next = new Set(all.get(repo));
      if (on) next.add(path);
      else next.delete(path);
      return new Map(all).set(repo, next);
    });
  }

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.leftovers()) this.close.emit();
  }
}
