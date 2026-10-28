import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
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

  protected readonly text = signal('');
  protected readonly canSend = computed(() => this.view().enabled && this.text().trim() !== '');

  constructor() {
    // A refused message comes back so the operator can copy it.
    effect(() => {
      const restore = this.view().restore;
      if (restore !== null) untracked(() => this.text.set(restore));
    });
  }

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
  }

  protected submit(): void {
    if (!this.canSend()) return;
    this.send.emit(this.text());
    this.text.set('');
  }
}
