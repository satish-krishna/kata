import { Component, computed, input, output } from '@angular/core';
import type { PrEntry } from '@bindings/PrEntry';
import type { PrResult } from '@bindings/PrResult';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

type Row = { repo: string; tone: 'success' | 'error'; label: string; url: string | null; error: string | null; clash: string | null };

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
  /** The pull requests an earlier branch name left open on GitHub. */
  readonly leftBehind = input<PrEntry[]>([]);
  readonly renameBranch = output<string>();
  readonly retry = output<void>();
  readonly close = output<void>();

  protected readonly rows = computed<Row[]>(() =>
    (this.results() ?? []).map(({ repo, outcome }) => {
      switch (outcome.kind) {
        case 'opened':
          return { repo, tone: 'success', label: 'opened', url: outcome.url, error: null, clash: null };
        case 'reused':
          return { repo, tone: 'success', label: 'already open, reused', url: outcome.url, error: null, clash: null };
        case 'failed':
          return { repo, tone: 'error', label: 'failed', url: null, error: outcome.error, clash: null };
        case 'clash':
          return { repo, tone: 'error', label: 'branch taken', url: null, error: `${outcome.branch} is taken on GitHub in ${repo}`, clash: outcome.branch };
      }
    }),
  );
  protected readonly anyFailed = computed(() => this.rows().some((r) => r.tone === 'error'));
  /** The branch a repository's push clashed with, when one did: Retry cannot help, a new name can. */
  protected readonly clash = computed(() => this.rows().find((r) => r.clash !== null)?.clash ?? null);

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.results() !== null) this.close.emit();
  }
}
