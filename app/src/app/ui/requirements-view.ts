import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { splitStep, type Requirement } from '../lib/spec-doc';

/* The spec tab's Requirements view: every requirement in a list on the left, and the picked one on the right with
 * its scenarios as cards in two columns. A Scenario Outline's examples are a table that spans both columns. Both
 * columns scroll on their own; long titles are cut with an ellipsis in the list. */
@Component({
  selector: 'app-requirements-view',
  host: { class: 'contents' },
  imports: [HlmButtonImports, HlmTableImports],
  templateUrl: './requirements-view.html',
})
export class RequirementsView {
  readonly requirements = input.required<Requirement[]>();
  /** The requirement shown on the right. */
  readonly picked = input<Requirement | null>(null);
  readonly pick = output<string>();

  protected readonly split = splitStep;

  protected countOf(r: Requirement): string {
    const n = r.scenarios.length;
    return `${n} scenario${n === 1 ? '' : 's'}`;
  }
}
