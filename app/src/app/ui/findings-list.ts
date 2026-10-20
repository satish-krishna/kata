import { Component, input } from '@angular/core';
import type { Finding } from '../lib/sdlc';

/** A review that a newer one replaced, with the time of the newer one. */
export type ReplacedFindings = { at: string; findings: Finding[] };

@Component({
  selector: 'app-findings-list',
  templateUrl: './findings-list.html',
})
export class FindingsList {
  readonly findings = input.required<Finding[]>();
  readonly replaced = input<ReplacedFindings[]>([]);
}
