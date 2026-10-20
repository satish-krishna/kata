import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';

/* Why a build did not start. Nothing was created by then, and the dialog says so. */
@Component({
  selector: 'app-build-refusal-dialog',
  host: { class: 'contents' },
  imports: [HlmAlertDialogImports, HlmAlertImports, NgIcon],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './build-refusal-dialog.html',
})
export class BuildRefusalDialog {
  /** The refusal text; the dialog is open exactly while this is set. */
  readonly reason = input.required<string | null>();
  readonly close = output<void>();

  /** Close and Escape both close the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.reason() !== null) this.close.emit();
  }
}
