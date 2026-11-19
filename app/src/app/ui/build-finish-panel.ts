import { Component, input, output } from '@angular/core';
import type { StartChecks } from '@bindings/StartChecks';

/* A failure at a repository's build finish, shown once on the Build tab. */
@Component({
  selector: 'app-build-finish-panel',
  templateUrl: './build-finish-panel.html',
})
export class BuildFinishPanel {
  readonly start = input.required<StartChecks>();
  /** The engineer asked to run the checks again. */
  readonly rerun = output<void>();
  /** The output text the engineer asked to copy. */
  readonly copy = output<string>();
}
