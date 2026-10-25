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
  /** The box refuses an empty answer: the action cannot run without saying what should change. */
  readonly required = input(false);

  readonly run = output<string>();
  readonly cancel = output<void>();

  protected readonly hint = computed(() =>
    this.refused()
      ? 'Write what should change.'
      : (this.required() ? '' : 'Optional. ') + 'The agent regenerates the whole document with your corrections; where they disagree with the current version, they win.',
  );
  protected readonly open = computed(() => this.action() !== null);
  /** Each revisit starts with an empty box. */
  protected readonly text = linkedSignal(() => {
    this.action();
    return '';
  });

  /** Run was pressed on an empty required box; cleared by typing and by the next revisit. */
  protected readonly refused = linkedSignal(() => {
    this.action();
    return false;
  });

  protected onText(e: Event): void {
    this.text.set((e.target as HTMLTextAreaElement).value);
    this.refused.set(false);
  }

  protected onRun(): void {
    const text = this.text().trim();
    if (this.required() && text === '') {
      this.refused.set(true);
      return;
    }
    this.run.emit(text);
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
