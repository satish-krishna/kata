import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown } from '@ng-icons/lucide';
import { BrnMessageScrollerButton } from '@spartan-ng/brain/message-scroller';
import { HlmButton, provideBrnButtonConfig } from '@spartan-ng/helm/button';

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector -- attribute selector on native button
  selector: 'button[hlmMessageScrollerButton]',
  exportAs: 'hlmMessageScrollerButton',
  imports: [NgIcon],
  providers: [
    provideIcons({ lucideArrowDown }),
    provideBrnButtonConfig({ variant: 'secondary', size: 'icon-sm' }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [
    { directive: HlmButton, inputs: ['variant', 'size'] },
    {
      directive: BrnMessageScrollerButton,
      inputs: ['direction', 'behavior', 'aria-label'],
    },
  ],
  host: {
    'data-slot': 'message-scroller-button',
  },
  template: `
    <ng-icon name="lucideArrowDown" />
    <span class="sr-only">{{ _brn.resolvedAriaLabel() }}</span>
  `,
})
export class HlmMessageScrollerButton {
  private readonly _button = inject(HlmButton);
  protected readonly _brn = inject(BrnMessageScrollerButton);

  constructor() {
    this._button.setClass(
      'absolute inset-s-1/2 -translate-x-1/2 shadow-(--shadow-sm) transition-[translate,scale,opacity] duration-(--dur-base) data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-(--dur-fast) data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-(--ease-out) data-[direction=end]:bottom-(--space-5) data-[direction=start]:top-(--space-5) rtl:translate-x-1/2 data-[direction=start]:[&_ng-icon]:rotate-180',
    );
  }
}
