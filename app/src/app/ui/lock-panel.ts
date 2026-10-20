import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { StepsView } from '../core/lock/lock.store';

/* The body of the lock dialog (see LockOverlay for the shell, which also carries the accessible title). It only reports what is
 * known: a done/total count for Kata's own checks and the elapsed clock. No percentage, no ETA. */
@Component({
  selector: 'app-lock-panel',
  imports: [HlmButtonImports],
  templateUrl: './lock-panel.html',
})
export class LockPanel {
  readonly view = input.required<StepsView>();
  readonly elapsed = input.required<number>();

  readonly cancel = output<void>();

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
