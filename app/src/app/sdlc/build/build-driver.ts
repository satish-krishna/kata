import { signal } from '@angular/core';
import type { BuildStatus } from '@bindings/BuildStatus';
import { stopMessage } from '../../lib/sdlc';

export interface RunEnd {
  exit: number | null;
  error: string | null;
}

export interface RunOptions {
  timeoutSecs: number;
  instructions?: string;
  signal: AbortSignal;
}

export type RunTarget = { repo: string } | 'review';

export interface BuildDriverDeps {
  status: () => Promise<BuildStatus>;
  start: (target: RunTarget, opts: RunOptions) => Promise<RunEnd>;
  heads: () => Promise<Record<string, string>>;
}

export type BuildPhase = 'building' | 'reviewing' | 'stopped' | 'finished' | 'cancelled';

export interface WaitingRepo {
  repo: string;
  task: string;
  onTask: string;
  onRepo: string;
}

export interface StopReport {
  unfinished: { repo: string; tasks: string[] }[];
  waiting: WaitingRepo[];
}

const REVIEW = 'review';

/**
 * Drives a build: one run per repository at a time, every repository whose turn it is started at once,
 * a repository that has to wait left waiting, and one review of the whole change when every task has a row.
 * Rows are read only through `deps.status`; nothing here reads a plan or a build log.
 */
export class BuildDriver {
  readonly going = signal<ReadonlySet<string>>(new Set());
  readonly stopped = signal<ReadonlyMap<string, { task: string; reason: string }>>(new Map());
  readonly round = signal<{ repo: string; instructions: string } | null>(null);
  readonly phase = signal<BuildPhase>('building');
  readonly waiting = signal<WaitingRepo[]>([]);
  readonly report = signal<StopReport | null>(null);

