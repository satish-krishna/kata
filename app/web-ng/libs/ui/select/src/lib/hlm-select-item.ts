import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import { BrnSelectItem } from '@spartan-ng/brain/select';
import { classes } from '@spartan-ng/helm/utils';

@Component({
  selector: 'hlm-select-item',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: BrnSelectItem, inputs: ['id', 'disabled', 'value'] }],
  host: { 'data-slot': 'select-item' },
  template: `
    <ng-content />
    @if (_active()) {
      <ng-icon
        name="lucideCheck"
        class="absolute end-(--space-3) flex items-center justify-center text-[length:var(--icon-size)]"
        aria-hidden="true"
      />
    }
  `,
})
export class HlmSelectItem {
  private readonly _brnSelectItem = inject(BrnSelectItem);

  protected readonly _active = this._brnSelectItem.active;

  constructor() {
    classes(
      () =>
        'relative flex w-full cursor-default items-center outline-hidden select-none gap-(--space-3) py-(--space-2) ps-(--space-4) pe-(--space-8) rounded-(--radius-xs) text-[length:var(--text-base)] data-highlighted:bg-(--surface-hover) data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
    );
  }
}
