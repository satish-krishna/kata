import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmEmptyHeader],hlm-empty-header',
  exportAs: 'hlmEmptyHeader',
  host: { 'data-slot': 'empty-header' },
})
export class HlmEmptyHeader {
  constructor() {
    classes(() => 'flex flex-col items-center gap-(--space-4)');
  }
}
