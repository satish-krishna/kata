import { Component, computed, effect, input, linkedSignal, output, untracked } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import type { MessageBoxView } from '../lib/events';

/** One line the operator types to steer a live run, with the note that says when the agent reads it. */
@Component({
  selector: 'app-message-box',
  host: { class: 'block shrink-0 border-t border-(--border-default) bg-(--surface-card) px-4 py-3' },
  imports: [HlmButtonImports, HlmInput],
  templateUrl: './message-box.html',
})
export class MessageBox {
  readonly view = input.required<MessageBoxView>();
  readonly send = output<string>();
  /** The text typed and not sent, kept by the page so it comes back when the page is opened again. */
  readonly draft = input('');
  readonly draftChange = output<string>();

  protected readonly text = linkedSignal(() => this.draft());
  protected readonly canSend = computed(() => this.view().enabled && this.text().trim() !== '');

  constructor() {
    // A refused message comes back so the operator can copy it.
    // Keyed on the refusal, so a rebuilt view for the same refusal leaves the operator's edits alone.
    const refusal = computed(() => {
      const { restore, restoreId } = this.view();
      return restore === null ? null : (restoreId ?? restore);
    });
    effect(() => {
      if (refusal() === null) return;
      untracked(() => this.setText(this.view().restore ?? ''));
    });
  }

  protected onInput(event: Event): void {
    this.setText((event.target as HTMLInputElement).value);
  }

  private setText(text: string): void {
    this.text.set(text);
    this.draftChange.emit(text);
  }

  protected submit(): void {
    if (!this.canSend()) return;
    this.send.emit(this.text());
    this.setText('');
  }
}
