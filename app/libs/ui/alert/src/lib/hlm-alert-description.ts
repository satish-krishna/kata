import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDescription]',
  exportAs: 'hlmAlertDescription',
  host: {
    'data-slot': 'alert-description',
  },
})
export class HlmAlertDescription {
  constructor() {
    classes(
      () =>
        'min-w-0 text-inherit',
    );
  }
}
