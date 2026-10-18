import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';

// Kata skin: the stock card-with-border look is neutralized. The banner geometry
// (flex row, hairline underline) lives in src/styles/kata/workbench.css under
// .wb-banner; the destructive variant carries the andon crimson tokens.
const alertVariants = cva('group/alert relative flex w-full items-center gap-(--space-3) text-start', {
  variants: {
    variant: {
      default: 'bg-(--surface-card) text-(--text-primary)',
      destructive: 'bg-(--error-subtle) text-(--error-text)',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export type AlertVariants = VariantProps<typeof alertVariants>;

@Directive({
  selector: 'hlm-alert,[hlmAlert]',
  exportAs: 'hlmAlert',
  host: {
    'data-slot': 'alert',
    role: 'alert',
  },
})
export class HlmAlert {
  public readonly variant = input<AlertVariants['variant']>('default');

  constructor() {
    classes(() => alertVariants({ variant: this.variant() }));
  }
}
