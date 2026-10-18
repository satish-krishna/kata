import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const codeBlockVariants = cva(
  'group/code-block relative flex w-full min-w-0 flex-col overflow-hidden bg-(--surface-inset) border border-(--border-subtle) rounded-(--radius-sm) text-(color:--text-secondary) font-mono text-[length:var(--text-sm)] data-[size=sm]:[font:var(--font-code-sm)] has-[>[data-slot=code-block-content]:focus-visible]:border-(--accent)',
  {
    variants: {
      variant: {
        default: '',
        // Edge-to-edge diff lines: the content drops its vertical padding and the lines carry the horizontal gutter.
        flush: '',
        destructive: 'border-(--error)',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type CodeBlockVariants = VariantProps<typeof codeBlockVariants>;

@Directive({
  selector: '[hlmCodeBlock],hlm-code-block',
  exportAs: 'hlmCodeBlock',
  host: {
    'data-slot': 'code-block',
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
  },
})
export class HlmCodeBlock {
  public readonly variant = input<CodeBlockVariants['variant']>('default');
  public readonly size = input<'default' | 'sm'>('default');

  constructor() {
    classes(() => codeBlockVariants({ variant: this.variant() }));
  }
}
