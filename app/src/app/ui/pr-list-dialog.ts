import { Component, computed, input, output } from '@angular/core';
import type { PrResult } from '@bindings/PrResult';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

type Row = { repo: string; tone: 'success' | 'error'; label: string; url: string | null; error: string | null };

/* What opening the pull requests came to: one row per repository with its address, or why it failed. Retry is the
 * one primary action while any failed; once every pull request is open Close takes its place. */
@Component({
  selector: 'app-pr-list-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  templateUrl: './pr-list-dialog.html',
})
export class PrListDialog {
  /** The results to show, in order; the dialog is open exactly while this is set. */
  readonly results = input.required<PrResult[] | null>();

  /** A row's address was clicked. */
  readonly openLink = output<string>();
  readonly retry = output<void>();
  readonly close = output<void>();

  protected readonly rows = computed<Row[]>(() =>
    (this.results() ?? []).map(({ repo, outcome }) => {
      switch (outcome.kind) {
        case 'opened':
          return { repo, tone: 'success', label: 'opened', url: outcome.url, error: null };
        case 'reused':
          return { repo, tone: 'success', label: 'already open, reused', url: outcome.url, error: null };
        case 'failed':
          return { repo, tone: 'error', label: 'failed', url: null, error: outcome.error };
        case 'clash':
          return { repo, tone: 'error', label: 'failed', url: null, error: `${outcome.branch} is taken on GitHub` };
      }
    }),
  );
  protected readonly anyFailed = computed(() => this.rows().some((r) => r.tone === 'error'));

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.results() !== null) this.close.emit();
  }
}
