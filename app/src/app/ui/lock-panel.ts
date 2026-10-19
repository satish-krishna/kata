import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { LockStep, LockView } from '../core/lock/lock.store';
import type { AskRecord, PermissionRecord } from '../lib/events';
import { AskPanel } from './ask-panel';
import { PermissionPanel } from './permission-panel';

/* The body of the lock dialog (see LockOverlay for the shell, which also carries the accessible title). It only reports what is
 * known: a done/total count for Kata's own checks, live activity for an agent run, and the
 * time left before an unanswered question reaps the run. No percentage, no ETA. */
@Component({
  selector: 'app-lock-panel',
  imports: [HlmButtonImports, AskPanel, PermissionPanel],
  template: `
    <div class="k-lock">
      <div class="k-lock__head">
        <div class="k-lock__title" aria-hidden="true">{{ view().title }}</div>
        <span class="k-lock__clock"><span class="sr-only">Elapsed </span>{{ clock(elapsed()) }}</span>
      </div>

      @if (steps(); as list) {
        <div class="k-lock__count">{{ progress() }}</div>
        <ol class="k-lock__steps">
          @for (s of list; track $index) {
            <li class="k-lock__step" [attr.data-state]="s.state">
              <span class="k-lock__dot"></span>
              <span class="k-lock__step-label">{{ s.label }}</span>
              <span class="k-lock__step-state">{{ s.state }}</span>
              @if (s.detail) {
                <span class="k-lock__step-detail">{{ s.detail }}</span>
              }
            </li>
          }
        </ol>
      } @else {
        <dl class="k-lock__activity">
          <dt>turn</dt>
          <dd>{{ turn() ?? '-' }}</dd>
          <dt>model</dt>
          <dd>{{ model() || '-' }}</dd>
          <dt>last tool</dt>
          <dd>{{ lastTool() ?? '-' }}</dd>
        </dl>
      }

      @if (ask(); as a) {
        <app-ask-panel [ask]="a" (answer)="answer.emit($event)" />
      }
      @if (permission(); as p) {
        <app-permission-panel [record]="p" (decide)="decide.emit($event)" />
      }

      <div class="k-lock__foot">
        <span class="k-lock__deadline">{{ deadlineLabel() }}</span>
        <button hlmBtn variant="secondary" size="sm" type="button" (click)="onCancel()">Cancel</button>
      </div>
    </div>
  `,
})
export class LockPanel {
  readonly view = input.required<LockView>();
  readonly elapsed = input.required<number>();
  readonly lastTool = input<string | null>(null);
  readonly turn = input<number | null>(null);
  readonly model = input<string | null>(null);
  readonly ask = input<AskRecord | null>(null);
  readonly permission = input<PermissionRecord | null>(null);
  readonly deadlineSecs = input<number | null>(null);

  readonly cancel = output<void>();
  readonly answer = output<{ id: string; answers: string[][] }>();
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();

  protected readonly steps = computed<LockStep[] | null>(() => {
    const v = this.view();
    return v.kind === 'steps' ? v.steps : null;
  });
  /** "<done> / <total>", a count of finished checks. */
  protected readonly progress = computed(() => {
    const list = this.steps() ?? [];
    return `${list.filter((s) => s.state === 'done').length} / ${list.length}`;
  });
  protected readonly deadlineLabel = computed(() => {
    const secs = this.deadlineSecs();
    const pending = this.ask() ?? this.permission();
    return pending && secs !== null ? `exits 123 if unanswered in ${this.clock(secs)}` : '';
  });

  protected clock(total: number): string {
    const s = Math.max(0, Math.floor(total));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected onCancel(): void {
    this.cancel.emit();
  }
}
