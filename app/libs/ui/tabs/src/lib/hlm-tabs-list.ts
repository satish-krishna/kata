import { Directive, input } from '@angular/core';
import { BrnTabsList } from '@spartan-ng/brain/tabs';
import { classes } from '@spartan-ng/helm/utils';
import { type VariantProps, cva } from 'class-variance-authority';

export const listVariants = cva(
  'rounded-lg p-[3px] group-data-horizontal/tabs:h-9 data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);
type ListVariants = VariantProps<typeof listVariants>;

@Directive({
  selector: '[hlmTabsList],hlm-tabs-list',
  hostDirectives: [BrnTabsList],
  host: {
    'data-slot': 'tabs-list',
    '[attr.data-variant]': 'variant()',
  },
})
export class HlmTabsList {
  /** `bare` emits no classes, so a Kata class supplies the whole look, as `hlmBtn variant="bare"` does. */
  public readonly variant = input<ListVariants['variant'] | 'bare'>('default');

  constructor() {
    classes(() => {
      const variant = this.variant();
      return variant === 'bare' ? '' : listVariants({ variant });
    });
  }
}
