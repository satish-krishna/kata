import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import type { StagePill } from '../lib/sdlc';

/* The change page's four stage pills, one per document and the build. Each pill is the tab trigger for its panel;
 * the tabs root and the panels belong to the change page, and the pills sit in its toolbar. What each pill says is
 * worked out by `stagePills`. The four triggers are written out, not looped: their keys are fixed, and the
 * primitive attribute stays static. */
@Component({
  selector: 'app-stage-pills',
  host: { class: 'contents' },
  imports: [HlmTabsImports, NgTemplateOutlet],
  templateUrl: './stage-pills.html',
})
export class StagePills {
  readonly pills = input.required<StagePill[]>();
}
