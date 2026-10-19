import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Field } from './field';

export type NewChange = { system: string; idea: string };

/* New change: the idea in a sentence or two, and the system when the workspace has more than one.
 * The intent skill proposes the title and the folder name itself, so there is no slug field. */
@Component({
  selector: 'app-new-change-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmSelectImports, HlmTextareaImports, Field],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        <div hlmDialogTitle>New change</div>
        <div class="k-form">
          @if (systems().length > 1) {
            <app-field label="System" key="system">
              <hlm-select [(value)]="system">
                <hlm-select-trigger aria-label="System">
                  <hlm-select-value placeholder="Choose a system" />
                </hlm-select-trigger>
                <hlm-select-content *hlmSelectPortal>
                  @for (s of systems(); track s) {
                    <hlm-select-item [value]="s">{{ s }}</hlm-select-item>
                  }
                </hlm-select-content>
              </hlm-select>
            </app-field>
          }
          <app-field label="Idea" hint="A sentence or two. The agent proposes the title and the folder name and asks you to confirm.">
            <textarea hlmTextarea rows="4" aria-label="Idea" [value]="idea()" (input)="onIdea($event)"></textarea>
          </app-field>
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="ghost" size="sm" type="button" (click)="cancel.emit()">Cancel</button>
          <button hlmBtn variant="primary" size="sm" type="button" [disabled]="!ready()" (click)="submit()">Start</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class NewChangeDialog {
  readonly open = input.required<boolean>();
  readonly systems = input.required<string[]>();

  readonly start = output<NewChange>();
  readonly cancel = output<void>();

  /** Reopening starts empty, on the first system. */
  protected readonly idea = linkedSignal(() => {
    this.open();
    return '';
  });
  protected readonly system = linkedSignal<string | null>(() => {
    this.open();
    return this.systems()[0] ?? null;
  });
  protected readonly ready = computed(() => this.system() !== null && this.idea().trim() !== '');

  protected onIdea(e: Event): void {
    this.idea.set((e.target as HTMLTextAreaElement).value);
  }

  protected submit(): void {
    const system = this.system();
    if (!this.ready() || system === null) return;
    this.start.emit({ system, idea: this.idea().trim() });
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