  private timeoutSecs = 0;
  private roundStarted = false;
  private reviewing = false;
  private cancelledAll = false;
  private compare: Record<string, string> | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelling = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BuildDriverDeps) {}

  async begin(timeoutSecs: number, round?: { repo: string; instructions: string }): Promise<void> {
    this.timeoutSecs = timeoutSecs;
    this.cancelledAll = false;
    this.stopped.set(new Map());
    this.report.set(null);
    this.round.set(round ?? null);
    this.roundStarted = false;
    this.phase.set('building');
    if (round && this.compare === null) this.compare = await this.deps.heads();
    await this.enqueue(() => this.look());
  }

  async continueRepo(repo: string): Promise<void> {
    this.release([repo]);
    await this.enqueue(() => this.look());
  }

  async continueAll(): Promise<void> {
    this.release([...this.stopped().keys()]);
    await this.enqueue(() => this.look());
  }

  cancel(repo: string): void {
    this.cancelling.add(repo);
    this.controllers.get(repo)?.abort();
  }

  cancelAll(): void {
    this.cancelledAll = true;
    this.controllers.forEach((c) => c.abort());
    if (this.controllers.size === 0) this.phase.set('cancelled');
  }

  private release(repos: string[]): void {
    const next = new Map(this.stopped());
    repos.forEach((r) => next.delete(r));
    this.stopped.set(next);
    this.cancelledAll = false;
    this.report.set(null);
    if (this.phase() === 'stopped' || this.phase() === 'cancelled') this.phase.set('building');
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.tail.then(job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private markStopped(key: string, task: string, reason: string): void {
    this.stopped.set(new Map(this.stopped()).set(key, { task, reason }));
  }

  private async look(): Promise<void> {
    if (this.cancelledAll) return this.settleCancel();
    const status = await this.deps.status();
    if (this.cancelledAll) return this.settleCancel();

    const waiting: WaitingRepo[] = [];
    const ready: { repo: string; task: string }[] = [];
    for (const r of status.repos) {
      const task = r.state.kind === 'ready' ? r.state.task : '';
      if (r.state.kind === 'waiting') {
        waiting.push({ repo: r.repo, task: r.state.task, onTask: r.state.onTask, onRepo: r.state.onRepo });
        continue;
      }
      if (this.going().has(r.repo)) continue;
      const round = this.round();
      const picked = round?.repo === r.repo && !this.roundStarted;
      if (r.state.kind === 'done' && !picked) continue;
      if (this.stopped().get(r.repo)?.task === task) continue;
      ready.push({ repo: r.repo, task });
    }
    this.waiting.set(waiting);

    // A round for a repository the plan names no task in (the master) has no state row; it still runs.
    const pending = this.round();
    if (
      pending &&
      !this.roundStarted &&
      !status.repos.some((r) => r.repo === pending.repo) &&
      !this.going().has(pending.repo) &&
      !this.stopped().has(pending.repo)
    ) {
      ready.push({ repo: pending.repo, task: '' });
    }

    for (const r of ready) {
      const round = this.round();
      const picked = round?.repo === r.repo && !this.roundStarted;
      if (picked) this.roundStarted = true;
      this.launch(r.repo, r.task, picked ? round.instructions : undefined);
    }
    if (ready.length > 0) {
      this.phase.set('building');
      return;
    }
    if (this.going().size > 0 || this.reviewing) return;

    const complete = status.hasTasks && status.tasks.every((t) => t.row !== null);
    // A repository that stopped (a round on a finished one, or on the master, has no unfinished task) is never "finished".
    if (!complete || this.stopped().size > 0) {
      this.phase.set('stopped');
      this.report.set(this.reportFor(status, waiting));
      return;
    }
    const heads = await this.deps.heads();
    if (this.compare !== null && sameHeads(heads, this.compare)) {
      this.phase.set('finished');
      return;
    }
    this.compare = heads;
    this.reviewing = true;
    this.phase.set('reviewing');
    this.launch(REVIEW, REVIEW);
  }

  private reportFor(status: BuildStatus, waiting: WaitingRepo[]): StopReport {
    const unfinished: StopReport['unfinished'] = [];
    for (const t of status.tasks) {
      if (t.row) continue;
      const entry = unfinished.find((u) => u.repo === t.repo);
      if (entry) entry.tasks.push(t.id);
      else unfinished.push({ repo: t.repo, tasks: [t.id] });
    }
    return { unfinished, waiting };
  }

  private settleCancel(): void {
    if (this.controllers.size === 0) this.phase.set('cancelled');
  }

  private launch(key: string, task: string, instructions?: string): void {
    const ctl = new AbortController();
    this.controllers.set(key, ctl);
    if (key !== REVIEW) this.going.set(new Set(this.going()).add(key));
    const opts: RunOptions = { timeoutSecs: this.timeoutSecs, signal: ctl.signal };
    if (instructions !== undefined) opts.instructions = instructions;
    const target: RunTarget = key === REVIEW ? REVIEW : { repo: key };
    void (async () => this.deps.start(target, opts))()
      .catch((e: unknown): RunEnd => ({ exit: null, error: e instanceof Error ? e.message : String(e) }))
      .then((end) =>
        this.enqueue(() => this.ended(key, task, end)).catch(() => {
          // Other runs still going end through `look` and settle the phase then; stopping now would end the build under them.
          if (this.going().size === 0 && !this.reviewing) this.phase.set('stopped');
        }),
      );
  }

  private async ended(key: string, task: string, end: RunEnd): Promise<void> {
    this.controllers.delete(key);
    const next = new Set(this.going());
    next.delete(key);
    this.going.set(next);
    const cancelled = this.cancelling.delete(key);

    if (key === REVIEW) {
      this.reviewing = false;
      if (end.exit !== 0 || end.error) {
        this.compare = null;
        this.markStopped(REVIEW, REVIEW, stopMessage(end.exit, end.error));
      }
    } else {
      await this.judge(key, task, end, cancelled);
      // A round that stopped is not over: it stays, so Continue runs it again with its instructions.
      if (this.round()?.repo === key && this.roundStarted) {
        if (this.stopped().has(key)) this.roundStarted = false;
        else this.round.set(null);
      }
    }
    if (this.cancelledAll) return this.settleCancel();
    await this.look();
  }

  private async judge(repo: string, task: string, end: RunEnd, cancelled: boolean): Promise<void> {
    const status = await this.deps.status();
    const now = status.repos.find((r) => r.repo === repo);
    const recorded = task === '' || status.tasks.some((t) => t.id === task && t.row !== null);
    const blocked = now?.state.kind === 'waiting';
    const failed = end.exit !== 0 || end.error !== null;
    if (cancelled) {
      const current = now?.state.kind === 'ready' ? now.state.task : task;
      if (now?.state.kind !== 'done') this.markStopped(repo, current, stopMessage(end.exit, end.error));
    } else if (task === '' ? failed : failed || (!recorded && !blocked)) {
      const current = now?.state.kind === 'ready' || now?.state.kind === 'waiting' ? now.state.task : task;
      this.markStopped(repo, current, stopMessage(end.exit, end.error));
    }
  }
}

function sameHeads(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}
