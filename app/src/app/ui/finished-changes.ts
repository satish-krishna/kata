import { Component, input, output } from '@angular/core';
import type { FinishedChange } from '@bindings/FinishedChange';

/* The home's folded list of the changes the workflow finished: merged or rejected. */
@Component({
  selector: 'app-finished-changes',
  templateUrl: './finished-changes.html',
})
export class FinishedChanges {
  /** The finished changes, newest first, as the backend listed them. */
  readonly finished = input.required<FinishedChange[]>();
  /** How many changes the system has finished; nothing shows at 0. */
  readonly count = input.required<number>();
  /** The engineer picked a finished change by its folder name. */
  readonly open = output<string>();
}
