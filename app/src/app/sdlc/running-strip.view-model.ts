import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunKind } from '@bindings/RunKind';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunningStrip } from '@bindings/RunningStrip';
import { KataTransport } from '../core/transport/kata-transport';

/** One run of a change the engineer can open: its repository (null for a review) and whether it waits on the engineer. */
export type RunChoice = { run: number; kind: RunKind; repo: string | null; waiting: boolean; label: string; action: 'Answer' | 'Watch' };

/** One entry as the strip draws it. Everything but the run lists is formatting of what the backend sent. */
export type StripRow = {
  id: string;
  system: string;
  change: string;
  /** The change's name without its date prefix. */
  name: string;
  state: string;
  tone: 'running' | 'awaiting' | 'warning' | 'error' | 'success';
  /** The question or the action asked for, or the reason a run stopped; null when the state has none. */
  text: string | null;
  /** The run an entry opens at once: set only when exactly one run of the change waits on the engineer. */
  direct: RunChoice | null;
  /** The change's runs a list offers; empty for a state with no run to open. */
  choices: RunChoice[];
  /** The entry's whole line, for the hover text. */
  title: string;
};

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const short = (c: ChangeKey): string => c.change.replace(DATE_PREFIX, '');

/** The running-changes strip: what the backend sent, arranged for the toolbar. It decides nothing: which entries show and in what order came from the backend. */
@Injectable()
export class RunningStripViewModel {
  private readonly transport = inject(KataTransport);
  private readonly router = inject(Router);

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

  /** Open the change page, with the run's session picked when a run is given. The session is where the question is answered. */
  open(row: StripRow, choice: RunChoice | null): void {
    void this.router.navigate(['/sdlc', row.system, row.change], { queryParams: choice === null ? {} : { run: choice.run } });
  }
}

function choice(run: number, kind: RunKind, repo: string | null, waiting: boolean): RunChoice {
  return { run, kind, repo, waiting, label: repo ?? kind, action: waiting ? 'Answer' : 'Watch' };
}

function toRow(e: RunningEntry): StripRow {
  const waiting = e.waiting.map((w) => choice(w.run, w.kind, w.repo, true));
  let choices = waiting;
  if (waiting.length === 0 && e.state === 'working') choices = [choice(e.run, e.stage, e.repo, false)];
  const base = { id: `${e.change.workspace.key}|${e.change.system}|${e.change.change}`, system: e.change.system, change: e.change.change, name: short(e.change), direct: waiting.length === 1 ? waiting[0] : null, choices };
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
