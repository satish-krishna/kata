import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, validateLocal, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import { KataTransport, NO_BACKEND } from './kata-transport';

/** Browser stand-in: fixtures plus the scripted run timeline (head, ask,
 *  mid, permission, tail), unblocked by submitAnswer / submitDecision. */
export class MockTransport extends KataTransport {
  private cb: ((ev: KataEvent) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  private play(segment: ScriptStep[]): void {
    let acc = 0;
    for (const step of segment) {
      acc += step.delay;
      this.timers.push(setTimeout(() => this.cb?.(step.ev), acc));
    }
  }

  catalog(_workdir: string | null): Promise<CatalogEntry[]> { return Promise.resolve(seedCatalog); }
  listRuns(): Promise<RunRecord[]> { return Promise.resolve(history); }
  loadRun(id: string): Promise<RunDetail> { return Promise.resolve(runDetailFixture(id)); }
  loadSpec(_path: string): Promise<RunSpec> { return Promise.reject(new Error(NO_BACKEND)); }
  saveSpec(_path: string, _spec: RunSpec): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  validateSpec(spec: RunSpec): Promise<string[]> { return Promise.resolve(validateLocal(spec)); }
  listKatas(): Promise<KataListing> { return Promise.resolve({ katas: katasFixture, failures: [] }); }
  loadKata(name: string): Promise<RunSpec> { return Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]); }
  saveKata(_spec: RunSpec): Promise<void> { return Promise.resolve(); }
  listPresets(): Promise<Preset[]> { return Promise.resolve(presetsFixture); }
  savePreset(_name: string, _body: string): Promise<void> { return Promise.resolve(); }
  exportBundle(_spec: RunSpec, _out: string): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  pickDirectory(): Promise<string | null> { return Promise.resolve(null); }
  pickOpenSpec(): Promise<string | null> { return Promise.resolve(null); }
  pickSaveSpec(): Promise<string | null> { return Promise.resolve(null); }

  async onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void> {
    this.cb = cb;
    return () => { if (this.cb === cb) this.cb = null; };
  }
  async runSpec(_spec: RunSpec): Promise<void> { this.play(runScriptHead); }
  async cancelRun(): Promise<void> { this.timers.forEach(clearTimeout); this.timers = []; }
  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    this.cb?.({ type: 'ask.answered', id, answers });
    this.play(runScriptMid);
  }
  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    this.cb?.({ type: 'permission.decided', id, ...PENDING_PERMISSION, allow, decided_by: 'operator', message: message ?? undefined });
    this.play(runScriptTail);
  }
}
