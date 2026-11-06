import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { Versions } from '@bindings/Versions';

/** The line along the bottom of a screen: both versions, and a click copies them for a bug report. */
@Component({
  selector: 'app-version-line',
  host: { class: 'contents' },
  imports: [HlmButtonImports],
  templateUrl: './version-line.html',
})
export class VersionLine {
  readonly versions = input<Versions | null>(null);
  readonly copy = output<void>();
}
