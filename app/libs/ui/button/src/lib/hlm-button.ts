import { Directive, input, signal } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ClassValue } from 'clsx';
import { injectBrnButtonConfig } from './hlm-button.token';

// Kata's `.k-btn` family, transcribed value for value. Every color, length and
// duration is a Kata token; nothing is a raw literal.
const coreButtonVariants = cva(
  [
    'group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none',
    'font-sans font-medium leading-none text-[length:var(--text-base)]',
    'rounded-(--radius-sm) border border-transparent cursor-pointer',
    'transition-[background-color,border-color,color,transform] duration-(--dur-fast) ease-(--ease-out)',
    'not-disabled:not-data-disabled:active:translate-y-[0.5px]',
    'disabled:cursor-not-allowed disabled:opacity-[0.45] data-disabled:cursor-not-allowed data-disabled:opacity-[0.45]',
    '[&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
  ],
  {
    variants: {
      // Each variant pins `color` on :hover too: these also render as <a>, and the
      // global a:hover color would otherwise tint the label on hover.
      variant: {
        primary: [
          // Marker, not style: parity/capture.mjs finds the primary action by this class.
          'k-btn--primary',
          'bg-(--accent) text-(color:--text-on-accent) font-semibold',
          'not-disabled:hover:bg-(--accent-hover) not-disabled:hover:text-(color:--text-on-accent)',
          'not-disabled:active:bg-(--accent-press)',
        ],
        secondary: [
          'bg-(--surface-card) text-(color:--text-primary) border-(--border-default)',
          'not-disabled:hover:bg-(--surface-hover) not-disabled:hover:border-(--border-strong) not-disabled:hover:text-(color:--text-primary)',
        ],
        ghost: [
          'bg-transparent text-(color:--text-secondary)',
          'not-disabled:hover:bg-(--surface-hover) not-disabled:hover:text-(color:--text-primary)',
        ],
        danger: [
          'bg-transparent text-(color:--error-text) border-(--error-border)',
          'not-disabled:hover:bg-(--error-subtle)',
        ],
        // Appearance-free: a Kata component class supplies the whole look (see buttonVariants).
        bare: [],
      },
      size: {
        default: 'h-(--control-h) gap-(--space-3) px-(--space-5)',
        sm: 'h-(--control-h-sm) gap-(--space-2) px-(--space-4) text-[length:var(--text-sm)]',
        lg: 'h-(--control-h-lg) gap-(--space-3) px-(--space-6) text-[length:var(--text-md)]',
        // Square icon-only buttons: `.k-iconbtn` (32px) and `.k-iconbtn--sm` (26px).
        icon: 'size-(--control-h) gap-(--space-3) p-0',
        'icon-sm': 'size-(--control-h-sm) gap-(--space-3) p-0',
        bare: [],
      },
    },
    compoundVariants: [
      // `.k-iconbtn`: muted at rest, dimmer when disabled.
      {
        variant: 'ghost',
        size: ['icon', 'icon-sm'],
        class:
          'text-(color:--text-muted) disabled:opacity-40 data-disabled:opacity-40',
      },
    ],
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

type CoreProps = VariantProps<typeof coreButtonVariants>;

/** `variant="bare"` (with `size="bare"`) emits no classes at all, not even the shared
 *  base: the native <button> in Svelte took its whole look from a Kata class such as
 *  `.k-toolcard__row`, and any utility here would out-rank that class (components.css
 *  sits in a lower cascade layer). Every other combination is unchanged. */
export function buttonVariants(props?: CoreProps): string {
  if (props?.variant === 'bare') return '';
  return coreButtonVariants(props);
}

export type ButtonVariants = CoreProps;

@Directive({
  selector: 'button[hlmBtn], a[hlmBtn]',
  exportAs: 'hlmBtn',
  hostDirectives: [{ directive: BrnButton, inputs: ['disabled'] }],
  host: { 'data-slot': 'button' },
})
export class HlmButton {
  private readonly _config = injectBrnButtonConfig();

  private readonly _additionalClasses = signal<ClassValue>('');

  public readonly variant = input<ButtonVariants['variant']>(this._config.variant);

  public readonly size = input<ButtonVariants['size']>(this._config.size);

  constructor() {
    classes(() => [
      buttonVariants({ variant: this.variant(), size: this.size() }),
      this._additionalClasses(),
    ]);
  }

  setClass(classes: string): void {
    this._additionalClasses.set(classes);
  }
}
