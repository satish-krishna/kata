import { Directive, input } from '@angular/core';
import { BrnTabs } from '@spartan-ng/brain/tabs';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmTabs],hlm-tabs',
  hostDirectives: [
    {
      directive: BrnTabs,
      inputs: ['orientation', 'activationMode', 'brnTabs: tab'],
      outputs: ['tabActivated'],
    },
  ],
  host: {
    'data-slot': 'tabs',
  },
})
export class HlmTabs {
  public readonly tab = input.required<string>();
  /** `bare` emits no classes, so a Kata class (`.k-step`, ...) supplies the whole look, as `hlmBtn variant="bare"` does. */
  public readonly variant = input<'default' | 'bare'>('default');

  constructor() {
    classes(() => (this.variant() === 'bare' ? '' : 'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col'));
  }
}
