import { Directive } from '@angular/core';
import { BrnToggleGroup } from '@spartan-ng/brain/toggle-group';
import { classes } from '@spartan-ng/helm/utils';
import { provideHlmToggleGroup } from './hlm-toggle-group.token';

// Kata's segmented control (`.k-seg`): an inset track holding mono options.
@Directive({
  selector: '[hlmToggleGroup],hlm-toggle-group',
  providers: [provideHlmToggleGroup(HlmToggleGroup)],
  hostDirectives: [
    {
      directive: BrnToggleGroup,
      inputs: ['type', 'value', 'nullable', 'disabled'],
      outputs: ['valueChange'],
    },
  ],
  host: { 'data-slot': 'toggle-group' },
})
export class HlmToggleGroup {
  constructor() {
    classes(
      () =>
        'inline-flex p-(--space-1) gap-(--space-1) bg-(--surface-inset) border border-(--border-default) rounded-(--radius-sm)',
    );
  }
}
