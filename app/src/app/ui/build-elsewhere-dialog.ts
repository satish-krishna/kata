import { Component, input, output } from '@angular/core';
import type { ElsewhereRequest } from '../sdlc/build/build-page.view-model';

/* The question before a build that may be running in another session starts. Escape and Cancel both cancel; only Start anyway confirms. */
@Component({
  selector: 'app-build-elsewhere-dialog',
  host: { class: 'contents' },
  templateUrl: './build-elsewhere-dialog.html',
})
export class BuildElsewhereDialog {
  /** What to ask about; the dialog is open exactly while there is one. */
  readonly request = input<ElsewhereRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
