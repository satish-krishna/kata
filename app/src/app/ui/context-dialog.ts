import { Component, computed, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { parseFrontMatter } from '../lib/sdlc';
import { contextAction, contextLabel, type ContextView, type RepoRow } from '../lib/sdlc-workspace';
import { DocLayout } from './doc-layout';

/* The context viewer: the workspace's product repos down the left, each with its context state, and the picked repo's
 * `intent/<system>/context/<repo>.md` read-only on the right, in the same document layout the change page uses (its
 * outline, the text, and the front matter in the rail). Run or Refresh context is the one primary action. */
@Component({
  selector: 'app-context-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, DocLayout],
  templateUrl: './context-dialog.html',
})
export class ContextDialog {
  /** What to show; the dialog is open exactly while this is set. */
  readonly view = input.required<ContextView | null>();
  readonly disabled = input(false);

  readonly pick = output<string>();
  readonly runContext = output<string>();
  readonly close = output<void>();

  protected readonly picked = computed(() => {
    const v = this.view();
    return v ? (v.rows.find((r) => r.name === v.repo) ?? null) : null;
  });
  protected readonly doc = computed(() => {
    const text = this.view()?.text;
    return typeof text === 'string' ? parseFrontMatter(text) : null;
  });
  protected readonly action = computed(() => contextAction(this.picked()?.context ?? null));

  protected state(r: RepoRow) {
    return contextLabel(r.context);
  }

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.view() !== null) this.close.emit();
  }
}
