import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import type { NameRequest } from '../core/sdlc/sdlc-runner';
import type { WorkType } from '../lib/sdlc-naming';
import { Field } from './field';

/* Name the branch: the work type and the suggested name, editable. The name follows the type until the engineer types in it. */
@Component({
  selector: 'app-branch-name-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmInputImports, HlmSelectImports, Field],
  templateUrl: './branch-name-dialog.html',
})
export class BranchNameDialog {
  /** What to confirm; the dialog is open while there is one. */
  readonly request = input<NameRequest | null>(null);

  readonly typeChange = output<WorkType>();
  readonly accept = output<string>();
  readonly cancel = output<void>();

  /** What the engineer typed; null while the name is still the suggestion. A new confirmation starts from the suggestion. */
  protected readonly typed = linkedSignal<NameRequest | null, string | null>({
    source: () => this.request(),
    computation: (req, prev) => (req !== null && prev?.source !== null && prev?.source !== undefined && sameChange(prev.source, req) ? prev.value : null),
  });
  protected readonly name = computed(() => this.typed() ?? this.request()?.suggestion ?? '');
  protected readonly ready = computed(() => {
    const req = this.request();
    return req !== null && !req.busy && this.name().trim() !== '';
  });
  protected readonly hint = computed(() => this.request()?.error ?? (this.request()?.rename ? 'The change moves to this branch in every repository that has it.' : 'The branch the change is built on, in every repository.'));

  protected onName(e: Event): void {
    this.typed.set((e.target as HTMLInputElement).value);
  }

  protected onType(value: unknown): void {
    if (typeof value === 'string') this.typeChange.emit(value as WorkType);
  }

  protected submit(): void {
    if (this.ready()) this.accept.emit(this.name().trim());
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.request() !== null) this.cancel.emit();
  }
}

/** The same confirmation seen again (a suggestion or a refusal arrived), as opposed to a new one. */
const sameChange = (a: NameRequest, b: NameRequest): boolean => a.system === b.system && a.change === b.change && a.pending === b.pending;
