import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmMarkerIcon],hlm-marker-icon',
  exportAs: 'hlmMarkerIcon',
  host: {
    'data-slot': 'marker-icon',
    'aria-hidden': 'true',
  },
})
export class HlmMarkerIcon {
  constructor() {
    classes(() => "size-(--space-5) shrink-0 [&_ng-icon:not([class*='text-'])]:text-[length:var(--space-5)]");
  }
}
