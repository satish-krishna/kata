import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { OpenRun } from '@bindings/OpenRun';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunningStrip } from '@bindings/RunningStrip';
import type { RunChoice, StripPick, StripRow } from '../lib/running-strip';
import { RunLandingStore } from '../core/run/run-landing.store';
import { KataTransport } from '../core/transport/kata-transport';

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const short = (c: ChangeKey): string => c.change.replace(DATE_PREFIX, '');

/** The running-changes strip: what the backend sent, arranged for the toolbar. It decides nothing: which entries show and in what order came from the backend. */
@Injectable()
export class RunningStripViewModel {
  private readonly transport = inject(KataTransport);
  private readonly router = inject(Router);
  private readonly landing = inject(RunLandingStore);

  private readonly strip = signal<RunningStrip>({ shown: [], all: [] });

  readonly shown = computed(() => this.strip().shown.map(toRow));
  readonly all = computed(() => this.strip().all.map(toRow));
  readonly allLabel = computed(() => `All running (${this.strip().all.length})`);

  constructor() {
    const gone = inject(DestroyRef);
    let alive = true;
    let unlisten: (() => void) | null = null;
    gone.onDestroy(() => {
      alive = false;
      unlisten?.();
    });
    void this.transport.onRunning((s) => this.strip.set(s)).then((off) => (alive ? (unlisten = off) : off()));
    void this.transport.sdlcRunning().then((s) => {
      if (alive) this.strip.set(s);
    });
  }

  /** Open the change page; with a run, ask its page to show that run's session, where a question is answered. */
  open({ row, choice }: StripPick): void {
    if (choice !== null) this.landing.ask({ workspaceId: row.workspaceId, system: row.system, change: row.change, run: choice.open });
    void this.router.navigate(['/sdlc', row.system, row.change]);
  }
}

function choice(open: OpenRun): RunChoice {
  return { ...open, label: open.repo ?? open.kind, action: open.waiting ? 'Answer' : 'Watch', open };
}

function toRow(e: RunningEntry): StripRow {
  // What picking the entry opens is the backend's answer; this only follows it.
  const direct = e.opens.kind === 'session' ? choice(e.opens.run) : null;
  const choices = e.opens.kind === 'list' ? e.opens.runs.map(choice) : [];
  const base = { id: `${e.change.workspace.key}|${e.change.system}|${e.change.change}`, workspaceId: e.workspaceId, system: e.change.system, change: e.change.change, name: short(e.change), direct, choices };
  const row = (state: string, tone: StripRow['tone'], text: string | null): StripRow => ({ ...base, state, tone, text, title: text === null ? state : `${state}: ${text}` });
  switch (e.state) {
    case 'needsAnswer':
      return row('needs an answer', 'awaiting', e.text);
    case 'needsPermission':
      return row('needs a permission', 'awaiting', e.action);
    case 'stopped':
      return row('stopped', 'error', `${e.repo}: ${e.reason}`);
    case 'held':
      return row('held', 'warning', `by ${short(e.holder)}`);
    case 'reviewWaiting':
      return row('review waiting', 'warning', `for ${short(e.holder)}`);
    case 'working':
      return row('working', 'running', e.repo === null ? e.stage : `${e.stage} in ${e.repo}`);
    case 'finished':
      return row('finished', 'success', null);
  }
}
