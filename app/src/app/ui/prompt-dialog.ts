import { Component, input, linkedSignal, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInput } from '@spartan-ng/helm/input';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';

@Component({
  selector: 'app-prompt-dialog',
  // The dialog renders in an overlay; the host must not take a flex slot (and its gap) in the form.
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmInput],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" autoFocus="input" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        <div hlmDialogTitle>{{ title() }}</div>
        <input
          hlmInput
          [placeholder]="placeholder()"
          [attr.aria-label]="title()"
          [value]="draft()"
          (input)="onDraft($event)"
          (keydown.enter)="submit()"
        />
        <hlm-dialog-footer>
          <button hlmBtn variant="ghost" size="sm" type="button" (click)="cancel.emit()">Cancel</button>
          <button hlmBtn variant="primary" size="sm" type="button" [disabled]="!draft().trim()" (click)="confirm.emit(draft().trim())">
            Save
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class PromptDialog {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly initial = input('');
  readonly placeholder = input('');
  readonly confirm = output<string>();
  readonly cancel = output<void>();

  /** Reopening starts from `initial` again, as a fresh Svelte mount did. */
  protected readonly draft = linkedSignal(() => {
    this.open();
    return this.initial();
  });

  protected onDraft(e: Event): void {
    this.draft.set((e.target as HTMLInputElement).value);
  }

  protected submit(): void {
    const v = this.draft().trim();
    if (v) this.confirm.emit(v);
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
