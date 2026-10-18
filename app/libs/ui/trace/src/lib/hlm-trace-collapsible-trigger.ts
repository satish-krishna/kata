import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BrnCollapsibleTrigger } from '@spartan-ng/brain/collapsible';
import { classes } from '@spartan-ng/helm/utils';

/**
 * Kata skin: the stock trailing chevron is gone. The call site puts the chevron in an
 * `hlm-trace-icon` at the start of the row (it swaps right/down with the open state), and the
 * Kata look (padding, hover, focus ring, type) comes from the `.k-toolcard__row` class.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'button[hlmTraceCollapsibleTrigger]',
  exportAs: 'hlmTraceCollapsibleTrigger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: BrnCollapsibleTrigger, inputs: ['type'] }],
  host: { 'data-slot': 'trace-collapsible-trigger' },
  template: `<ng-content />`,
})
export class HlmTraceCollapsibleTrigger {
  constructor() {
    classes(() => 'flex w-full min-w-0 cursor-pointer items-center text-left');
  }
}
