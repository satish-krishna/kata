import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
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
  sdlcSettings() { return this.ipc.invoke<Settings>('sdlc_settings'); }
  sdlcSaveSettings(settings: Settings) { return this.ipc.invoke<void>('sdlc_save_settings', { settings }); }
  sdlcWorkspaces() { return this.ipc.invoke<WorkspaceEntry[]>('sdlc_workspaces'); }
  sdlcSaveWorkspaces(workspaces: WorkspaceEntry[]) { return this.ipc.invoke<void>('sdlc_save_workspaces', { workspaces }); }
  sdlcScan(folder: string) { return this.ipc.invoke<WorkspaceScan>('sdlc_scan', { folder }); }
  sdlcContextHealth(folder: string, master: string, system: string, repo: string) { return this.ipc.invoke<ContextState>('sdlc_context_health', { folder, master, system, repo }); }
  sdlcChanges(master: string, system: string) { return this.ipc.invoke<ChangeInfo[]>('sdlc_changes', { master, system }); }
  sdlcBranches(master: string) { return this.ipc.invoke<BranchInfo>('sdlc_branches', { master }); }
  sdlcReadDoc(master: string, system: string, change: string, doc: string) { return this.ipc.invoke<string | null>('sdlc_read_doc', { master, system, change, doc }); }
  sdlcSnapshot(master: string) { return this.ipc.invoke<Snapshot>('sdlc_snapshot', { master }); }
  sdlcLeftovers(master: string, before: Snapshot, productRepos: string[]) { return this.ipc.invoke<Leftovers>('sdlc_leftovers', { master, before, productRepos }); }
  sdlcDiscard(master: string, before: Snapshot, paths: string[]) { return this.ipc.invoke<void>('sdlc_discard', { master, before, paths }); }
  sdlcStartChange(master: string, base: string) { return this.ipc.invoke<string>('sdlc_start_change', { master, base }); }
  sdlcFinishChange(master: string, pending: string, base: string) { return this.ipc.invoke<FinishOutcome>('sdlc_finish_change', { master, pending, base }); }
  sdlcCheckout(master: string, branch: string) { return this.ipc.invoke<void>('sdlc_checkout', { master, branch }); }
  sdlcDecide(master: string, system: string, change: string, decision: Decision, confirmed: boolean) { return this.ipc.invoke<DecideOutcome>('sdlc_decide', { master, system, change, decision, confirmed }); }
  sdlcRunLinks() { return this.ipc.invoke<RunLink[]>('sdlc_run_links'); }
  sdlcLinkRun(link: RunLink) { return this.ipc.invoke<void>('sdlc_link_run', { link }); }
  pickDirectory() { return this.ipc.open({ directory: true, multiple: false }) as Promise<string | null>; }
  pickOpenSpec() { return this.ipc.open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>; }
  pickSaveSpec() { return this.ipc.save({ filters: SPEC_FILTERS }) as Promise<string | null>; }
  onRunEvent(cb: (ev: KataEvent) => void) { return this.ipc.listen<KataEvent>('kata://event', (e) => cb(e.payload)); }
}
