import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { RunSpec } from '@bindings/RunSpec';
import type { AskRecord, PermissionRecord, RunState, RunSummary, StreamEvent } from '../lib/events';
import { ObservePane } from './observe-pane';

/* The AI-SDLC session view: an agent run takes the page's main region (the toolbar above stays, locked)
 * and shows the Workbench's observe pane full width. It stays after the run ends, with Close in place of
 * Cancel, until the operator closes it. */
@Component({
  selector: 'app-sdlc-session',
  host: { class: 'contents' },
  imports: [HlmButtonImports, ObservePane],
  template: `
    <main class="wb-pane wb-pane--observe k-session" aria-labelledby="session-title">
      <div class="wb-pane__head">
        <h1 id="session-title" class="kata-eyebrow k-session__title">{{ title() }}</h1>
        <span class="k-lock__clock"><span class="sr-only">Elapsed </span>{{ clock(elapsed()) }}</span>
        <span class="k-lock__deadline">{{ deadlineLabel() }}</span>
        <span class="k-session__actions">
          @if (finished() === null) {
            <button hlmBtn variant="secondary" size="sm" type="button" (click)="cancel.emit()">Cancel</button>
          } @else {
            <button hlmBtn variant="primary" size="sm" type="button" [disabled]="closeBlocked()" (click)="close.emit()">Close</button>
          }
        </span>
      </div>
      <app-observe-pane
        [state]="state()"
        [events]="events()"
        [spec]="spec()"
        [summary]="summary()"
        [asks]="asks()"
        [permissions]="permissions()"
        (answer)="answer.emit($event)"
        (decide)="decide.emit($event)"
      />
    </main>
  `,
})
export class SdlcSession {
  readonly title = input.required<string>();
  /** How the run ended, or null while it is live. */
  readonly finished = input<RunState | null>(null);
  readonly elapsed = input(0);
  readonly deadlineSecs = input<number | null>(null);
  /** Close waits while something still needs the operator's decision (the leftover dialog). */
  readonly closeBlocked = input(false);
  readonly state = input.required<RunState>();
  readonly events = input.required<StreamEvent[]>();
  readonly spec = input.required<RunSpec>();
  readonly summary = input.required<RunSummary | null>();
  readonly asks = input<AskRecord[]>([]);
  readonly permissions = input<PermissionRecord[]>([]);

  readonly cancel = output<void>();
  readonly close = output<void>();
  readonly answer = output<{ id: string; answers: string[][] }>();
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();

  protected readonly deadlineLabel = computed(() => {
    const secs = this.deadlineSecs();
    return secs !== null && this.finished() === null ? `exits 123 if unanswered in ${this.clock(secs)}` : '';
  });

  protected clock(total: number): string {
    const s = Math.max(0, Math.floor(total));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}
