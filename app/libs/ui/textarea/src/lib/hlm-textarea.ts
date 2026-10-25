import { Directive, input } from '@angular/core';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnTextarea } from '@spartan-ng/brain/textarea';
import { classes } from '@spartan-ng/helm/utils';

export type HlmTextareaVariant = 'default' | 'mono';

// Kata's `.k-textarea` / `.k-textarea--mono`: the `.k-input` surface with a free
// height (the `rows` attribute sets it), a 64px floor and vertical resize.
const base = [
  'w-full min-h-16 py-(--space-3) px-(--space-4) resize-y',
  'bg-(--surface-inset) text-(color:--text-primary) border border-(--border-default) rounded-(--radius-sm)',
  'placeholder:text-(color:--text-placeholder)',
  'transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease-out)',
  'hover:border-(--border-strong)',
  'focus:outline-none focus:border-(--accent) focus:[box-shadow:0_0_0_3px_var(--accent-subtle)]',
  'not-hover:not-focus:data-[matches-spartan-invalid=true]:border-(--error-border)',
];

const body = 'font-sans font-normal text-[length:var(--text-base)] leading-(--leading-normal)';
const mono = 'font-mono font-normal text-[length:var(--text-base)] leading-(--leading-code)';

@Directive({
  selector: '[hlmTextarea]',
  hostDirectives: [
    { directive: BrnTextarea, inputs: ['id', 'forceInvalid'] },
    { directive: BrnFieldControlDescribedBy, inputs: ['aria-describedby'] },
  ],
  host: { 'data-slot': 'textarea' },
})
export class HlmTextarea {
  /** `mono` is for data: specs, prompts-as-code, paths. */
  public readonly variant = input<HlmTextareaVariant>('default');

  constructor() {
    classes(() => [base, this.variant() === 'mono' ? mono : body]);
  }
}
