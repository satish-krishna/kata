import { Injectable, computed, inject, signal } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataEvent } from '../../lib/events';
import { terminalStateFor } from '../../lib/events';
import { KataTransport } from '../transport/kata-transport';
import { IDLE, reduce, type RunSnapshot } from './reduce';

/** Drives a run through the transport and holds the Observe pane's state. Each
 *  run gets a generation number; an event whose generation is no longer current
 *  (a late delivery after Cancel, a terminal event, or a fast Re-run) is dropped. */
@Injectable({ providedIn: 'root' })
export class RunStore {
  private readonly transport = inject(KataTransport);
  private readonly snap = signal<RunSnapshot>(IDLE);
  private generation = 0;
  /** The generation a cancel ended, so only a cancelled run (not a finished one) triggers the post-spawn cancel. */
  private cancelledGen = -1;
  private unlisten: (() => void) | null = null;
  /** The id the backend gave the run, once `runSpec` has answered. Kept after the run ends so a caller can still wait on its process. */
  private runId: string | null = null;
  /** The generation of the latest `startRun`, so a slow `runSpec` answer from a superseded start cannot overwrite the id. */
  private startedGen = -1;

  readonly state = computed(() => this.snap().state);
  readonly events = computed(() => this.snap().events);
  readonly summary = computed(() => this.snap().summary);
  readonly asks = computed(() => this.snap().asks);
  readonly permissions = computed(() => this.snap().permissions);

  private active(): boolean {
    const s = this.snap().state;
    return s === 'running' || s === 'awaiting';
  }

  private teardown(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private append(level: 'warn' | 'error', message: string): void {
    this.snap.update((s) => ({ ...s, events: [...s.events, { type: 'log', level, message }] }));
  }

  private receive(gen: number, runId: string, ev: KataEvent): void {
    if (gen !== this.generation) return;
    // Before runSpec answers the id is unknown, and this store holds one run, so whatever arrives is that run's.
    if (this.runId !== null && runId !== this.runId) return;
    this.snap.update((s) => reduce(s, ev));
    if (terminalStateFor(ev)) {
      this.generation++;
      this.teardown();
    }
  }

  async startRun(spec: RunSpec): Promise<void> {
    if (this.active()) return;
    this.teardown();
    const gen = ++this.generation;
    this.startedGen = gen;
    this.runId = null;
    this.snap.set({ ...IDLE, state: 'running' });
    const unlisten = await this.transport.onRunEvent((id, ev) => this.receive(gen, id, ev));
    if (gen !== this.generation) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;
    try {
      const id = await this.transport.runSpec(spec);
      if (this.startedGen === gen) this.runId = id;
      // A cancel landed while run_spec was spawning; the backend had no child to signal then.
      if (this.cancelledGen === gen) void this.transport.cancelRun(id);
    } catch (e) {
      if (gen !== this.generation) return;
      this.generation++;
      this.append('error', `run failed: ${e}`);
      this.snap.update((s) => ({ ...s, state: 'error' }));
      this.teardown();
    }
  }

  async cancelRun(): Promise<void> {
    if (!this.active()) return;
    // Settle the UI state synchronously so no later event or re-run can be confused with this run.
    this.cancelledGen = this.generation;
    const gen = ++this.generation;
    this.teardown();
    this.append('warn', 'run cancelled — engine stopped claude and cleaned up the plugin-dir');
    this.snap.update((s) => ({ ...s, state: 'warning' }));
    try {
      // Still spawning: there is no id to signal yet, and startRun cancels the child as soon as it has one.
      if (this.runId !== null) await this.transport.cancelRun(this.runId);
    } catch (e) {
      if (gen !== this.generation) return;
      this.append('error', `cancel failed: ${e}`);
      this.snap.update((s) => ({ ...s, state: 'error' }));
    }
  }

  /** The id of the latest run, or null before the backend has answered. Stays set after the run ends. */
  lastRunId(): string | null {
    return this.runId;
  }

  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    if (this.snap().state !== 'awaiting' || this.runId === null) return;
    await this.transport.submitAnswer(this.runId, id, answers);
  }

  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    if (this.snap().state !== 'awaiting' || this.runId === null) return;
    await this.transport.submitDecision(this.runId, id, allow, message);
  }
}
