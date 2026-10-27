import { Component, input, output } from '@angular/core';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { StepsView } from '../core/lock/lock.store';
import type { ProgressView } from '../core/progress/progress.store';
import { LockPanel } from './lock-panel';

/* The lock shell for Kata's own checks (an agent run takes the page as the session view instead): a Helm
 * dialog whose open state follows `view`. `disableClose` makes Escape and a backdrop click no-ops (brain's
 * dismiss() returns early), so the only ways out are Cancel and the steps finishing. Role, aria-modal, the scrim and the focus trap come from the primitive. */
@Component({
  selector: 'app-lock-overlay',
  host: { class: 'contents' },
  imports: [HlmDialogImports, LockPanel],
  templateUrl: './lock-overlay.html',
})
export class LockOverlay {
  readonly view = input.required<StepsView | null>();
  readonly elapsed = input(0);
  /** What the running step reports, or null while nothing should show. */
  readonly stepProgress = input<ProgressView | null>(null);

  readonly cancel = output<void>();
}
