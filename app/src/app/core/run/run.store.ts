import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataEvent } from '../../lib/events';
import { terminalStateFor } from '../../lib/events';
import { KataTransport } from '../transport/kata-transport';
import { IDLE, reduce, type RunSnapshot } from './reduce';

/** One run the store follows. `gen` is the per-run generation: an event or answer whose generation is
 *  no longer current (a late delivery after Cancel or a terminal event) is dropped. */
interface Rec {
  key: string;
  gen: number;
  /** The generation a cancel ended, so only a cancelled run (not a finished one) triggers the post-spawn cancel. */
  cancelledGen: number;
  /** The id the backend gave the run, once `runSpec` has answered. Kept after the run ends so a caller can still wait on its process. */
  id: string | null;
  /** The run has started but the backend has not yet said which id it is. */
  awaitingId: boolean;
  /** Terminal, cancelled or failed: its events no longer count and its id may be reused. */
  ended: boolean;
  unlisten: (() => void) | null;
}

const isActive = (s: RunSnapshot | undefined): boolean => s?.state === 'running' || s?.state === 'awaiting';

/** Drives runs through the transport and holds one folded snapshot per run. The Workbench screen and the
 *  Part 1 stages read the solo run (`state()`, `events()`, ...); a build reads its runs by id with `snapshot(id)`. */
@Injectable({ providedIn: 'root' })
export class RunStore {
  private readonly transport = inject(KataTransport);
  private readonly recs = new Map<string, Rec>();
  private readonly snaps = signal<ReadonlyMap<string, RunSnapshot>>(new Map());
  private readonly keyById = signal<ReadonlyMap<string, string>>(new Map());
  private readonly soloKey = signal<string | null>(null);
  private readonly views = new Map<string, Signal<RunSnapshot>>();
  /** Events that arrived for an id nobody has claimed while several starts were still waiting for theirs. */
  private readonly early = new Map<string, KataEvent[]>();
  private counter = 0;
  /** The id of the latest solo run, kept after it ends. */
  private lastId: string | null = null;

  private readonly solo = computed(() => {
    const key = this.soloKey();
    return (key === null ? undefined : this.snaps().get(key)) ?? IDLE;
  });

  readonly state = computed(() => this.solo().state);
  readonly events = computed(() => this.solo().events);
  readonly summary = computed(() => this.solo().summary);
  readonly asks = computed(() => this.solo().asks);
  readonly permissions = computed(() => this.solo().permissions);

  /** The folded view of one run by its backend id; idle for an id the store does not know. */
  snapshot(id: string): Signal<RunSnapshot> {
    let view = this.views.get(id);
    if (!view) {
      view = computed(() => {
        const key = this.keyById().get(id);
        return (key === undefined ? undefined : this.snaps().get(key)) ?? IDLE;
      });
      this.views.set(id, view);
    }
    return view;
  }

  private soloRec(): Rec | undefined {
    const key = this.soloKey();
    return key === null ? undefined : this.recs.get(key);
  }

  /** The record for an id, the latest one when a fake transport reuses an id. */
  private byId(id: string): Rec | undefined {
    let found: Rec | undefined;
    for (const rec of this.recs.values()) if (rec.id === id) found = rec;
    return found;
  }

  private current(rec: Rec): RunSnapshot {
    return this.snaps().get(rec.key) ?? IDLE;
  }

  private setSnap(rec: Rec, snap: RunSnapshot): void {
    this.snaps.update((m) => new Map(m).set(rec.key, snap));
  }

  private append(rec: Rec, level: 'warn' | 'error', message: string): void {
    this.setSnap(rec, { ...this.current(rec), events: [...this.current(rec).events, { type: 'log', level, message }] });
  }

  private setState(rec: Rec, state: RunSnapshot['state']): void {
    this.setSnap(rec, { ...this.current(rec), state });
  }

  private teardown(rec: Rec): void {
    rec.unlisten?.();
    rec.unlisten = null;
  }

  private end(rec: Rec): void {
    rec.ended = true;
    rec.awaitingId = false;
  }

  private fold(rec: Rec, ev: KataEvent): void {
    this.setSnap(rec, reduce(this.current(rec), ev));
    if (terminalStateFor(ev)) {
      rec.gen++;
      this.end(rec);
      this.teardown(rec);
    }
  }

  private receive(rec: Rec, gen: number, runId: string, ev: KataEvent): void {
    if (gen !== rec.gen) return;
    if (rec.id !== null) {
      if (runId !== rec.id) return;
    } else {
      // Another live run owns that id.
      for (const other of this.recs.values()) if (other !== rec && !other.ended && other.id === runId) return;
      // With one start waiting for its id, whatever arrives unclaimed is that run's. With several the
      // event cannot be placed yet: the oldest one holds it until an answer names its owner.
      const waiting = [...this.recs.values()].filter((r) => r.awaitingId);
      if (waiting.length > 1) {
        if (waiting[0] === rec) this.early.set(runId, [...(this.early.get(runId) ?? []), ev]);
        return;
      }
    }
    this.fold(rec, ev);
  }

