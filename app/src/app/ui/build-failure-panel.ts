import { Component, input, output } from '@angular/core';
import type { StartChecks } from '@bindings/StartChecks';
import type { AcceptRefusal } from '../sdlc/build/build-page.view-model';

/* Why the build did not start, shown once on the Build tab (stub: the template is empty until the behavior is written). */
@Component({
  selector: 'app-build-failure-panel',
  templateUrl: './build-failure-panel.html',
})
export class BuildFailurePanel {
  readonly start = input.required<StartChecks>();
  readonly refusal = input<AcceptRefusal | null>(null);
  /** The check the engineer asked to accept. */
  readonly accept = output<string>();
  /** The output text the engineer asked to copy. */
  readonly copy = output<string>();
}
