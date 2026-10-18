import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmTraceDescription],hlm-trace-description',
  exportAs: 'hlmTraceDescription',
  host: { 'data-slot': 'trace-description' },
})
export class HlmTraceDescription {
  constructor() {
    classes(() => 'shrink-0');
  }
}
