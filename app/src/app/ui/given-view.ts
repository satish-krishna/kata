import { Component, input } from '@angular/core';
import type { Mode } from '@bindings/Mode';
import type { RunGiven } from '../lib/events';

/* What a run was given, read-only: stub. */
@Component({
  selector: 'app-given-view',
  templateUrl: './given-view.html',
})
export class GivenView {
  readonly given = input.required<RunGiven | 'not-recorded'>();
  readonly mode = input<Mode>('workbench');
}
