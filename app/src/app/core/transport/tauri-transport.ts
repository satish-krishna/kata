import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { KataTransport } from './kata-transport';

/** The Tauri functions the transport needs, injectable so tests need no module mocking. */
export interface TauriIpc {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (e: { payload: T }) => void) => Promise<() => void>;
  open: (opts: Record<string, unknown>) => Promise<unknown>;
  save: (opts: Record<string, unknown>) => Promise<unknown>;
}
const realIpc: TauriIpc = { invoke, listen, open: open as TauriIpc['open'], save: save as TauriIpc['save'] };
const SPEC_FILTERS = [{ name: 'Run-spec', extensions: ['toml', 'json'] }];

export class TauriTransport extends KataTransport {
  constructor(private readonly ipc: TauriIpc = realIpc) { super(); }
  catalog(workdir: string | null) { return this.ipc.invoke<CatalogEntry[]>('catalog', { workdir }); }
  listRuns() { return this.ipc.invoke<RunRecord[]>('list_runs'); }
  loadRun(id: string) { return this.ipc.invoke<RunDetail>('load_run', { id }); }
  loadSpec(path: string) { return this.ipc.invoke<RunSpec>('load_spec', { path }); }
  saveSpec(path: string, spec: RunSpec) { return this.ipc.invoke<void>('save_spec', { path, spec }); }
  validateSpec(spec: RunSpec) { return this.ipc.invoke<string[]>('validate_spec', { spec }); }
  runSpec(spec: RunSpec) { return this.ipc.invoke<void>('run_spec', { spec }); }
  cancelRun() { return this.ipc.invoke<void>('cancel_run'); }
  submitAnswer(id: string, answers: string[][]) { return this.ipc.invoke<void>('submit_answer', { id, answers }); }
  submitDecision(id: string, allow: boolean, message: string | null) { return this.ipc.invoke<void>('submit_decision', { id, allow, message }); }
  listKatas() { return this.ipc.invoke<KataListing>('list_katas'); }
  loadKata(name: string) { return this.ipc.invoke<RunSpec>('load_kata', { name }); }
  saveKata(spec: RunSpec) { return this.ipc.invoke<void>('save_kata', { spec }); }
  listPresets() { return this.ipc.invoke<Preset[]>('list_presets'); }
  savePreset(name: string, body: string) { return this.ipc.invoke<void>('save_preset', { name, body }); }
  exportBundle(spec: RunSpec, out: string) { return this.ipc.invoke<void>('export_bundle', { spec, out }); }
  pickDirectory() { return this.ipc.open({ directory: true, multiple: false }) as Promise<string | null>; }
  pickOpenSpec() { return this.ipc.open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>; }
  pickSaveSpec() { return this.ipc.save({ filters: SPEC_FILTERS }) as Promise<string | null>; }
  onRunEvent(cb: (ev: KataEvent) => void) { return this.ipc.listen<KataEvent>('kata://event', (e) => cb(e.payload)); }
}
