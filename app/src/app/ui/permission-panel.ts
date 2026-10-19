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
  template: `
    <div class="k-ask" [class.k-ask--answered]="settled()" [class.k-ask--lapsed]="lapsed()">
      <div class="k-ask__banner">
        <span class="k-ask__banner-dot"></span>
        <span class="k-ask__banner-label">{{ label() }}</span>
        <span class="k-ask__banner-tool">permission</span>
      </div>
      <div class="k-ask__body">
        <div class="k-ask__q">
          <div class="k-ask__q-head">
            <span class="k-ask__q-eyebrow">{{ record().tool }}</span>
          </div>
          <div class="k-ask__q-text">Allow this tool call?</div>
          <div class="k-ask__answer" [class.k-ask__answer--empty]="!record().input_summary">
            {{ record().input_summary || '(no input)' }}
          </div>

          @if (record().decided; as d) {
            <div class="k-ask__confirm">
              <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__confirm-btn" disabled
                [class.k-ask__confirm-btn--selected]="d.allow">Allow</button>
              <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__confirm-btn" disabled
                [class.k-ask__confirm-btn--selected]="!d.allow">Deny</button>
            </div>
            @if (d.message) {
              <div class="k-ask__answer">{{ d.message }}</div>
            }
          } @else if (!lapsed()) {
            <textarea hlmTextarea class="k-textarea" rows="2"
              placeholder="reason (optional — claude sees this on a denial)"
              [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea>
          }
        </div>

        @if (!settled() && !lapsed()) {
          <div class="k-ask__foot">
            <span class="k-ask__hint">the run is paused on the leash</span>
            <div class="k-ask__actions">
              <button hlmBtn variant="secondary" (click)="deny()">Deny</button>
              <button hlmBtn variant="primary" (click)="allow()">Allow · resume</button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
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
