import { Component, computed, input } from '@angular/core';
import type { PrState } from '@bindings/PrState';
import { prNumber } from '../lib/pull-request';

/* The pull requests of a change that is done: one row per repository with its number and a link to GitHub. A
 * repository without an address is left out. */
@Component({
  selector: 'app-pr-card',
  host: { class: 'block px-5 pt-5' },
  templateUrl: './pr-card.html',
})
export class PrCard {
  readonly pullRequests = input.required<PrState[]>();

  protected readonly rows = computed(() =>
    this.pullRequests().flatMap((p) => (p.url === null ? [] : [{ repo: p.repo, url: p.url, number: prNumber(p.url) }])),
  );
}
