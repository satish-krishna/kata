import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmDialogFooter],hlm-dialog-footer',
  host: { 'data-slot': 'dialog-footer' },
})
export class HlmDialogFooter {
  constructor() {
    classes(() => 'flex items-center justify-end gap-(--space-3)');
  }
}
