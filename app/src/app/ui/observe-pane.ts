import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheckCircle, lucideCpu, lucideGitBranch, lucideTerminal, lucideXCircle } from '@ng-icons/lucide';
import { HlmEmptyImports } from '@spartan-ng/helm/empty';
import { HlmMessageScrollerImports } from '@spartan-ng/helm/message-scroller';
import type { RunSpec } from '@bindings/RunSpec';
import { STATUS_LABEL, type AskRecord, type PermissionRecord, type RunState, type RunSummary, type StreamEvent } from '../lib/events';
import { pairToolEvents, withPauses, type PausedItem } from '../lib/toolcards';
import { AskPanel } from './ask-panel';
import { EventRow } from './event-row';
import { MarkdownBody } from './markdown-body';
import { PermissionPanel } from './permission-panel';
import { SummaryStat } from './summary-stat';
import { ToolCard } from './tool-card';

@Component({
  selector: 'app-observe-pane',
  host: { class: 'wb-observe' },
  imports: [NgIcon, HlmEmptyImports, HlmMessageScrollerImports, EventRow, ToolCard, SummaryStat, AskPanel, PermissionPanel, MarkdownBody],
  providers: [provideIcons({ lucideCpu, lucideGitBranch, lucideTerminal, lucideCheckCircle, lucideXCircle })],
  templateUrl: './observe-pane.html',
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
  protected readonly cost = computed(() => {
    const c = this.summary()?.cost_usd;
    return c != null ? `$${c.toFixed(3)}` : '—';
  });
  protected readonly duration = computed(() => `${((this.summary()?.duration_ms ?? 0) / 1000).toFixed(1)}s`);

  /* Svelte drew a pending and a settled pause from separate branches, so
   * settling remounted the card and replayed its fade-in. The key changes only
   * at settle, so an open panel is never recreated by unrelated arrivals. */
  protected trackKey(item: PausedItem): string {
    if (item.kind === 'perm') return `${item.key}:${item.p.decided ? 'done' : 'open'}`;
    if (item.kind === 'ask') return `${item.key}:${item.a.answers ? 'done' : 'open'}`;
    return item.key;
  }
}
