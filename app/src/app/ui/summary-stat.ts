import { Component, input } from '@angular/core';

@Component({
  selector: 'app-summary-stat',
  templateUrl: './summary-stat.html',
})
export class SummaryStat {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly tone = input<'success' | 'error'>();
}
