import { Injectable, Injector, effect, inject, signal, untracked } from '@angular/core';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { RunSpec } from '@bindings/RunSpec';
import type { AskRecord, PermissionRecord, RunState } from '../../lib/events';
import { ToastStore } from '../toast/toast.store';
import { IDLE, type RunSnapshot } from './reduce';
import { RunStore } from './run.store';

/** The key of a change's document-run session: the workspace folder, the system and the change. */
export const changeRunKey = (ref: ChangeRef): string => `${ref.workspace}|${ref.system}|${ref.change}`;

/** One change's document run, live or finished and not yet closed. */
export type ChangeSession = {
  title: string;
  spec: RunSpec;
  /** The backend's id for the run; null while it is being started, and for a start the backend refused. */
  runId: string | null;
  /** How the run ended, or null while it is live. */
  finished: RunState | null;
  startedAt: number;
  endedAt: number | null;
};

const TERMINAL: readonly RunState[] = ['success', 'warning', 'error'];
const BUSY = 'Another task is already running.';

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return null;
}

const refusal = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The document runs of changes, one session per change, so runs of different changes go at once. Each run is
 * one of `RunStore`'s runs by id; this store only keeps what the page of a change shows around it (title,
 * spec, clock) and holds a finished run until the engineer closes it. What may run together is the backend's
 * decision (it refuses a run that needs a folder another run holds); the only refusal made here is a second
 * run of the same change, which has a session of its own already.
 */
