import { Component, input } from '@angular/core';
import type { BaseCheck } from '@bindings/BaseCheck';

/** One preparation hook of the step, named apart from the checks. */
export interface PreparationRow {
  id: string;
  what: string;
  state: 'running' | 'passed' | 'failed';
  seconds: number | null;
}

/* The two lists the Build tab shows while the base is checked. Stub: the template comes with the behavior. */
@Component({
  selector: 'app-build-checks-list',
  template: '',
})
export class BuildChecksList {
  readonly checks = input.required<BaseCheck[]>();
  readonly base = input('');
  readonly preparation = input<PreparationRow[]>([]);
  readonly now = input(0);
  readonly elsewhere = input(false);
}
