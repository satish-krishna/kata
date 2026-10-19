import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';

@Component({
  selector: 'app-confirm-dialog',
  host: { class: 'contents' },
  imports: [HlmAlertDialogImports],
  templateUrl: './confirm-dialog.html',
})
export class ConfirmDialog {
  readonly open = input.required<boolean>();
  readonly message = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  /** Cancel and Escape both close the overlay from inside; surface that as cancel. A click outside does not close an alert dialog. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
