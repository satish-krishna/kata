import { Component, computed, input } from '@angular/core';
import type { BaseCheck } from '@bindings/BaseCheck';

/** One preparation hook of the step, named apart from the checks. */
export interface PreparationRow {
  id: string;
  what: string;
  state: 'running' | 'passed' | 'failed';
  seconds: number | null;
}

type RowState = 'passed' | 'failed' | 'running' | 'cutOff' | 'notRun' | 'waiting';

interface CheckRow {
  name: string;
  state: RowState;
  /** The word on the row's right: its result, or what it has not done. */
  word: string;
  tone: 'success' | 'error' | 'running' | 'warning' | null;
  /** How long it took, how long it has run, or when it started; empty when there is nothing to say. */
  time: string;
  /** True for the running row, whose time is the ticking elapsed. */
  ticking: boolean;
}

/** `95` is `1m 35s`, `12` is `12s`. */
export const formatSeconds = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

const secondsBetween = (from: string | null, to: number | string | null): number | null => {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = typeof to === 'number' ? to : Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) ? null : (end - start) / 1000;
};

const clock = (iso: string | null): string => {
  const at = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(at) ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/* The two lists the Build tab shows while the base is checked: the preparation hooks, then the checks on the base with the base commit,
 * how many are done, each result as it lands and the running one with its elapsed time. The words and the states are the backend's;
 * this arranges them. The progress sentence sits in a polite live region and changes only when a check starts or ends; the elapsed
 * time ticks outside it, from the check's start time and the `now` the host passes. */
@Component({
  selector: 'app-build-checks-list',
  templateUrl: './build-checks-list.html',
  styleUrl: './build-checks-list.css',
})
export class BuildChecksList {
  readonly checks = input.required<BaseCheck[]>();
  readonly base = input('');
  readonly preparation = input<PreparationRow[]>([]);
  /** The clock in milliseconds since the epoch, for the running check's elapsed time. */
  readonly now = input(0);
  /** True when the checks are read from a build prepared in another session (R2.5). */
  readonly elsewhere = input(false);

  protected readonly total = computed(() => this.checks().length);
  protected readonly done = computed(() => this.checks().filter((c) => c.state === 'passed' || c.state === 'failed').length);
  protected readonly cutOff = computed(() => this.checks().some((c) => c.state === 'cutOff'));
  protected readonly runningName = computed(() => this.checks().find((c) => c.state === 'running')?.check ?? null);

  /** The sentence the live region holds: no time in it, so it changes only when a check starts or ends. */
  protected readonly progress = computed(() => {
    const count = `${this.done()} of ${this.total()} done`;
    const running = this.runningName();
    return running === null ? count : `Running ${running}, ${count}`;
  });

  protected readonly rows = computed<CheckRow[]>(() => {
    const cut = this.cutOff();
    return this.checks().map((c): CheckRow => {
      const took = secondsBetween(c.startedAt, c.endedAt);
      switch (c.state) {
        case 'passed':
          return { name: c.check, state: 'passed', word: 'passed', tone: 'success', time: took === null ? '' : formatSeconds(took), ticking: false };
        case 'failed':
          return { name: c.check, state: 'failed', word: 'failed', tone: 'error', time: took === null ? '' : formatSeconds(took), ticking: false };
        case 'running': {
          const ran = secondsBetween(c.startedAt, this.now());
          return { name: c.check, state: 'running', word: 'running', tone: 'running', time: ran === null ? '' : formatSeconds(ran), ticking: true };
        }
        case 'cutOff': {
          const at = clock(c.startedAt);
          return { name: c.check, state: 'cutOff', word: 'cut off', tone: 'warning', time: at === '' ? '' : `started ${at}`, ticking: false };
        }
        default:
          return { name: c.check, state: cut ? 'notRun' : 'waiting', word: cut ? 'did not run' : 'waiting', tone: null, time: '', ticking: false };
      }
    });
  });

  protected readonly prep = computed(() =>
    this.preparation().map((p) => ({
      ...p,
      tone: p.state === 'passed' ? 'success' : p.state === 'failed' ? 'error' : 'running',
      time: p.seconds === null ? '' : formatSeconds(p.seconds),
    })),
  );
}
