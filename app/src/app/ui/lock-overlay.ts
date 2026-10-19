import { Component, input, output } from '@angular/core';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { StepsView } from '../core/lock/lock.store';
import { LockPanel } from './lock-panel';

/* The lock shell for Kata's own checks (an agent run takes the page as the session view instead): a Helm
 * dialog whose open state follows `view`. `disableClose` makes Escape and a backdrop click no-ops (brain's
 * dismiss() returns early), so the only ways out are Cancel and the steps finishing. Role, aria-modal, the scrim and the focus trap come from the primitive. */
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
            (cancel)="cancel.emit()"
          />
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class LockOverlay {
  readonly view = input.required<StepsView | null>();
  readonly elapsed = input(0);

  readonly cancel = output<void>();
}
