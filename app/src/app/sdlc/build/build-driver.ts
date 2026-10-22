import { signal } from '@angular/core';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { BuildChoices } from '../../core/given/given.store';
import { stopMessage } from '../../lib/sdlc';

export interface RunEnd {
  exit: number | null;
  error: string | null;
  /** The run never started because its repository is not checked out (R2.4): the stop says so alone, not that the agent failed. */
  refused?: true;
}

/** A repository the build needs has no checkout in this workspace (R2.4). */
export class NotCheckedOut extends Error {
  constructor(repo: string) {
    super(`${repo} is not checked out in this workspace`);
  }
}

export interface RunOptions {
  timeoutSecs: number;
  instructions?: string;
  signal: AbortSignal;
  choices: BuildChoices;
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

/** One launched run: its id is never reused, so a cancel aimed at it cannot be mistaken for one aimed at the repository's next run. */
interface RunInstance {
  id: number;
  ctl: AbortController;
  cancelled: boolean;
}

/**
 * Drives a build: one run per repository at a time, every repository whose turn it is started at once,
 * a repository that has to wait left waiting, and one review of the whole change when every task has a row.
 * Rows are read only through `deps.status`; nothing here reads a plan or a build log.
 */
export class BuildDriver {
  readonly going = signal<ReadonlySet<string>>(new Set());
  readonly stopped = signal<ReadonlyMap<string, { task: string; reason: string; held?: boolean }>>(new Map());
  readonly round = signal<{ repo: string; instructions: string } | null>(null);
  readonly phase = signal<BuildPhase>('building');
  readonly waiting = signal<WaitingRepo[]>([]);
  readonly report = signal<StopReport | null>(null);

  private timeoutSecs = 0;
  private roundStarted = false;
  private reviewing = false;
  private cancelledAll = false;
  private compare: Record<string, string> | null = null;
  /** The run going in each repository (or the review), by key. A cancel marks the instance it found, so it can never reach a later run. */
  private readonly instances = new Map<string, RunInstance>();
  private instanceSeq = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BuildDriverDeps) {}

  setChoices(_choices: BuildChoices): void {}

  async begin(timeoutSecs: number, round?: { repo: string; instructions: string }, _choices?: BuildChoices): Promise<void> {
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
    const run = this.instances.get(repo);
    if (run) this.cancelInstance(run);
  }

  cancelAll(): void {
    this.cancelledAll = true;
    this.instances.forEach((run) => this.cancelInstance(run));
    if (this.instances.size === 0) this.phase.set('cancelled');
  }

