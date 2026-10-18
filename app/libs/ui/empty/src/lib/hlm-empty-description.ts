import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmEmptyDescription]',
  exportAs: 'hlmEmptyDescription',
  host: { 'data-slot': 'empty-description' },
})
export class HlmEmptyDescription {
  constructor() {
    classes(
      () =>
        'text-inherit',
    );
  }
}
