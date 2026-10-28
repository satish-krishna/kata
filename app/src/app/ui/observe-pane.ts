import { Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheckCircle, lucideCpu, lucideGitBranch, lucideTerminal, lucideXCircle } from '@ng-icons/lucide';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmMessageScrollerImports } from '@spartan-ng/helm/message-scroller';
import type { Mode } from '@bindings/Mode';
import type { RunSpec } from '@bindings/RunSpec';
import { STATUS_LABEL, type AskRecord, type MessageRecord, type MessageRefusal, type RunGiven, type PermissionRecord, type RunState, type RunSummary, type StreamEvent } from '../lib/events';
import { pairToolEvents, withPauses, type PausedItem } from '../lib/toolcards';
import { AskPanel } from './ask-panel';
import { EventRow } from './event-row';
import { GivenView } from './given-view';
import { MarkdownBody } from './markdown-body';
import { PermissionPanel } from './permission-panel';
import { SummaryStat } from './summary-stat';
import { ToolCard } from './tool-card';

@Component({
  selector: 'app-observe-pane',
  host: { class: 'wb-observe' },
  imports: [NgIcon, HlmButtonImports, HlmDialogImports, HlmEmptyImports, HlmMessageScrollerImports, EventRow, ToolCard, SummaryStat, AskPanel, PermissionPanel, MarkdownBody, GivenView],
  providers: [provideIcons({ lucideCpu, lucideGitBranch, lucideTerminal, lucideCheckCircle, lucideXCircle })],
  templateUrl: './observe-pane.html',
})
export class ObservePane {
  readonly state = input.required<RunState>();
  readonly events = input.required<StreamEvent[]>();
  /** The spec the run started with; null for an earlier run read from the records, which shows no model or isolation. */
  readonly spec = input.required<RunSpec | null>();
  readonly summary = input.required<RunSummary | null>();
  readonly asks = input<AskRecord[]>([]);
  readonly permissions = input<PermissionRecord[]>([]);
  /** What the run was given (the last `run.given`), or null before one arrives. */
  readonly given = input<RunGiven | null>(null);
  /** Which mode started the run; it only changes how a run-spec setting's source reads. */
  readonly mode = input<Mode>('workbench');
  /** The index of the first event the engineer has not seen, when they come back to a pane that kept running. */
  readonly unseenFrom = input<number | null>(null);
  readonly messages = input<MessageRecord[]>([]);
  readonly refusal = input<MessageRefusal | null>(null);
  readonly say = output<string>();
  readonly answer = output<{ id: string; answers: string[][] }>();
  readonly decide = output<{ id: string; allow: boolean; message: string | null }>();

  protected readonly givenOpen = signal(false);
  protected readonly warnings = computed(() => this.given()?.warnings ?? []);
  protected readonly statusLabel = computed(() => STATUS_LABEL[this.state()]);
  /** An open pause outlives its run (cancel, deadline exit); it must not stay answerable. */
  protected readonly ended = computed(() => this.state() !== 'running' && this.state() !== 'awaiting');
  protected readonly empty = computed(
    () => this.events().length === 0 && !this.summary() && this.asks().length === 0 && this.permissions().length === 0,
  );
  /* A pause belongs where it happened, not in a pile at the end of the
   * transcript. Tool calls are paired first, then each ask and permission
   * record is spliced back by its `at` (see withPauses). */
  protected readonly streamItems = computed(() => withPauses(pairToolEvents(this.events()), this.permissions(), this.asks()));
  protected readonly unseenCount = computed(() => {
    const from = this.unseenFrom();
    return from === null ? 0 : Math.max(0, this.events().length - from);
  });
  /** The item the "new below" marker sits in front of: the first one that opened at or after the first unseen event. */
  protected readonly markerKey = computed(() => {
    const from = this.unseenFrom();
    if (from === null || this.unseenCount() === 0) return null;
    const at = (item: PausedItem): number => (item.kind === 'perm' ? item.p.at : item.kind === 'ask' ? item.a.at : item.at);
    return this.streamItems().find((item) => at(item) >= from)?.key ?? null;
  });
  protected readonly cost = computed(() => {
    const c = this.summary()?.cost_usd;
    return c != null ? `$${c.toFixed(3)}` : '—';
  });
  protected readonly duration = computed(() => `${((this.summary()?.duration_ms ?? 0) / 1000).toFixed(1)}s`);

  /** Escape and a backdrop click close the overlay from inside. */
  protected onGivenState(state: BrnDialogState): void {
    if (state === 'closed') this.givenOpen.set(false);
  }

  /* Svelte drew a pending and a settled pause from separate branches, so
   * settling remounted the card and replayed its fade-in. The key changes only
   * at settle, so an open panel is never recreated by unrelated arrivals. */
  protected trackKey(item: PausedItem): string {
    if (item.kind === 'perm') return `${item.key}:${item.p.decided ? 'done' : 'open'}`;
    if (item.kind === 'ask') return `${item.key}:${item.a.answers ? 'done' : 'open'}`;
    return item.key;
  }
}
