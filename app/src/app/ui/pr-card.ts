import { Component, input } from '@angular/core';
import type { PrState } from '@bindings/PrState';

@Component({
  selector: 'app-pr-card',
  templateUrl: './pr-card.html',
})
export class PrCard {
  readonly pullRequests = input.required<PrState[]>();
}
