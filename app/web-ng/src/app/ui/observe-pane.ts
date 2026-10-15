import { Component, afterRenderEffect, computed, ElementRef, input, output, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheckCircle, lucideCpu, lucideGitBranch, lucideTerminal, lucideXCircle } from '@ng-icons/lucide';
import type { RunSpec } from '@bindings/RunSpec';
import { STATUS_LABEL, type AskRecord, type PermissionRecord, type RunState, type RunSummary, type StreamEvent } from '../lib/events';
import { isAtBottom } from '../lib/scroll';
import { pairToolEvents, withPauses } from '../lib/toolcards';
import { AskPanel } from './ask-panel';
import { EventRow } from './event-row';
import { MarkdownBody } from './markdown-body';
import { PermissionPanel } from './permission-panel';
import { SummaryStat } from './summary-stat';
import { ToolCard } from './tool-card';

@Component({
  selector: 'app-observe-pane',
  host: { class: 'wb-observe' },
  imports: [NgIcon, EventRow, ToolCard, SummaryStat, AskPanel, PermissionPanel, MarkdownBody],
  providers: [provideIcons({ lucideCpu, lucideGitBranch, lucideTerminal, lucideCheckCircle, lucideXCircle })],
  template: `
    <div class="wb-status">
      <span class="k-status" [class]="'k-status--' + state()">
        <span class="k-status__dot"></span>{{ statusLabel() }}
      </span>
      <div class="wb-sep"></div>
      <div class="wb-status__meta"><ng-icon name="lucideCpu" size="14" /> {{ spec().model.id || 'default' }}</div>
      @if (spec().leash.isolation === 'worktree') {
        <span class="k-badge k-badge--warning"><ng-icon name="lucideGitBranch" size="11" /> worktree</span>
      }
    </div>

    <div class="wb-stream" #stream (scroll)="onScroll()">
      @if (empty()) {
        <div class="wb-stream__empty">
          <ng-icon name="lucideTerminal" size="28" />
          <p>Press <b class="wb-accent">Run</b> to drive <code>claude -p</code> to completion. The normalized event stream renders here.</p>
        </div>
      } @else {
        @for (item of streamItems(); track item.key) {
          @if (item.kind === 'event') {
            <div class="wb-event-enter"><app-event-row [ev]="item.ev" /></div>
          } @else if (item.kind === 'call') {
            <div class="wb-event-enter"><app-tool-card [call]="item.call" /></div>
          } @else if (item.kind === 'perm') {
            <div class="wb-event-enter"><app-permission-panel [record]="item.p" (decide)="decide.emit($event)" /></div>
          } @else {
            <div class="wb-event-enter"><app-ask-panel [ask]="item.a" (answer)="answer.emit($event)" /></div>
          }
        }
      }
    </div>

    @if (summary(); as s) {
      <div class="wb-summary">
        <div class="wb-summary__head">
          @if (s.is_error) {
            <span class="k-badge k-badge--error"><ng-icon name="lucideXCircle" size="12" /> run.completed</span>
          } @else {
            <span class="k-badge k-badge--success"><ng-icon name="lucideCheckCircle" size="12" /> run.completed</span>
          }
          <span class="wb-summary__note">the form performed</span>
        </div>
        <div class="wb-summary__stats">
          <app-summary-stat label="EXIT" [value]="s.exit_code" [tone]="s.is_error ? 'error' : 'success'" />
          <app-summary-stat label="TURNS" [value]="s.num_turns" />
          <app-summary-stat label="COST" [value]="cost()" />
          <app-summary-stat label="DURATION" [value]="duration()" />
        </div>
        @if (s.result) {
          <div class="wb-summary__result"><app-markdown-body [md]="s.result" /></div>
        }
      </div>
    }
  `,
})
export class ObservePane {
  readonly state = input.required<RunState>();
  readonly events = input.required<StreamEvent[]>();
  readonly spec = input.required<RunSpec>();
  readonly summary = input.required<RunSummary | null>();
  readonly asks = input<AskRecord[]>([]);
  readonly permissions = input<PermissionRecord[]>([]);
  readonly answer = output<{ id: string; answers: string[][] }>();
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();

  private readonly streamEl = viewChild.required<ElementRef<HTMLDivElement>>('stream');
  // Follow the tail until the reader scrolls away. A plain (non-reactive) flag
  // on purpose: only appended content should trigger a scroll, never a change
  // to this flag, otherwise a pending ask would yank the reader back down.
  private stick = true;

  protected readonly statusLabel = computed(() => STATUS_LABEL[this.state()]);
  protected readonly empty = computed(
    () => this.events().length === 0 && !this.summary() && this.asks().length === 0 && this.permissions().length === 0,
  );
  /* A pause belongs where it happened, not in a pile at the end of the
   * transcript. Tool calls are paired first, then each ask and permission
   * record is spliced back by its `at` (see withPauses). */
  protected readonly streamItems = computed(() => withPauses(pairToolEvents(this.events()), this.permissions(), this.asks()));
  protected readonly cost = computed(() => {
    const c = this.summary()?.cost_usd;
    return c != null ? `$${c.toFixed(3)}` : '—';
  });
  protected readonly duration = computed(() => `${((this.summary()?.duration_ms ?? 0) / 1000).toFixed(1)}s`);

  constructor() {
    // Keep the stream pinned to the latest event, but only while the reader is
    // already at the bottom. Runs after render so scrollHeight includes the
    // content that just arrived.
    afterRenderEffect(() => {
      void this.events().length;
      void this.summary();
      void this.asks().length;
      void this.permissions().length;
      const el = this.streamEl().nativeElement;
      if (this.stick) el.scrollTop = el.scrollHeight;
    });
  }

  protected onScroll(): void {
    this.stick = isAtBottom(this.streamEl().nativeElement);
  }
}
