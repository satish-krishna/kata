import { Injectable, inject, signal } from '@angular/core';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunningStep } from '@bindings/RunningStep';
import type { StepEvent } from '@bindings/StepEvent';
import { sameStepChange, type ChangeStep } from '../../lib/sdlc-steps';
import { KataTransport } from '../transport/kata-transport';

const idOf = (key: ChangeKey): string => `${key.workspace.key}|${key.system}|${key.change}`;

const stepOfRunning = (s: RunningStep): ChangeStep => ({ change: s.change, kind: s.kind, label: s.progress?.label ?? s.doing });

/**
 * The long steps running now, as the backend's step table has them, kept for every page: seeded from the backend when a page opens a
 * change and followed through its reports and ends. A page picks the entry of the change it shows (`stepOf` in `lib/sdlc-steps.ts`);
 * nothing here is tied to a page, so a page opened while a step runs shows it as one that started it does.
 */
@Injectable({ providedIn: 'root' })
export class StepStore {
  private readonly transport = inject(KataTransport);
  /** The running steps, one per change. */
  readonly running = signal<ChangeStep[]>([]);
  private stopListening: (() => void)[] = [];
  private generation = 0;

  /**
   * Follow the backend's reports and ends from now on, and read the steps running now. A report or an end heard while the read is on its way
   * is newer than the read, so the read does not override it. A later call follows again from a fresh read.
   */
  async follow(): Promise<void> {
    const generation = ++this.generation;
    this.stopListening.splice(0).forEach((stop) => stop());
    const heard = new Set<string>();
    const none = (): (() => void) => () => undefined;
    const listening = await Promise.all([
      this.transport
        .onStep((event) => {
          heard.add(idOf(event.change));
          this.report(event);
        })
        .catch(none),
      this.transport
        .onStepEnd((key) => {
          heard.add(idOf(key));
          this.running.update((all) => all.filter((s) => idOf(s.change) !== idOf(key)));
        })
        .catch(none),
    ]);
    if (generation !== this.generation) {
      listening.forEach((stop) => stop());
      return;
    }
    this.stopListening = listening;
    let seed: RunningStep[];
    try {
      seed = await this.transport.steps();
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    this.running.update((all) => [...seed.filter((s) => !heard.has(idOf(s.change))).map(stepOfRunning), ...all.filter((s) => heard.has(idOf(s.change)))]);
  }

  /** The page's own call for the change's step answered, so the step is over whatever the backend's end report says. */
  ended(change: { system: string; change: string }): void {
    this.running.update((all) => all.filter((s) => !sameStepChange(s.change, change)));
  }

  private report(event: StepEvent): void {
    const step: ChangeStep = { change: event.change, kind: event.kind, label: event.progress.label };
    this.running.update((all) => [...all.filter((s) => idOf(s.change) !== idOf(event.change)), step]);
  }
}
