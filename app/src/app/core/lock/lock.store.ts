import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { AskRecord, PermissionRecord, RunState } from '../../lib/events';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';

export type StepState = 'pending' | 'running' | 'done' | 'failed';
export type LockStep = { label: string; state: StepState; detail: string | null };
/** A run view stays after its run ends (`finished` set) until the operator closes it. */
export type StepsView = { kind: 'steps'; title: string; steps: LockStep[] };
/** A build holds the lock once for all its runs and stays after the last one ends (`finished`) until the operator closes it. */
export type BuildView = { kind: 'build'; title: string; runs: string[]; finished: boolean };
export type LockView = StepsView | { kind: 'run'; title: string; finished: RunState | null } | BuildView;
/** A run of the build that is paused on the operator. */
export type Waiting = { runId: string; kind: 'answer' | 'approval' };

const TERMINAL: readonly RunState[] = ['success', 'warning', 'error'];

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return null;
}

const finishedRun = (v: LockView | null): boolean => (v?.kind === 'run' && v.finished !== null) || (v?.kind === 'build' && v.finished);

/**
 * The only owner of "is the app locked". Long work is either Kata's own checks (a step list with a
 * counter, behind a scrim) or one agent run (the session view, which stays after the run ends until
 * the operator closes it). Progress is only ever what is known: counts and clocks, never a percentage or an ETA.
 */
