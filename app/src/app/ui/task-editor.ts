import { Component, input, linkedSignal, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlay } from '@ng-icons/lucide';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';

/** Mounted by its parent only while editing, as the Svelte one was; it is open for its whole life. */
@Component({
  selector: 'app-task-editor',
  host: { class: 'contents' },
  imports: [NgIcon, HlmDialogImports, HlmButtonImports, HlmTextareaImports],
  providers: [provideIcons({ lucidePlay })],
  templateUrl: './task-editor.html',
})
export class TaskEditor {
  readonly task = input.required<string>();
  readonly run = output<string>();
  readonly cancel = output<void>();

  protected readonly draft = linkedSignal(() => this.task());

  protected onDraft(e: Event): void {
    this.draft.set((e.target as HTMLTextAreaElement).value);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && this.draft().trim()) this.run.emit(this.draft());
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed') this.cancel.emit();
  }
}
