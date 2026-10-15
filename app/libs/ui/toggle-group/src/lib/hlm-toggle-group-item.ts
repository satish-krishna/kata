import { Directive } from '@angular/core';
import { BrnToggleGroupItem } from '@spartan-ng/brain/toggle-group';
import { classes } from '@spartan-ng/helm/utils';

// Kata's `.k-seg__opt`; the selected option is `.k-seg__opt--active`.
@Directive({
  selector: 'button[hlmToggleGroupItem]',
  hostDirectives: [
    {
      directive: BrnToggleGroupItem,
      inputs: ['id', 'value', 'disabled', 'state', 'aria-label', 'type'],
      outputs: ['stateChange'],
    },
  ],
  host: { 'data-slot': 'toggle-group-item' },
})
export class HlmToggleGroupItem {
  constructor() {
    classes(
      () =>
        'inline-flex items-center justify-center cursor-pointer border-0 h-(--control-h-seg) px-(--space-4) rounded-(--radius-xs) font-mono font-medium text-[length:var(--text-sm)] leading-none bg-transparent text-(color:--text-muted) transition-[background-color,color] duration-(--dur-fast) ease-(--ease-out) hover:text-(color:--text-primary) data-[state=on]:bg-(--accent) data-[state=on]:text-(color:--text-on-accent) disabled:pointer-events-none disabled:opacity-50',
    );
  }
}
