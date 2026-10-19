import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { AskRecord, PermissionRecord, RunState } from '../../lib/events';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';

export type StepState = 'pending' | 'running' | 'done' | 'failed';
export type LockStep = { label: string; state: StepState; detail: string | null };
export type LockView = { kind: 'steps'; title: string; steps: LockStep[] } | { kind: 'run'; title: string };

const TERMINAL: readonly RunState[] = ['success', 'warning', 'error'];

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return null;
}

/**
 * The only owner of "is the app locked". Long work runs behind a scrim: either Kata's own
 * checks (a step list with a counter) or one agent run (live activity). Progress is only ever
 * what is known: counts and clocks, never a percentage or an ETA.
 */
@Injectable({ providedIn: 'root' })
export class LockStore {
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);

  private readonly view = signal<LockView | null>(null);
  private readonly elapsed = signal(0);
  private readonly runModel = signal<string | null>(null);
  private readonly answerTimeout = signal<number | null>(null);
  private readonly pendingSince = signal(0);

  private cancelRequested = false;
  private waiter: ((state: RunState) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  readonly active = this.view.asReadonly();
  readonly elapsedSecs = this.elapsed.asReadonly();

  private readonly inRun = computed(() => this.view()?.kind === 'run');

  readonly model = computed(() => (this.inRun() ? this.runModel() : null));
  readonly turn = computed(() => {
    if (!this.inRun()) return null;
    const ev = lastWhere(this.runs.events(), (e) => e.type === 'turn' && !e.parent_id);
    return ev?.type === 'turn' ? ev.n : null;
  });
  readonly lastTool = computed(() => {
    if (!this.inRun()) return null;
    const ev = lastWhere(this.runs.events(), (e) => e.type === 'tool.use');
    if (ev?.type !== 'tool.use') return null;
    return ev.input_summary ? `${ev.name} ${ev.input_summary}` : ev.name;
  });
  /** The question the run is waiting on, if any. */
  readonly ask = computed<AskRecord | null>(() => (this.inRun() ? lastWhere(this.runs.asks(), (a) => a.answers === null) : null));
  /** The permission check the run is waiting on, if any. */
  readonly permission = computed<PermissionRecord | null>(() =>
    this.inRun() ? lastWhere(this.runs.permissions(), (p) => p.decided === null) : null,
  );
  /** Seconds until the engine reaps an unanswered run (exit 123), or null when nothing is pending or there is no deadline. */
  readonly deadlineSecs = computed(() => {
    const timeout = this.answerTimeout();
    if (timeout === null || (this.ask() ?? this.permission()) === null) return null;
    return Math.max(0, timeout - (this.elapsed() - this.pendingSince()));
  });

  private readonly pendingId = computed(() => this.ask()?.id ?? this.permission()?.id ?? null);

  constructor() {
    // Resolves runAgent. It reads events and summary as well as state so a run that finishes
    // between two flushes still wakes the effect even if state ends where it started.
    effect(() => {
      const state = this.runs.state();
      this.runs.events();
      this.runs.summary();
      untracked(() => this.settle(state));
    });
    effect(() => {
      const id = this.pendingId();
      if (id !== null) untracked(() => this.pendingSince.set(this.elapsed()));
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
    this.runModel.set(spec.model.id ?? null);
    this.answerTimeout.set(spec.interactive?.answer_timeout_secs ?? null);
    this.begin({ kind: 'run', title });
    const done = new Promise<RunState>((resolve) => (this.waiter = resolve));
    try {
      await this.runs.startRun(spec);
      this.settle(this.runs.state());
      return await done;
    } finally {
      this.waiter = null;
      this.end();
    }
  }

  /** Stops before the next step in a steps lock; cancels the run in a run lock. */
  cancel(): void {
    const view = this.view();
    if (view?.kind === 'steps') this.cancelRequested = true;
    else if (view?.kind === 'run') void this.runs.cancelRun();
  }

  answer(id: string, answers: string[][]): void {
    void this.runs.submitAnswer(id, answers);
  }

  decide(id: string, allow: boolean, message: string | null): void {
    void this.runs.submitDecision(id, allow, message);
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
    this.pendingSince.set(0);
    this.view.set(view);
    this.timer = setInterval(() => this.elapsed.set(Math.floor((Date.now() - this.startedAt) / 1000)), 1000);
  }

  private end(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.view.set(null);
    this.runModel.set(null);
    this.answerTimeout.set(null);
  }
}
