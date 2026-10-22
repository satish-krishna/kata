import { Component, input, output } from '@angular/core';
import type { KindGroup, PresetRow } from '../lib/given';

export type GivenToggle = { key: string; off: boolean };

@Component({ selector: 'app-given-list', templateUrl: './given-list.html' })
export class GivenList {
  readonly groups = input.required<KindGroup[]>();
  readonly readonly = input<boolean>(false);
  readonly statusLabel = input<((row: PresetRow) => string | null) | null>(null);
  readonly toggle = output<GivenToggle>();
}
