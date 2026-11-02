import { Component, computed, input, output } from '@angular/core';
import type { DeclareView } from '@bindings/DeclareView';
import type { RecordedPullRequest } from '@bindings/RecordedPullRequest';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

/** A pull request still open on GitHub under a branch name the change no longer uses. */
export type LeftBehind = { repo: string; url: string; branch: string };

/* What declaring the change done came to, in the plugin's own words: the pull requests it opened with their links, the problems it refused with
 * (nothing was pushed), or what it had pushed and opened when it stopped (declaring done again carries on). Declare done again is the one
 * primary action after a part-way failure; a refusal offers a review or another round instead. It also lists the pull requests an earlier
 * branch name left open on GitHub, with or without an answer. */
@Component({
  selector: 'app-pr-list-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  templateUrl: './pr-list-dialog.html',
})
export class PrListDialog {
  /** The plugin's answer; the dialog is open while this is set or something was left behind. */
  readonly view = input<DeclareView | null>(null);
  /** The pull requests an earlier branch name left open on GitHub. */
  readonly leftBehind = input<LeftBehind[]>([]);

  /** A row's address was clicked. */
  readonly openLink = output<string>();
  readonly retry = output<void>();
  readonly runReview = output<void>();
  readonly anotherRound = output<void>();
  readonly close = output<void>();

  protected readonly open = computed(() => this.view() !== null || this.leftBehind().length > 0);

  protected readonly title = computed(() => {
    switch (this.view()?.kind) {
      case 'notReady':
        return 'Declaring done was refused';
      case 'partial':
        return 'Declaring done stopped part way';
      case 'couldNotRun':
        return 'Declaring done could not run';
      default:
        return 'Pull requests';
    }
  });

  /** The pull requests to list: the ones opened, the master's last. */
  protected readonly links = computed<RecordedPullRequest[]>(() => {
    const v = this.view();
    if (v?.kind === 'done') return v.pullRequests;
    return v?.kind === 'partial' ? v.opened : [];
  });

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.close.emit();
  }
}
