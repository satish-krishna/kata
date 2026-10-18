import { Directive } from '@angular/core';
import { BrnAlertDialogTitle } from '@spartan-ng/brain/alert-dialog';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDialogTitle]',
  exportAs: 'hlmAlertDialogTitle',
  hostDirectives: [BrnAlertDialogTitle],
  host: { 'data-slot': 'alert-dialog-title' },
})
export class HlmAlertDialogTitle {
  constructor() {
    classes(
      () =>
        'font-sans font-semibold text-[length:var(--text-base)] leading-none text-(color:--text-primary)',
    );
  }
}