@Injectable({ providedIn: 'root' })
export class LockStore {
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);

  private readonly view = signal<LockView | null>(null);
  private readonly elapsed = signal(0);
  private readonly runSpec = signal<RunSpec | null>(null);
  private readonly answerTimeout = signal<number | null>(null);
  /** When each open question or approval first showed, in elapsed seconds, keyed by run and pause id. */
  private readonly pendingSince = signal<Readonly<Record<string, number>>>({});
  /** The answer deadline of each build run, by run id. */
  private readonly runTimeouts = signal<Readonly<Record<string, number | null>>>({});

  private cancelRequested = false;
  private waiter: ((state: RunState) => void) | null = null;
  private closeWaiters: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  readonly active = this.view.asReadonly();
  readonly elapsedSecs = this.elapsed.asReadonly();
  /** The spec of the run the lock holds, live or finished. */
  readonly spec = this.runSpec.asReadonly();

  /** The question a run is waiting on, if any: the solo run's without an id (in a run view), a build run's with its id. */
  readonly ask = (runId?: string): AskRecord | null => {
    const asks = this.asksOf(runId);
    return asks === null ? null : lastWhere(asks, (a) => a.answers === null);
  };
  /** The permission check a run is waiting on, if any: the solo run's without an id (in a run view), a build run's with its id. */
  readonly permission = (runId?: string): PermissionRecord | null => {
    const checks = this.permissionsOf(runId);
    return checks === null ? null : lastWhere(checks, (p) => p.decided === null);
  };
  /** Seconds until the engine reaps an unanswered run (exit 123), or null when nothing is pending or there is no deadline. */
  readonly deadlineSecs = (runId?: string): number | null => {
    const id = this.pendingOf(runId);
    const timeout = runId === undefined ? this.answerTimeout() : (this.runTimeouts()[runId] ?? null);
    if (id === null || timeout === null) return null;
    return Math.max(0, timeout - (this.elapsed() - (this.pendingSince()[`${runId ?? ''}:${id}`] ?? 0)));
  };
  /** Seconds the run's open question or approval has waited on the operator; null when nothing is pending. */
  readonly waitedSecs = (_runId?: string): number | null => null;
  /** Every run of the build with an open question or approval, whichever view the operator is looking at. */
  readonly waiting = computed<Waiting[]>(() => {
    const v = this.view();
    if (v?.kind !== 'build') return [];
    const out: Waiting[] = [];
    for (const runId of v.runs) {
      if (this.ask(runId) !== null) out.push({ runId, kind: 'answer' });
      else if (this.permission(runId) !== null) out.push({ runId, kind: 'approval' });
    }
    return out;
  });

  /** The pauses open right now as pendingSince keys. */
  private readonly pendingKeys = computed(() => {
    const keys: string[] = [];
    const solo = this.pendingOf(undefined);
    if (solo !== null) keys.push(`:${solo}`);
    for (const w of this.waiting()) keys.push(`${w.runId}:${this.pendingOf(w.runId)}`);
    return keys;
  });

  private asksOf(runId: string | undefined): readonly AskRecord[] | null {
    const v = this.view();
    if (runId === undefined) return v?.kind === 'run' ? this.runs.asks() : null;
    return this.buildRun(runId) ? this.runs.snapshot(runId)().asks : null;
  }

  private permissionsOf(runId: string | undefined): readonly PermissionRecord[] | null {
    const v = this.view();
    if (runId === undefined) return v?.kind === 'run' ? this.runs.permissions() : null;
    return this.buildRun(runId) ? this.runs.snapshot(runId)().permissions : null;
  }

  /** A run of the held build that is still going; a run that has stopped is no longer waiting on anyone. */
  private buildRun(runId: string): boolean {
    const v = this.view();
    return v?.kind === 'build' && v.runs.includes(runId) && this.runs.snapshot(runId)().state === 'awaiting';
  }

  private pendingOf(runId: string | undefined): string | null {
    return this.ask(runId)?.id ?? this.permission(runId)?.id ?? null;
  }

  constructor() {
    // Resolves runAgent. It reads events and summary as well as state so a run that finishes
    // between two flushes still wakes the effect even if state ends where it started.
    effect(() => {
      const state = this.runs.state();
      this.runs.events();
      this.runs.summary();
      untracked(() => this.settle(state));
    });
    // Each pause keeps the clock reading from when it first showed; a pause that closed is forgotten.
    effect(() => {
      const keys = this.pendingKeys();
      untracked(() => {
        const known = this.pendingSince();
        const next: Record<string, number> = {};
        for (const key of keys) next[key] = known[key] ?? this.elapsed();
        const same = keys.length === Object.keys(known).length && keys.every((k) => k in known);
        if (!same) this.pendingSince.set(next);
      });
    });
  }

  async runSteps(
    title: string,
    steps: { label: string; run: () => Promise<string | null> }[],
  ): Promise<'done' | 'cancelled' | 'failed'> {
    if (this.view() !== null) {
      this.toasts.error('Another task is already running.');
      return 'failed';
    }
    this.cancelRequested = false;
    this.begin({ kind: 'steps', title, steps: steps.map((s) => ({ label: s.label, state: 'pending', detail: null })) });
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.cancelRequested) return 'cancelled';
        this.patch(i, { state: 'running' });
        try {
          this.patch(i, { state: 'done', detail: await steps[i].run() });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.patch(i, { state: 'failed', detail: message });
          this.toasts.error(`${steps[i].label} failed: ${message}`);
          return 'failed';
        }
      }
      return 'done';
    } finally {
      this.end();
    }
  }

  async runAgent(title: string, spec: RunSpec): Promise<RunState> {
    const busy = this.runs.state();
    if (this.view() !== null || busy === 'running' || busy === 'awaiting') {
      this.toasts.error('Another task is already running.');
      return 'error';
    }
    this.runSpec.set(spec);
    this.answerTimeout.set(spec.interactive?.answer_timeout_secs ?? null);
    this.begin({ kind: 'run', title, finished: null });
    const done = new Promise<RunState>((resolve) => (this.waiter = resolve));
    let state: RunState | null = null;
    try {
      await this.runs.startRun(spec);
      this.settle(this.runs.state());
      state = await done;
      return state;
    } finally {
      this.waiter = null;
      if (state === null) this.end();
      else this.hold(title, state);
    }
  }

  /** Resolves once the operator has closed the finished run; at once when no finished run is held. */
  dismissed(): Promise<void> {
    if (!finishedRun(this.view())) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /** Close a finished run's session view and release the lock. A live run cannot be closed, only cancelled. */
  close(): void {
    const view = this.view();
    if (!finishedRun(view)) return;
    if (view?.kind === 'build') for (const id of view.runs) this.runs.forget(id);
    this.end();
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Stops before the next step in a steps lock; cancels a live run in a run lock. */
  cancel(): void {
    const view = this.view();
    if (view?.kind === 'steps') this.cancelRequested = true;
    else if (view?.kind === 'run' && view.finished === null) void this.runs.cancelRun();
  }

  /** Take the lock once for a whole build, refusing while anything else holds it. Its runs join with `addRun`. */
  beginBuild(title: string): boolean {
    const busy = this.runs.state();
    if (this.view() !== null || busy === 'running' || busy === 'awaiting') {
      this.toasts.error('Another task is already running.');
      return false;
    }
    this.begin({ kind: 'build', title, runs: [], finished: false });
    return true;
  }

  /** Add a started run to the held build; its spec sets the answer deadline of its pauses. */
  addRun(runId: string, spec?: RunSpec): void {
    this.view.update((v) => (v?.kind === 'build' && !v.runs.includes(runId) ? { ...v, runs: [...v.runs, runId] } : v));
    if (spec) this.runTimeouts.update((t) => ({ ...t, [runId]: spec.interactive?.answer_timeout_secs ?? null }));
  }

  /** The build is over: freeze the clock and keep its view until the operator closes it. */
  endBuild(): void {
    if (this.view()?.kind !== 'build') return;
    this.stopClock();
    this.view.update((v) => (v?.kind === 'build' ? { ...v, finished: true } : v));
  }

  /** A stopped build is continued: reopen its finished view and start the clock again from where it stopped. */
  resumeBuild(): void {
    const v = this.view();
    if (v?.kind !== 'build' || !v.finished) return;
    this.stopClock();
    this.startedAt = Date.now() - this.elapsed() * 1000;
    this.view.set({ ...v, finished: false });
    this.timer = setInterval(() => this.elapsed.set(Math.floor((Date.now() - this.startedAt) / 1000)), 1000);
  }

  /** Answer a question: `(askId, answers)` for the solo run, `(runId, askId, answers)` for a build run. */
  answer(askId: string, answers: string[][]): void;
  answer(runId: string, askId: string, answers: string[][]): void;
  answer(...args: [string, string[][]] | [string, string, string[][]]): void {
    if (args.length === 2) void this.runs.submitAnswer(args[0], args[1]);
    else void this.runs.submitAnswer(args[0], args[1], args[2]);
  }

  /** Decide a permission check: `(id, allow, message)` for the solo run, `(runId, id, allow, message)` for a build run. */
  decide(id: string, allow: boolean, message: string | null): void;
  decide(runId: string, id: string, allow: boolean, message: string | null): void;
  decide(...args: [string, boolean, string | null] | [string, string, boolean, string | null]): void {
    if (args.length === 3) void this.runs.submitDecision(args[0], args[1], args[2]);
    else void this.runs.submitDecision(args[0], args[1], args[2], args[3]);
  }

  private settle(state: RunState): void {
    if (this.waiter && TERMINAL.includes(state)) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(state);
    }
  }

  private patch(index: number, change: Partial<LockStep>): void {
    this.view.update((v) =>
      v?.kind === 'steps' ? { ...v, steps: v.steps.map((s, i) => (i === index ? { ...s, ...change } : s)) } : v,
    );
  }

  private begin(view: LockView): void {
    this.startedAt = Date.now();
    this.elapsed.set(0);
    this.pendingSince.set({});
    this.view.set(view);
    this.timer = setInterval(() => this.elapsed.set(Math.floor((Date.now() - this.startedAt) / 1000)), 1000);
  }

  /** The run is over: freeze the clock and keep its view until the operator closes it. */
  private hold(title: string, finished: RunState): void {
    this.stopClock();
    this.view.set({ kind: 'run', title, finished });
  }

  private stopClock(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private end(): void {
    this.stopClock();
    this.view.set(null);
    this.runSpec.set(null);
    this.answerTimeout.set(null);
    this.runTimeouts.set({});
  }
}