  private cancelInstance(run: RunInstance): void {
    run.cancelled = true;
    run.ctl.abort();
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

  private markStopped(key: string, task: string, reason: string, held = false): void {
    this.stopped.set(new Map(this.stopped()).set(key, held ? { task, reason, held } : { task, reason }));
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
      const stop = this.stopped().get(r.repo);
      // A held stop (the status could not be read when the run ended) does not know the task the repository is on now.
      if (stop && (stop.held || stop.task === task)) continue;
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
    if (this.instances.size === 0) this.phase.set('cancelled');
  }

  private launch(key: string, task: string, instructions?: string): void {
    const run: RunInstance = { id: ++this.instanceSeq, ctl: new AbortController(), cancelled: false };
    this.instances.set(key, run);
    if (key !== REVIEW) this.going.set(new Set(this.going()).add(key));
    const opts = { timeoutSecs: this.timeoutSecs, signal: run.ctl.signal } as RunOptions;
    if (instructions !== undefined) opts.instructions = instructions;
    const target: RunTarget = key === REVIEW ? REVIEW : { repo: key };
    void (async () => this.deps.start(target, opts))()
      .catch((e: unknown): RunEnd => {
        const error = e instanceof Error ? e.message : String(e);
        return e instanceof NotCheckedOut ? { exit: null, error, refused: true } : { exit: null, error };
      })
      .then((end) =>
        this.enqueue(() => this.ended(key, run, task, end, instructions !== undefined)).catch(() => {
          // Other runs still going end through `look` and settle the phase then; stopping now would end the build under them.
          if (this.going().size === 0 && !this.reviewing) this.phase.set('stopped');
        }),
      );
  }

  private async ended(key: string, run: RunInstance, task: string, end: RunEnd, isRound: boolean): Promise<void> {
    if (this.instances.get(key) === run) this.instances.delete(key);
    const next = new Set(this.going());
    next.delete(key);
    this.going.set(next);

    if (key === REVIEW) {
      this.reviewing = false;
      if (end.exit !== 0 || end.error) {
        this.compare = null;
        this.markStopped(REVIEW, REVIEW, stopMessage(end.exit, end.error, run.cancelled));
      } else {
        // The review records its findings in a commit of its own in the master. That is not new work to review:
        // compare later rounds with the heads as the review left them, or every review would start the next.
        this.compare = await this.deps.heads();
      }
    } else {
      const outcome = await this.judge(key, task, end, run.cancelled, isRound);
      // The one place a round is cleared: only when it finished. Every other outcome keeps it pending,
      // so its instructions go with the next launch of the repository.
      if (this.round()?.repo === key && this.roundStarted) {
        if (outcome.kind === 'finished') this.round.set(null);
        else this.roundStarted = false;
      }
    }
    if (this.cancelledAll) return this.settleCancel();
    await this.look();
  }

  /** Reads the status, looks the outcome up and acts on it. A status that cannot be read is 'unknown'; it never loses the result. */
  private async judge(repo: string, task: string, end: RunEnd, cancelled: boolean, isRound: boolean): Promise<Outcome> {
    let status: BuildStatus | null = null;
    try {
      status = await this.deps.status();
    } catch {
      status = null;
    }
    const now = status?.repos.find((r) => r.repo === repo);
    const facts: Facts = {
      kind: isRound ? 'round' : 'task',
      cancelled,
      failed: end.exit !== 0 || end.error !== null,
      // A launch task of '' (the master, or a repository with every task recorded) has nothing to record; any other needs its committed row.
      recorded: task === '' || (status?.tasks.some((t) => t.id === task && t.row !== null) ?? false),
      // A repository the plan names no task in (the master) has no state row and nothing unfinished.
      stateAfter: status === null ? 'unknown' : (now?.state.kind ?? 'done'),
    };
    let outcome: Outcome;
    let why = facts.stateAfter === 'unknown' ? ' · could not read build status' : '';
    try {
      outcome = runOutcome(facts);
    } catch {
      // A combination the table calls impossible happened anyway: hold the stop rather than guess.
      outcome = HELD;
      why = ' · could not tell where the build stands';
    }
    if (outcome.kind === 'stop') this.stopAtCurrentTask(repo, task, now, end, cancelled, outcome.held === true, why);
    return outcome;
  }

  /** Records the stop at the task the repository is on now (ready or waiting), so it never relaunches by itself when that task becomes ready. */
  private stopAtCurrentTask(
    repo: string,
    launchedOn: string,
    now: BuildStatus['repos'][number] | undefined,
    end: RunEnd,
    cancelled: boolean,
    held: boolean,
    why: string,
  ): void {
    // A repository with every task recorded has no task: `look` sees '' for it, so the stop must match that.
    const current = now?.state.kind === 'ready' || now?.state.kind === 'waiting' ? now.state.task : now?.state.kind === 'done' ? '' : launchedOn;
    const text = end.refused && !cancelled ? `Stopped: ${end.error}` : stopMessage(end.exit, end.error, cancelled);
    this.markStopped(repo, current, text + why, held);
  }
}

function sameHeads(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

/** What a finished run of one repository tells the driver, with nothing about how it was found out. */
export interface Facts {
  kind: 'task' | 'round';
  cancelled: boolean;
  /** Nonzero exit or an error. */
  failed: boolean;
  /** The launched task has a committed row, or there was no launched task (''). The same for a task run and a round. */
  recorded: boolean;
  /** Where the repository stands once the run is over; 'unknown' when the status read threw. */
  stateAfter: 'ready' | 'waiting' | 'done' | 'unknown';
}

export type Outcome = { kind: 'stop'; held?: boolean } | { kind: 'finished' } | { kind: 'continue' };

const STOP: Outcome = { kind: 'stop' };
/** The status could not be read, so the repository's current task is unknown and the stop must hold until it is read again. */
const HELD: Outcome = { kind: 'stop', held: true };
const FINISHED: Outcome = { kind: 'finished' };
const CONTINUE: Outcome = { kind: 'continue' };
const IMPOSSIBLE = 'impossible';

type Rule = [Facts['kind'], boolean, boolean, boolean, Facts['stateAfter'], Outcome | typeof IMPOSSIBLE];

/**
 * Every combination of the facts, one row each. An IMPOSSIBLE row cannot be produced by `judge`: a run whose launch task is not ''
 * cannot leave the repository done without having recorded that task, and an unreadable status shows no row for it. A launch
 * task of '' (the master, or a repository with every task recorded) counts as recorded without reading the status, so only
 * such a round can reach recorded with an unknown state (held).
 * One rule about the round, stated here and applied in `ended()` only: a round is cleared only on `finished`. Every other
 * outcome (stop, held stop, continue) keeps it pending, so the next launch of the repository carries its instructions.
 * The rows that decide something:
 *  - a cancelled round always stops, so Continue can run it again (it is never finished, and never reviewed);
 *  - a round whose launch task got no row stops (R8.1: the unfinished task is built first), so it never relaunches by itself;
 *  - a cancelled task run stops unless the repository is done;
 *  - a task run that left the repository done is finished whatever its exit code;
 *  - a failed round stops;
 *  - a round that did not stop and did not finish carries on, and stays pending until it finishes;
 *  - a task run that failed, or that recorded nothing while not waiting, stops;
 *  - an unreadable status stops and holds.
 */
const RULES: Rule[] = [
  // kind     cancelled failed  recorded stateAfter  outcome
  ['task',    false,    false,  true,    'ready',    CONTINUE],
  ['task',    false,    false,  true,    'waiting',  CONTINUE],
  ['task',    false,    false,  true,    'done',     FINISHED],
  ['task',    false,    false,  true,    'unknown',  IMPOSSIBLE],
  ['task',    false,    false,  false,   'ready',    STOP],
  ['task',    false,    false,  false,   'waiting',  CONTINUE],
  ['task',    false,    false,  false,   'done',     IMPOSSIBLE],
  ['task',    false,    false,  false,   'unknown',  HELD],
  ['task',    false,    true,   true,    'ready',    STOP],
  ['task',    false,    true,   true,    'waiting',  STOP],
  ['task',    false,    true,   true,    'done',     FINISHED],
  ['task',    false,    true,   true,    'unknown',  IMPOSSIBLE],
  ['task',    false,    true,   false,   'ready',    STOP],
  ['task',    false,    true,   false,   'waiting',  STOP],
  ['task',    false,    true,   false,   'done',     IMPOSSIBLE],
  ['task',    false,    true,   false,   'unknown',  HELD],
  ['task',    true,     false,  true,    'ready',    STOP],
  ['task',    true,     false,  true,    'waiting',  STOP],
  ['task',    true,     false,  true,    'done',     FINISHED],
  ['task',    true,     false,  true,    'unknown',  IMPOSSIBLE],
  ['task',    true,     false,  false,   'ready',    STOP],
  ['task',    true,     false,  false,   'waiting',  STOP],
  ['task',    true,     false,  false,   'done',     IMPOSSIBLE],
  ['task',    true,     false,  false,   'unknown',  HELD],
  ['task',    true,     true,   true,    'ready',    STOP],
  ['task',    true,     true,   true,    'waiting',  STOP],
  ['task',    true,     true,   true,    'done',     FINISHED],
  ['task',    true,     true,   true,    'unknown',  IMPOSSIBLE],
  ['task',    true,     true,   false,   'ready',    STOP],
  ['task',    true,     true,   false,   'waiting',  STOP],
  ['task',    true,     true,   false,   'done',     IMPOSSIBLE],
  ['task',    true,     true,   false,   'unknown',  HELD],
  ['round',   false,    false,  true,    'ready',    CONTINUE],
  ['round',   false,    false,  true,    'waiting',  CONTINUE],
  ['round',   false,    false,  true,    'done',     FINISHED],
  ['round',   false,    false,  true,    'unknown',  HELD],
  ['round',   false,    false,  false,   'ready',    STOP],
  ['round',   false,    false,  false,   'waiting',  STOP],
  ['round',   false,    false,  false,   'done',     IMPOSSIBLE],
  ['round',   false,    false,  false,   'unknown',  HELD],
  ['round',   false,    true,   true,    'ready',    STOP],
  ['round',   false,    true,   true,    'waiting',  STOP],
  ['round',   false,    true,   true,    'done',     STOP],
  ['round',   false,    true,   true,    'unknown',  HELD],
  ['round',   false,    true,   false,   'ready',    STOP],
  ['round',   false,    true,   false,   'waiting',  STOP],
  ['round',   false,    true,   false,   'done',     IMPOSSIBLE],
  ['round',   false,    true,   false,   'unknown',  HELD],
  ['round',   true,     false,  true,    'ready',    STOP],
  ['round',   true,     false,  true,    'waiting',  STOP],
  ['round',   true,     false,  true,    'done',     STOP],
  ['round',   true,     false,  true,    'unknown',  HELD],
  ['round',   true,     false,  false,   'ready',    STOP],
  ['round',   true,     false,  false,   'waiting',  STOP],
  ['round',   true,     false,  false,   'done',     IMPOSSIBLE],
  ['round',   true,     false,  false,   'unknown',  HELD],
  ['round',   true,     true,   true,    'ready',    STOP],
  ['round',   true,     true,   true,    'waiting',  STOP],
  ['round',   true,     true,   true,    'done',     STOP],
  ['round',   true,     true,   true,    'unknown',  HELD],
  ['round',   true,     true,   false,   'ready',    STOP],
  ['round',   true,     true,   false,   'waiting',  STOP],
  ['round',   true,     true,   false,   'done',     IMPOSSIBLE],
  ['round',   true,     true,   false,   'unknown',  HELD],
];

const factsKey = (f: Facts): string => [f.kind, f.cancelled, f.failed, f.recorded, f.stateAfter].join('|');

export const OUTCOME_RULES: ReadonlyMap<string, Outcome | typeof IMPOSSIBLE> = new Map(
  RULES.map(([kind, cancelled, failed, recorded, stateAfter, outcome]) => [factsKey({ kind, cancelled, failed, recorded, stateAfter }), outcome]),
);

/** What to do with a repository once its run is over. Pure: a combination with no row, or an impossible one, throws. */
export function runOutcome(facts: Facts): Outcome {
  const rule = OUTCOME_RULES.get(factsKey(facts));
  if (rule === undefined || rule === IMPOSSIBLE) throw new Error(`no outcome for ${factsKey(facts)}`);
  return rule;
}
