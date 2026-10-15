import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

export type HlmCardTitleEmphasis = 'default' | 'stat' | 'title';

@Directive({
  selector: '[hlmCardTitle]',
  host: { 'data-slot': 'card-title' },
})
export class HlmCardTitle {
  /** 'stat' renders the headline-number treatment dashboard stat tiles need. */
  readonly emphasis = input<HlmCardTitleEmphasis>('default');

  constructor() {
    classes(() =>
      this.emphasis() === 'stat'
        ? 'text-3xl leading-tight font-bold group-data-[size=sm]/card:text-2xl'
        : this.emphasis() === 'title'
          ? 'text-2xl leading-tight font-bold'
          : 'text-base leading-normal font-medium group-data-[size=sm]/card:text-sm',
    );
  }
}
