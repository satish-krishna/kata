import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';
import type { Finding } from '../lib/sdlc';

/** A review that a newer one replaced, with the time of the newer one. */
export type ReplacedFindings = { at: string; findings: Finding[] };

/* The review's findings, most serious first as given. A severity gets a dot and its name; a finding without one is just a finding.
 * Reviews a newer review replaced stay below, collapsed. */
@Component({
  selector: 'app-findings-list',
  imports: [NgTemplateOutlet],
  templateUrl: './findings-list.html',
})
export class FindingsList {
  readonly findings = input.required<Finding[]>();
  readonly replaced = input<ReplacedFindings[]>([]);

  protected tone(f: Finding): string {
    return f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'idle';
  }

  protected label(f: Finding): string {
    return f.severity === null ? 'Finding' : f.severity.charAt(0).toUpperCase() + f.severity.slice(1);
  }
}
