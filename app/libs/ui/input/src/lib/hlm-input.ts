import { Directive, input } from '@angular/core';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnInput } from '@spartan-ng/brain/input';
import { classes } from '@spartan-ng/helm/utils';

export type HlmInputVariant = 'default' | 'mono' | 'bare';

// Kata's `.k-input` / `.k-input--mono` / `.k-input--invalid`. The inset surface is
// darker than its card; focus is an azure border plus a 3px subtle ring.
const base = [
  'w-full h-(--control-h) px-(--space-4)',
  'bg-(--surface-inset) text-(color:--text-primary) border border-(--border-default) rounded-(--radius-sm)',
  'placeholder:text-(color:--text-placeholder)',
  'transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease-out)',
  'hover:border-(--border-strong)',
  'focus:outline-none focus:border-(--accent) focus:[box-shadow:0_0_0_3px_var(--accent-subtle)]',
  // `.k-input--invalid` sat below :hover and :focus in the cascade, so it never beat either.
  'not-hover:not-focus:data-[matches-spartan-invalid=true]:border-(--error-border)',
];

const body = 'font-sans font-normal text-[length:var(--text-base)] leading-(--leading-normal)';
const mono = 'font-mono font-normal text-[length:var(--text-base)] leading-(--leading-code)';

@Directive({
  selector: '[hlmInput]',
  hostDirectives: [
    { directive: BrnInput, inputs: ['id', 'forceInvalid'] },
    BrnFieldControlDescribedBy,
  ],
  host: { 'data-slot': 'input' },
})
export class HlmInput {
  /** `mono` is for data: paths, keys, model ids. `bare` emits no classes: a Kata component
   *  class (e.g. `.wb-specname`) supplies the whole look, which utilities here would out-rank. */
  public readonly variant = input<HlmInputVariant>('default');

  constructor() {
    classes(() => (this.variant() === 'bare' ? [] : [base, this.variant() === 'mono' ? mono : body]));
  }
}
