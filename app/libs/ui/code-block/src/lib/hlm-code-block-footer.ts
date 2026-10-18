import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmCodeBlockFooter],hlm-code-block-footer',
  exportAs: 'hlmCodeBlockFooter',
  host: { 'data-slot': 'code-block-footer' },
})
export class HlmCodeBlockFooter {
  constructor() {
    classes(
      () =>
        'px-(--space-3) pb-(--space-2) font-mono text-[length:var(--text-2xs)] text-(color:--text-faint) flex min-w-0 shrink-0 items-center gap-(--space-2)',
    );
  }
}
