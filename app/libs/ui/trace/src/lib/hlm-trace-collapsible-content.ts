import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrnCollapsibleContent } from '@spartan-ng/brain/collapsible';
import { classes, hlm } from '@spartan-ng/helm/utils';
import { ClassValue } from 'clsx';

@Component({
  selector: 'hlm-trace-collapsible-content',
  exportAs: 'hlmTraceCollapsibleContent',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: BrnCollapsibleContent, inputs: ['id'] }],
  host: { 'data-slot': 'trace-collapsible-content' },
  template: `
    <div [class]="_computedContentInnerClasses()" data-slot="trace-collapsible-content-inner">
      <ng-content />
    </div>
  `,
})
export class HlmTraceCollapsibleContent {
  public readonly contentInnerClasses = input<ClassValue>();

  protected readonly _computedContentInnerClasses = computed(() =>
    hlm('min-w-0 wrap-break-word', this.contentInnerClasses()),
  );

  /* Kata skin: no height transition. The body is mounted only while open, so a height animation
   * would animate an empty box, and a frozen measured height would clip a nested card that opens later. */
  constructor() {
    classes(() => 'block min-w-0');
  }
}
