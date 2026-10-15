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
  private unlisten: (() => void) | null = null;

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

  private receive(gen: number, ev: KataEvent): void {
    if (gen !== this.generation) return;
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
    this.snap.set({ ...IDLE, state: 'running' });
    const unlisten = await this.transport.onRunEvent((ev) => this.receive(gen, ev));
    if (gen !== this.generation) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;
    try {
      await this.transport.runSpec(spec);
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
    await this.transport.cancelRun();
    this.generation++;
    this.append('warn', 'run cancelled — engine stopped claude and cleaned up the plugin-dir');
    this.snap.update((s) => ({ ...s, state: 'warning' }));
    this.teardown();
  }

  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    if (this.snap().state !== 'awaiting') return;
    await this.transport.submitAnswer(id, answers);
  }

  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    if (this.snap().state !== 'awaiting') return;
    await this.transport.submitDecision(id, allow, message);
  }
}
