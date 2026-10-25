import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type { StartTrack } from '../lib/sdlc';
import { Field } from './field';
import { Segmented } from './segmented';

export type NewChange = { system: string; idea: string; track: StartTrack };

/* New change: the description in a sentence or two, the system when the workspace has more than one, and the track.
 * The workflow proposes the title and the folder name itself, so there is no slug field. */
@Component({
  selector: 'app-new-change-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmSelectImports, HlmTextareaImports, Field, Segmented],
  templateUrl: './new-change-dialog.html',
})
export class NewChangeDialog {
  readonly open = input.required<boolean>();
  readonly systems = input.required<string[]>();
  /** Whether the plugin on this machine can triage a change (ai-sdlc 0.13.0 or later). */
  readonly lightTrack = input(false);
  /** The description the dialog opens with, for describing a change again. */
  readonly initialIdea = input('');
  readonly initialTrack = input<StartTrack>('decide');
  /** Hides the Track field and keeps the track at `initialTrack`, for a caller that has already chosen it. */
  readonly trackFixed = input(false);
  /** Shown above the description. */
  readonly note = input<string | null>(null);

  readonly start = output<NewChange>();
  readonly cancel = output<void>();

  protected readonly tracks = computed(() => [
    { value: 'decide' as StartTrack, label: 'Let the workflow decide', disabled: !this.lightTrack() },
    { value: 'full' as StartTrack, label: 'Full pipeline' },
  ]);
  protected readonly trackHint = computed(() =>
    this.lightTrack()
      ? 'The workflow reads the description and picks the light track or the full pipeline.'
      : 'Needs ai-sdlc 0.13.0 or later.',
  );

  /** Reopening starts from the given description, empty when none was given, on the first system. */
  protected readonly idea = linkedSignal(() => {
    this.open();
    return this.initialIdea();
  });
  /** Without the light track the workflow cannot decide, so the full pipeline is the only choice. */
  protected readonly track = linkedSignal<StartTrack>(() => {
    this.open();
    return this.trackFixed() || this.lightTrack() ? this.initialTrack() : 'full';
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
    this.start.emit({ system, idea: this.idea().trim(), track: this.track() });
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
