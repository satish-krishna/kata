import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import type { RunningLine } from '../../bindings/RunningLine';

@Component({
  selector: 'app-close-dialog',
  host: { class: 'contents' },
  imports: [HlmAlertDialogImports],
  templateUrl: './close-dialog.html',
})
export class CloseDialog {
  /** The running changes the backend named; none means the question is not open. */
  readonly running = input<RunningLine[] | null>(null);
  readonly stopAll = output<void>();
  readonly keepWorking = output<void>();

  /** Keep working, and Escape, both close the overlay from inside; surface either as keeping on. A click outside does not close an alert dialog. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.running() !== null) this.keepWorking.emit();
  }
}