@Injectable({ providedIn: 'root' })
export class ChangeRunStore {
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);
  private readonly injector = inject(Injector);

  private readonly all = signal<ReadonlyMap<string, ChangeSession>>(new Map());
  private readonly clock = signal(Date.now());
  /** When each open question or approval first showed, in milliseconds, keyed by change and pause id. */
  private readonly pendingSince = signal<Readonly<Record<string, number>>>({});
  private timer: ReturnType<typeof setInterval> | null = null;
  private closeWaiters = new Map<string, (() => void)[]>();

  constructor() {
    effect(() => {
      const keys: string[] = [];
      for (const [key, s] of this.all()) {
        const id = s.finished === null ? this.pendingOf(s) : null;
        if (id !== null) keys.push(`${key}:${id}`);
      }
      untracked(() => {
        const known = this.pendingSince();
        const next: Record<string, number> = {};
        for (const k of keys) next[k] = known[k] ?? Date.now();
        const same = keys.length === Object.keys(known).length && keys.every((k) => k in known);
        if (!same) this.pendingSince.set(next);
      });
    });
  }

  /** The change's session, or null when it has none. */
  session(key: string): ChangeSession | null {
    return this.all().get(key) ?? null;
  }

  /** Whether the change has a session, live or finished and not closed. */
  has(key: string): boolean {
    return this.all().has(key);
  }

  /** The folded run of the change's session; idle without one. */
  snapshot(key: string): RunSnapshot {
    const s = this.session(key);
    if (s === null) return IDLE;
    if (s.runId !== null) return this.runs.snapshot(s.runId)();
    return { ...IDLE, state: s.finished ?? 'running' };
  }

  elapsedSecs(key: string): number {
    const s = this.session(key);
    return s === null ? 0 : Math.max(0, Math.floor(((s.endedAt ?? this.clock()) - s.startedAt) / 1000));
  }

  /** Seconds until the engine reaps the change's unanswered run (exit 123), or null when nothing is pending or there is no deadline. */
  deadlineSecs(key: string): number | null {
    const s = this.session(key);
    const timeout = s?.spec.interactive?.answer_timeout_secs ?? null;
    const waited = this.waitedSecs(key);
    return timeout === null || waited === null ? null : Math.max(0, timeout - waited);
  }

  waitedSecs(key: string): number | null {
    const s = this.session(key);
    const id = s === null || s.finished !== null ? null : this.pendingOf(s);
    if (id === null) return null;
    return Math.max(0, Math.floor((this.clock() - (this.pendingSince()[`${key}:${id}`] ?? this.clock())) / 1000));
  }

  /**
   * Run the change's document run and resolve when it ends; the session stays until `close`. `via` starts the run
   * (the backend composes and launches it); a start it refuses is reported with its own words and ends the session.
   */
  async start(key: string, title: string, spec: RunSpec, via: (spec: RunSpec) => Promise<string>): Promise<RunState> {
    if (this.has(key)) {
      this.toasts.error(BUSY);
      return 'error';
    }
    this.put(key, { title, spec, runId: null, finished: null, startedAt: Date.now(), endedAt: null });
    this.startClock();
    let refused: string | null = null;
    const id = await this.runs.startRun(spec, `change:${key}`, async (s) => {
      try {
        return await via(s);
      } catch (e) {
        refused = refusal(e);
        throw e;
      }
    });
    if (id === null) {
      // A start nobody accepted has nothing to show: no session is kept, and the refusal is said in the backend's words.
      if (refused !== null) this.toasts.error(`Could not start the run: ${refused}`);
      this.drop(key);
      return 'error';
    }
    this.patch(key, { runId: id });
    const state = await this.untilEnded(id);
    this.finish(key, state);
    return state;
  }

  /** Resolves once the engineer has closed the finished run; at once when none is held. */
  dismissed(key: string): Promise<void> {
    if (this.session(key)?.finished == null) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.set(key, [...(this.closeWaiters.get(key) ?? []), resolve]));
  }

  /** Close a finished run's session. A live run cannot be closed, only cancelled. */
  close(key: string): void {
    const s = this.session(key);
    if (s === null || s.finished === null) return;
    if (s.runId !== null) this.runs.forget(s.runId);
    this.drop(key);
    const waiters = this.closeWaiters.get(key) ?? [];
    this.closeWaiters.delete(key);
    for (const wake of waiters) wake();
  }

  cancel(key: string): void {
    const s = this.session(key);
    if (s?.runId != null && s.finished === null) void this.runs.cancelRun(s.runId);
  }

  answer(key: string, askId: string, answers: string[][]): void {
    const id = this.session(key)?.runId;
    if (id != null) void this.runs.submitAnswer(id, askId, answers);
  }

  say(key: string, text: string): void {
    const id = this.session(key)?.runId;
    if (id != null) void this.runs.sendMessage(id, text);
  }

  decide(key: string, id: string, allow: boolean, message: string | null): void {
    const run = this.session(key)?.runId;
    if (run != null) void this.runs.submitDecision(run, id, allow, message);
  }

  private pendingOf(s: ChangeSession): string | null {
    if (s.runId === null) return null;
    const snap = this.runs.snapshot(s.runId)();
    const ask: AskRecord | null = lastWhere(snap.asks, (a) => a.answers === null);
    const check: PermissionRecord | null = lastWhere(snap.permissions, (p) => p.decided === null);
    return ask?.id ?? check?.id ?? null;
  }

  private untilEnded(runId: string): Promise<RunState> {
    const view = this.runs.snapshot(runId);
    return new Promise((resolve) => {
      const ref = effect(
        () => {
          const state = view().state;
          if (TERMINAL.includes(state)) {
            untracked(() => {
              ref.destroy();
              resolve(state);
            });
          }
        },
        { injector: this.injector },
      );
    });
  }

  private finish(key: string, state: RunState): void {
    this.patch(key, { finished: state, endedAt: Date.now() });
    this.stopClockIfIdle();
  }

  private drop(key: string): void {
    this.all.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
    this.stopClockIfIdle();
  }

  private put(key: string, s: ChangeSession): void {
    this.all.update((m) => new Map(m).set(key, s));
  }

  private patch(key: string, change: Partial<ChangeSession>): void {
    this.all.update((m) => {
      const s = m.get(key);
      return s ? new Map(m).set(key, { ...s, ...change }) : m;
    });
  }

  private startClock(): void {
    this.clock.set(Date.now());
    this.timer ??= setInterval(() => this.clock.set(Date.now()), 1000);
  }

  private stopClockIfIdle(): void {
    if (this.timer === null || [...this.all().values()].some((s) => s.finished === null)) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
