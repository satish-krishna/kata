import { Component, input, output } from '@angular/core';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';

@Component({
  selector: 'app-build-refusal-dialog',
  host: { class: 'contents' },
  imports: [HlmAlertDialogImports],
  templateUrl: './build-refusal-dialog.html',
})
export class BuildRefusalDialog {
  readonly reason = input.required<string | null>();
  readonly close = output<void>();
}
