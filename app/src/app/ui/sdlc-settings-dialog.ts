import { Component, computed, input, linkedSignal, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { SdlcPermissionMode } from '@bindings/SdlcPermissionMode';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInput } from '@spartan-ng/helm/input';
import { Field } from './field';
import { Segmented } from './segmented';

export type SettingsSave = { settings: Settings; baseBranch: string | null };

const MODES: { value: SdlcPermissionMode; label: string }[] = [
  { value: 'bypass', label: 'bypass' },
  { value: 'prompt', label: 'prompt' },
];

/* AI-SDLC settings: how runs treat tool permissions, and the base branch of the current workspace. */
@Component({
  selector: 'app-sdlc-settings-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmInput, Field, Segmented],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        <div hlmDialogTitle>AI-SDLC settings</div>
        <div class="k-form">
          <app-field
            label="Permissions"
            key="permissions.mode"
            hint="bypass runs without asking; prompt pauses on every tool call that is not pre-approved."
          >
            <app-segmented ariaLabel="Permission mode" [options]="modes" [(value)]="mode" />
          </app-field>
          @if (workspace(); as w) {
            <app-field label="Base branch" key="base_branch" [hint]="'New changes branch from this branch in ' + w.name + '.'">
              <input hlmInput variant="mono" aria-label="Base branch" [value]="branch()" (input)="onBranch($event)" />
            </app-field>
          }
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="ghost" size="sm" type="button" (click)="cancel.emit()">Cancel</button>
          <button hlmBtn variant="primary" size="sm" type="button" [disabled]="!valid()" (click)="submit()">Save</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class SdlcSettingsDialog {
  readonly open = input.required<boolean>();
  readonly settings = input.required<Settings>();
  /** The workspace whose base branch is edited, or null when none is selected. */
  readonly workspace = input.required<WorkspaceEntry | null>();

  readonly save = output<SettingsSave>();
  readonly cancel = output<void>();

  protected readonly modes = MODES;

  /** Reopening starts from the stored values again. */
  protected readonly mode = linkedSignal<SdlcPermissionMode>(() => {
    this.open();
    return this.settings().permission_mode;
  });
  protected readonly branch = linkedSignal(() => {
    this.open();
    return this.workspace()?.base_branch ?? '';
  });
  protected readonly valid = computed(() => this.workspace() === null || this.branch().trim() !== '');

  protected onBranch(e: Event): void {
    this.branch.set((e.target as HTMLInputElement).value);
  }

  protected submit(): void {
    if (!this.valid()) return;
    this.save.emit({
      settings: { ...this.settings(), permission_mode: this.mode() },
      baseBranch: this.workspace() === null ? null : this.branch().trim(),
    });
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
