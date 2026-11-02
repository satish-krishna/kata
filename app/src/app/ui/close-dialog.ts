import { Component, input, output } from '@angular/core';
import type { RunningLine } from '../../bindings/RunningLine';

@Component({
  selector: 'app-close-dialog',
  host: { class: 'contents' },
  templateUrl: './close-dialog.html',
})
export class CloseDialog {
  /** The running changes the backend named; none means the question is not open. */
  readonly running = input<RunningLine[] | null>(null);
  readonly stopAll = output<void>();
  readonly keepWorking = output<void>();
}
