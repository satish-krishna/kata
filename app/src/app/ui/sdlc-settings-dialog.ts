import { Component, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { SdlcPermissionMode } from '@bindings/SdlcPermissionMode';
import type { Settings } from '@bindings/Settings';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { Field } from './field';
import { Segmented } from './segmented';

export type SettingsSave = { settings: Settings };

const MODES: { value: SdlcPermissionMode; label: string }[] = [
  { value: 'auto', label: 'auto' },
  { value: 'bypass', label: 'bypass' },
  { value: 'prompt', label: 'prompt' },
];

/* AI-SDLC settings: how runs treat tool permissions. */
@Component({
  selector: 'app-sdlc-settings-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, Field, Segmented],
  templateUrl: './sdlc-settings-dialog.html',
})
export class SdlcSettingsDialog {
  readonly open = input.required<boolean>();
  readonly settings = input.required<Settings>();

  readonly save = output<SettingsSave>();
  readonly cancel = output<void>();

  protected readonly modes = MODES;

  /** Reopening starts from the stored values again. */
  protected readonly mode = linkedSignal<SdlcPermissionMode>(() => {
    this.open();
    return this.settings().permission_mode;
  });
  protected submit(): void {
    this.save.emit({ settings: { ...this.settings(), permission_mode: this.mode() } });
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
