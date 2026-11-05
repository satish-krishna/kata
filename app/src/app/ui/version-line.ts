import { Component, input, output } from '@angular/core';
import type { Versions } from '@bindings/Versions';

@Component({
  selector: 'app-version-line',
  templateUrl: './version-line.html',
})
export class VersionLine {
  readonly versions = input<Versions | null>(null);
  readonly copy = output<void>();
}
