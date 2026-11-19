import { Component, computed, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { ElsewhereRequest } from '../sdlc/build/build-page.view-model';

/* The question before a build that may be running in another session starts. Escape and Cancel both cancel; only Start anyway confirms. */
@Component({
  selector: 'app-build-elsewhere-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  templateUrl: './build-elsewhere-dialog.html',
})
export class BuildElsewhereDialog {
  /** What to ask about; the dialog is open exactly while there is one. */
  readonly request = input<ElsewhereRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  /** The time the workflow recorded the start at, as the engineer's clock shows it; null when the record carries none or it cannot be read. */
  protected readonly at = computed<string | null>(() => {
    const since = this.request()?.since ?? '';
    const date = new Date(since);
    return since === '' || Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  /** Escape and the close control both close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.request() !== null) this.cancel.emit();
  }
}
