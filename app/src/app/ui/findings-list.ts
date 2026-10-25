import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { Finding } from '../lib/sdlc';
import type { FindingGroup } from '../lib/sdlc-findings';
import { MarkdownBody } from './markdown-body';

/** A review that a newer one replaced, with the time of the newer one. */
export type ReplacedFindings = { at: string; groups: FindingGroup[]; label?: string };

/* The review's findings, most serious first as given. A severity gets a dot and its name; a finding without one is just a finding.
 * Reviews a newer review replaced stay below, collapsed. */
@Component({
  selector: 'app-findings-list',
  imports: [NgTemplateOutlet, HlmButtonImports, MarkdownBody],
  templateUrl: './findings-list.html',
})
export class FindingsList {
  readonly groups = input.required<FindingGroup[]>();
  readonly replaced = input<ReplacedFindings[]>([]);
  /** True for findings read from a review run's closing words, because the change has no review document. */
  readonly older = input(false);
  /** What to say when the review found nothing. */
  readonly emptyText = input('The review found nothing.');

  /** The finding the engineer picked last, to mark; null when none. */
  readonly picked = input<{ file: string; line: number | null; text: string; n: number } | null>(null);
  /** A finding that names a file was picked. */
  readonly pick = output<Finding>();

  protected where(f: Finding): string | null {
    return f.file === undefined ? null : f.line === undefined ? f.file : `${f.file}:${f.line}`;
  }

  protected isPicked(f: Finding): boolean {
    const at = this.picked();
    return at !== null && at.file === f.file && at.text === f.text;
  }

  protected tone(f: Finding): string {
    return f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'idle';
  }

  protected label(f: Finding): string {
    return f.severity === null ? 'Finding' : f.severity.charAt(0).toUpperCase() + f.severity.slice(1);
  }
}
