import { Directive } from '@angular/core';
import { BrnLabel } from '@spartan-ng/brain/label';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmLabel]',
  hostDirectives: [{ directive: BrnLabel, inputs: ['id', 'for'] }],
  host: { 'data-slot': 'label' },
})
export class HlmLabel {
  constructor() {
    classes(
      () =>
        'flex items-center select-none gap-(--space-2) font-sans font-medium text-[length:var(--text-sm)] leading-none text-(color:--text-secondary) [&_code]:font-mono [&_code]:font-normal [&_code]:leading-(--leading-code) [&_code]:text-(color:--text-faint) group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
    );
  }
}
