import { Component, input, output } from '@angular/core';
import type { PrResult } from '@bindings/PrResult';

@Component({
  selector: 'app-pr-list-dialog',
  templateUrl: './pr-list-dialog.html',
})
export class PrListDialog {
  readonly results = input.required<PrResult[] | null>();
  readonly retry = output<void>();
  readonly close = output<void>();
}
