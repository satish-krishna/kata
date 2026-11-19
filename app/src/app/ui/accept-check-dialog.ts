import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { AcceptRequest } from '../sdlc/build/build-page.view-model';

/* The confirmation before one failing check is accepted for this build: it names the check and the base commit and says what the
 * acceptance lets through. Escape and Cancel both cancel; only Accept confirms. */
@Component({
  selector: 'app-accept-check-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  templateUrl: './accept-check-dialog.html',
})
export class AcceptCheckDialog {
  /** What to confirm; the dialog is open exactly while there is one. */
  readonly request = input<AcceptRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  /** Escape and the close control both close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.request() !== null) this.cancel.emit();
  }
}
