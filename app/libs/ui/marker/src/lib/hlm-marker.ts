import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const markerVariants = cva(
  "group/marker relative flex w-full items-center gap-(--space-3) text-start font-mono font-medium uppercase leading-(--leading-code) tracking-(--tracking-label) text-(color:--text-faint) text-[length:var(--text-2xs)] [a]:hover:text-(color:--text-primary) [a]:underline [a]:underline-offset-3",
  {
    variants: {
      variant: {
        default: '',
        separator:
          'pt-(--space-1) before:bg-(--border-subtle) after:bg-(--border-subtle) before:me-(--space-3) before:h-px before:min-w-0 before:flex-1 after:ms-(--space-3) after:h-px after:min-w-0 after:flex-1',
        border: 'border-b border-(--border-subtle) pb-(--space-2-5)',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type MarkerVariants = VariantProps<typeof markerVariants>;

@Directive({
  selector: '[hlmMarker],hlm-marker',
  exportAs: 'hlmMarker',
  host: {
    'data-slot': 'marker',
    '[attr.data-variant]': 'variant()',
  },
})
export class HlmMarker {
  public readonly variant = input<MarkerVariants['variant']>('default');

  constructor() {
    classes(() => markerVariants({ variant: this.variant() }));
  }
}
