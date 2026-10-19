import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Field } from './field';

/* The feedback box in front of a revisit (continue, reopen, re-run): what should change, optional. The skill
 * regenerates the whole document with the corrections, so the box says that rather than promising an edit. */
@Component({
  selector: 'app-feedback-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmTextareaImports, Field],
  templateUrl: './feedback-dialog.html',
})
export class FeedbackDialog {
  /** The label of the action waiting on the box, or null while it is closed. */
  readonly action = input.required<string | null>();

  readonly run = output<string>();
  readonly cancel = output<void>();

  protected readonly open = computed(() => this.action() !== null);
  /** Each revisit starts with an empty box. */
  protected readonly text = linkedSignal(() => {
    this.action();
    return '';
  });

  protected onText(e: Event): void {
    this.text.set((e.target as HTMLTextAreaElement).value);
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