  private claim(rec: Rec, gen: number, id: string): void {
    rec.id = id;
    rec.awaitingId = false;
    if (!this.recs.has(rec.key)) return;
    this.keyById.update((m) => new Map(m).set(id, rec.key));
    const held = this.early.get(id);
    this.early.delete(id);
    for (const ev of held ?? []) {
      if (gen !== rec.gen) break;
      this.fold(rec, ev);
    }
  }

  private drop(rec: Rec): void {
    this.teardown(rec);
    this.recs.delete(rec.key);
    this.snaps.update((m) => {
      const next = new Map(m);
      next.delete(rec.key);
      return next;
    });
    if (rec.id !== null && this.keyById().get(rec.id) === rec.key) {
      const id = rec.id;
      this.keyById.update((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }
  }

  /** Start a run and answer its backend id, or null when it was refused (the solo run is busy), cancelled
   *  before it spawned, or failed to spawn. A run started with a group is a build's and never touches the solo view. */
  async startRun(spec: RunSpec, group?: string): Promise<string | null> {
    if (group === undefined && isActive(this.solo())) return null;
    const previous = group === undefined ? this.soloRec() : undefined;
    if (previous) this.drop(previous);
    const rec: Rec = {
      key: `r${++this.counter}`,
      gen: 0,
      cancelledGen: -1,
      id: null,
      awaitingId: true,
      ended: false,
      unlisten: null,
    };
    this.recs.set(rec.key, rec);
    if (group === undefined) {
      this.soloKey.set(rec.key);
      this.lastId = null;
    }
    this.setSnap(rec, { ...IDLE, state: 'running' });
    const gen = rec.gen;
    const unlisten = await this.transport.onRunEvent((id, ev) => this.receive(rec, gen, id, ev));
    if (gen !== rec.gen) {
      unlisten();
      return null;
    }
    rec.unlisten = unlisten;
    try {
      const id = group === undefined ? await this.transport.runSpec(spec) : await this.transport.runSpec(spec, group);
      this.claim(rec, gen, id);
      if (group === undefined && this.soloKey() === rec.key) this.lastId = id;
      // A cancel landed while run_spec was spawning; the backend had no child to signal then.
      if (rec.cancelledGen === gen) void this.transport.cancelRun(id);
      return id;
    } catch (e) {
      if (gen !== rec.gen) return null;
      rec.gen++;
      this.end(rec);
      this.append(rec, 'error', `run failed: ${e}`);
      this.setState(rec, 'error');
      this.teardown(rec);
      return null;
    }
  }

  /** Cancel one run by id; without an id, the solo run. */
  async cancelRun(runId?: string): Promise<void> {
    const rec = runId === undefined ? this.soloRec() : this.byId(runId);
    if (!rec || !isActive(this.current(rec))) return;
    // Settle the UI state synchronously so no later event or re-run can be confused with this run.
    rec.cancelledGen = rec.gen;
    const gen = ++rec.gen;
    this.end(rec);
    this.teardown(rec);
    this.append(rec, 'warn', 'run cancelled — engine stopped claude and cleaned up the plugin-dir');
    this.setState(rec, 'warning');
    try {
      // Still spawning: there is no id to signal yet, and startRun cancels the child as soon as it has one.
      if (rec.id !== null) await this.transport.cancelRun(rec.id);
    } catch (e) {
      if (gen !== rec.gen || !this.recs.has(rec.key)) return;
      this.append(rec, 'error', `cancel failed: ${e}`);
      this.setState(rec, 'error');
    }
  }

  /** The id of the latest solo run, or null before the backend has answered. Stays set after the run ends. */
  lastRunId(): string | null {
    return this.lastId;
  }

  /** Stop following a finished run and free its snapshot. A live run is kept. */
  forget(runId: string): void {
    const rec = this.byId(runId);
    if (rec && !isActive(this.current(rec))) this.drop(rec);
  }

  /** Answer a question: `(askId, answers)` for the solo run, `(runId, askId, answers)` for the run named. */
  submitAnswer(askId: string, answers: string[][]): Promise<void>;
  submitAnswer(runId: string, askId: string, answers: string[][]): Promise<void>;
  async submitAnswer(...args: [string, string[][]] | [string, string, string[][]]): Promise<void> {
    const rec = args.length === 2 ? this.soloRec() : this.byId(args[0]);
    if (!rec || rec.id === null || this.current(rec).state !== 'awaiting') return;
    if (args.length === 2) await this.transport.submitAnswer(rec.id, args[0], args[1]);
    else await this.transport.submitAnswer(rec.id, args[1], args[2]);
  }

  /** Decide a permission check: `(askId, allow, message)` for the solo run, `(runId, id, allow, message)` for the run named. */
  submitDecision(id: string, allow: boolean, message: string | null): Promise<void>;
  submitDecision(runId: string, id: string, allow: boolean, message: string | null): Promise<void>;
  async submitDecision(...args: [string, boolean, string | null] | [string, string, boolean, string | null]): Promise<void> {
    const rec = args.length === 3 ? this.soloRec() : this.byId(args[0]);
    if (!rec || rec.id === null || this.current(rec).state !== 'awaiting') return;
    if (args.length === 3) await this.transport.submitDecision(rec.id, args[0], args[1], args[2]);
    else await this.transport.submitDecision(rec.id, args[1], args[2], args[3]);
  }
}
