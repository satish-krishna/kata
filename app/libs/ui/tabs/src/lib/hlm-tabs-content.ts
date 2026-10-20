import { Directive, input } from '@angular/core';
import { BrnTabsContent } from '@spartan-ng/brain/tabs';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmTabsContent]',
  hostDirectives: [{ directive: BrnTabsContent, inputs: ['brnTabsContent: hlmTabsContent'] }],
  host: {
    'data-slot': 'tabs-content',
  },
})
export class HlmTabsContent {
  public readonly contentFor = input.required<string>({ alias: 'hlmTabsContent' });
  /** `bare` emits no classes, so a Kata class (`.k-step`, ...) supplies the whole look, as `hlmBtn variant="bare"` does. */
  public readonly variant = input<'default' | 'bare'>('default');

  constructor() {
    classes(() => (this.variant() === 'bare' ? '' : 'flex-1 text-sm outline-none'));
  }
}
