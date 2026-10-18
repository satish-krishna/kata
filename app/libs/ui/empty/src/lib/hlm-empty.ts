import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmEmpty],hlm-empty',
  exportAs: 'hlmEmpty',
  host: { 'data-slot': 'empty' },
})
export class HlmEmpty {
  constructor() {
    classes(
      () =>
        'm-auto flex flex-col items-center gap-(--space-4) p-(--space-12) text-center text-(--text-faint)',
    );
  }
}
