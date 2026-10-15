import { Directive, booleanAttribute, input, model } from '@angular/core';

/**
 * Binds a `type="number"` input to an optional-number spec value where empty means
 * "unset" (null), never 0 or NaN. One place for all four leash/interactive numbers.
 *
 * Mirrors the coercion the Svelte pane applied per field: blank stores null, an
 * integer field truncates, and a value below the floor (or at it, when `exclusive`)
 * is rejected as null rather than stored. kata-core's `Option<u32>` / `Option<f64>`
 * is the reason for each floor. Usage: `[nullableNumber]="v" (nullableNumberChange)="set($event)"`.
 */
@Directive({
  selector: 'input[nullableNumber]',
  host: {
    '[value]': 'nullableNumber() ?? ""',
    '(input)': 'onInput($event)',
  },
})
export class NullableNumber {
  readonly nullableNumber = model<number | null | undefined>(null);
  /** Truncate toward zero (the engine field is an integer). */
  readonly integer = input(false, { transform: booleanAttribute });
  /** Smallest accepted value. */
  readonly floor = input(0);
  /** When true, the floor itself is rejected (budget must be above 0). */
  readonly exclusive = input(false, { transform: booleanAttribute });

  protected onInput(e: Event): void {
    const raw = (e.target as HTMLInputElement).value.trim();
    let next: number | null = null;
    if (raw !== '') {
      const n = this.integer() ? Math.trunc(Number(raw)) : Number(raw);
      const ok = Number.isFinite(n) && (this.exclusive() ? n > this.floor() : n >= this.floor());
      next = ok ? n : null;
    }
    this.nullableNumber.set(next);
  }
}
