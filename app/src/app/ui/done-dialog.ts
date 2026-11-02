import { Component, computed, input, output } from '@angular/core';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTableImports } from '@spartan-ng/helm/table';
import type { DoneReport } from '../lib/sdlc-done';
import { CheckResults } from './check-results';
import { MarkdownBody } from './markdown-body';

/* The confirmation before the plugin is asked to declare the change done: the branch of each repository, what the plugin recorded for its
 * checks and what departed from the plan. It holds nothing back: the plugin verifies the change, pushes and opens the pull requests, and its answer
 * (a refusal, a part-way failure) is shown afterwards. Open pull requests is the one primary action. */
@Component({
  selector: 'app-done-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmTableImports, CheckResults, MarkdownBody],
  templateUrl: './done-dialog.html',
})
export class DoneDialog {
  /** What to show; the dialog is open exactly while this is set. */
  readonly report = input.required<DoneReport | null>();
  /** The change folder, which names the branch in every repository. */
  readonly change = input.required<string>();

  readonly confirm = output<void>();
  readonly cancel = output<void>();

  /** The checks the plugin recorded, one for each repository that has them. */
  protected readonly checks = computed<RepoCheckView[]>(() => (this.report()?.repos ?? []).flatMap((r) => (r.view === null ? [] : [r.view])));

  /** Escape closes the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.report() !== null) this.cancel.emit();
  }
}
