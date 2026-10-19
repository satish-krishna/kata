import { Component, computed, input, output, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type { PermissionRecord } from '../lib/events';

/* Approval card for a paused permission check. Same anatomy as AskPanel: the run
 * is stopped on the leash either way, but the body is one tool call and the choice
 * is binary, so it reuses the .k-ask__confirm treatment rather than inventing a
 * second visual language for "the run needs you". */
@Component({
  selector: 'app-permission-panel',
  imports: [HlmButtonImports, HlmTextareaImports],
  templateUrl: './permission-panel.html',
})
export class PermissionPanel {
  readonly record = input.required<PermissionRecord>();
  /** The run is over, so an undecided check can no longer be decided. */
  readonly ended = input(false);
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();

  protected readonly reason = signal('');

  protected readonly settled = computed(() => this.record().decided !== null);
  protected readonly lapsed = computed(() => this.ended() && !this.settled());
  protected readonly label = computed(() => {
    const d = this.record().decided;
    if (!d && this.ended()) return 'not decided · run ended';
    return !d ? 'awaiting your decision' : d.allow ? 'allowed · run resumed' : 'denied · run resumed';
  });

  protected deny(): void {
    this.decide.emit({ id: this.record().id, allow: false, message: this.reason().trim() || null });
  }
  protected allow(): void {
    this.decide.emit({ id: this.record().id, allow: true, message: null });
  }
}
