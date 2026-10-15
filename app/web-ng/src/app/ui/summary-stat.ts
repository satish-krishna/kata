import { Component, input } from '@angular/core';

@Component({
  selector: 'app-summary-stat',
  template: `<div class="k-stat">
    <span class="k-stat__label">{{ label() }}</span>
    <span
      class="k-stat__value"
      [class.k-stat__value--success]="tone() === 'success'"
      [class.k-stat__value--error]="tone() === 'error'"
      >{{ value() }}</span
    >
  </div>`,
})
export class SummaryStat {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly tone = input<'success' | 'error'>();
}
