import { Component, input, output } from '@angular/core';
import type { InstructionsState } from '@bindings/InstructionsState';

/* The workspace home's instructions row: whether this machine's copy of the workspace instructions matches the
 * master's, with an offer to write or refresh them. */
@Component({
  selector: 'app-instructions-row',
  templateUrl: './instructions-row.html',
})
export class InstructionsRow {
  readonly state = input.required<InstructionsState>();
  readonly disabled = input(false);

  readonly refresh = output<void>();
}
