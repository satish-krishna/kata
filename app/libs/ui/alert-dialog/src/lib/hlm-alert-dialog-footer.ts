import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDialogFooter],hlm-alert-dialog-footer',
  exportAs: 'hlmAlertDialogFooter',
  host: { 'data-slot': 'alert-dialog-footer' },
})
export class HlmAlertDialogFooter {
  constructor() {
    classes(
      () =>
        'flex items-center justify-end gap-(--space-3)',
    );
  }
}
