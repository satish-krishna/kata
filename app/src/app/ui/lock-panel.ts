import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSquare } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { StepsView } from '../core/lock/lock.store';
import type { ProgressView } from '../core/progress/progress.store';
import { ProgressLine } from './progress-line';

/* The body of the lock dialog (see LockOverlay for the shell, which also carries the accessible title). It only reports what is
 * known: a done/total count for Kata's own checks and the elapsed clock. No percentage, no ETA. */
@Component({
  selector: 'app-lock-panel',
  imports: [NgIcon, HlmButtonImports, ProgressLine],
  providers: [provideIcons({ lucideSquare })],
  templateUrl: './lock-panel.html',
})
export class LockPanel {
  readonly view = input.required<StepsView>();
  readonly elapsed = input.required<number>();
  /** What the running step reports, or null while nothing should show. */
  readonly stepProgress = input<ProgressView | null>(null);

  /** What Stop says it stops while a long step of the plugin runs, or null while there is nothing to stop. */
  readonly stopLabel = input<string | null>(null);

  readonly cancel = output<void>();
  readonly stop = output<void>();

  /** "<done> / <total>", a count of finished checks. */
  protected readonly progress = computed(() => {
    const list = this.view().steps;
    return `${list.filter((s) => s.state === 'done').length} / ${list.length}`;
  });

  protected clock(total: number): string {
    const s = Math.max(0, Math.floor(total));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected onCancel(): void {
    this.cancel.emit();
  }
}
