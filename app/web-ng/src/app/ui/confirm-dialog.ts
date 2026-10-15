import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

@Component({
  selector: 'app-confirm-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" [attr.aria-label]="message()">
        <div hlmDialogTitle>{{ message() }}</div>
        <hlm-dialog-footer>
          <button hlmBtn variant="ghost" size="sm" type="button" (click)="cancel.emit()">Cancel</button>
          <button hlmBtn variant="primary" size="sm" type="button" (click)="confirm.emit()">{{ confirmLabel() }}</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ConfirmDialog {
  readonly open = input.required<boolean>();
  readonly message = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
