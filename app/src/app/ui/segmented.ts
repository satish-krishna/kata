import { Component, input, model } from '@angular/core';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';

@Component({
  selector: 'app-segmented',
  host: { class: 'contents' },
  imports: [HlmToggleGroupImports],
  template: `<hlm-toggle-group
    type="single"
    role="radiogroup"
    [attr.aria-label]="ariaLabel() ?? null"
    [value]="value()"
    (valueChange)="pick($event)"
  >
    @for (opt of options(); track opt.value) {
      <button
        hlmToggleGroupItem
        role="radio"
        [attr.aria-checked]="opt.value === value()"
        [value]="opt.value"
      >
        {{ opt.label }}
      </button>
    }
  </hlm-toggle-group>`,
})
export class Segmented<T extends string> {
  readonly options = input.required<{ value: T; label: string }[]>();
  readonly value = model.required<T>();
  readonly ariaLabel = input<string>();

  protected pick(v: unknown): void {
    // A single, non-nullable group: ignore a deselect, as the Svelte radiogroup did.
    if (typeof v === 'string') this.value.set(v as T);
  }
}
