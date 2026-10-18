import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { cva, VariantProps } from 'class-variance-authority';

const codeBlockLineVariants = cva(
  "before:text-(--text-faint) before:min-w-6 before:text-end in-data-numbered:gap-x-3 relative block min-h-lh whitespace-pre -mx-(--space-3) px-(--space-3) group-data-[variant=flush]/code-block:-mx-(--space-2) group-data-[variant=flush]/code-block:px-(--space-2) in-data-numbered:col-span-2 in-data-numbered:grid in-data-numbered:grid-cols-subgrid in-data-numbered:[counter-increment:line] in-data-numbered:before:content-[counter(line)] in-data-numbered:before:select-none in-data-numbered:supports-[content:counter(line)_/_'']:before:content-[counter(line)_/_'']",
  {
    variants: {
      variant: {
        default: 'text-(color:--text-muted)',
        added: 'bg-(--success-subtle) text-(color:--success-text)',
        removed: 'bg-(--error-subtle) text-(color:--error-text)',
        highlighted: 'bg-(--surface-card)',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type CodeBlockLineVariants = VariantProps<typeof codeBlockLineVariants>;

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'span[hlmCodeBlockLine]',
  exportAs: 'hlmCodeBlockLine',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-slot': 'code-block-line', '[attr.data-variant]': 'variant()' },
  template: `
    <span data-slot="code-block-line-content" class="min-w-0">
      <ng-content />
    </span>
  `,
})
export class HlmCodeBlockLine {
  public readonly variant = input<CodeBlockLineVariants['variant']>('default');

  constructor() {
    classes(() => codeBlockLineVariants({ variant: this.variant() }));
  }
}
