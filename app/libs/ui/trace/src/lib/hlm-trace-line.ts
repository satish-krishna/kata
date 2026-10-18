import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmTraceLine],hlm-trace-line',
  exportAs: 'hlmTraceLine',
  host: { 'data-slot': 'trace-line', '[attr.data-status]': 'status()' },
})
export class HlmTraceLine {
  public readonly status = input<'ok' | 'running' | 'error' | 'pending'>();

  constructor() {
    classes(() => 'flex w-full min-w-0 items-center');
  }
}
