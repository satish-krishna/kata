import { Component, input, output } from '@angular/core';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { LockView } from '../core/lock/lock.store';
import type { AskRecord, PermissionRecord } from '../lib/events';
import { LockPanel } from './lock-panel';

/* The lock shell: a Helm dialog whose open state follows `view`. `disableClose` makes Escape and
 * a backdrop click no-ops (brain's dismiss() returns early), so the only ways out are Cancel and
 * the run finishing. Role, aria-modal, the scrim and the focus trap come from the primitive. */
@Component({
  selector: 'app-lock-overlay',
  host: { class: 'contents' },
  imports: [HlmDialogImports, LockPanel],
  template: `
    <hlm-dialog [state]="view() ? 'open' : 'closed'" [disableClose]="true">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        @if (view(); as v) {
          <h2 hlmDialogTitle class="sr-only">{{ v.title }}</h2>
          <app-lock-panel
            [view]="v"
            [elapsed]="elapsed()"
            [lastTool]="lastTool()"
            [turn]="turn()"
            [model]="model()"
            [ask]="ask()"
            [permission]="permission()"
            [deadlineSecs]="deadlineSecs()"
            (cancel)="cancel.emit()"
            (answer)="answer.emit($event)"
            (decide)="decide.emit($event)"
          />
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class LockOverlay {
  readonly view = input.required<LockView | null>();
  readonly elapsed = input(0);
  readonly lastTool = input<string | null>(null);
  readonly turn = input<number | null>(null);
  readonly model = input<string | null>(null);
  readonly ask = input<AskRecord | null>(null);
  readonly permission = input<PermissionRecord | null>(null);
  readonly deadlineSecs = input<number | null>(null);

  readonly cancel = output<void>();
  readonly answer = output<{ id: string; answers: string[][] }>();
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();
}
