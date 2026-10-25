import { Component, computed, input, output } from '@angular/core';
import type { InstructionsState } from '@bindings/InstructionsState';
import { HlmButtonImports } from '@spartan-ng/helm/button';

const WORD: Record<InstructionsState, string> = { missing: 'missing', 'out-of-date': 'out of date', current: 'current' };
const LABEL: Record<InstructionsState, string | null> = { missing: 'Write instructions', 'out-of-date': 'Refresh instructions', current: null };

/* The workspace home's instructions row: whether this machine's copy of the workspace instructions matches the
 * master's, with an offer to write or refresh them. */
@Component({
  selector: 'app-instructions-row',
  imports: [HlmButtonImports],
  templateUrl: './instructions-row.html',
})
export class InstructionsRow {
  readonly state = input.required<InstructionsState>();
  readonly disabled = input(false);

  readonly refresh = output<void>();

  protected readonly word = computed(() => WORD[this.state()]);
  protected readonly label = computed(() => LABEL[this.state()]);
  protected readonly tone = computed(() => (this.state() === 'current' ? 'success' : 'warning'));
}
