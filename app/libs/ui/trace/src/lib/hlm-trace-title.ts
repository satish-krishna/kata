import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmTraceTitle],hlm-trace-title',
  exportAs: 'hlmTraceTitle',
  host: { 'data-slot': 'trace-title' },
})
export class HlmTraceTitle {
  constructor() {
    classes(() => 'min-w-0 truncate');
  }
}
