import { Component, input, output } from '@angular/core';
import type { AcceptRequest } from '../sdlc/build/build-page.view-model';

/* The confirmation before a failing check is accepted for this build (stub: the template is empty until the behavior is written). */
@Component({
  selector: 'app-accept-check-dialog',
  host: { class: 'contents' },
  templateUrl: './accept-check-dialog.html',
})
export class AcceptCheckDialog {
  readonly request = input<AcceptRequest | null>(null);
  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
