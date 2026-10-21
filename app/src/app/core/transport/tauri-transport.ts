import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Readiness } from '@bindings/Readiness';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildAction } from '@bindings/BuildAction';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ReadResult } from '@bindings/ReadResult';
import type { ReadError } from '../../lib/doc-notice';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { UnsavedRows } from '@bindings/UnsavedRows';
import type { Participant } from '@bindings/Participant';
import type { PrepareOutcome } from '@bindings/PrepareOutcome';
import type { BuildStart } from '@bindings/BuildStart';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { Part } from '@bindings/Part';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { Offender } from '@bindings/Offender';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { PrResult } from '@bindings/PrResult';
import type { PrState } from '@bindings/PrState';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import type { ZoomStep } from '../../lib/zoom-keys';
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
  runSpec(spec: RunSpec, group?: string) { return this.ipc.invoke<string>('run_spec', { spec, group }); }
  cancelRun(runId: string) { return this.ipc.invoke<void>('cancel_run', { runId }); }
  submitAnswer(runId: string, id: string, answers: string[][]) { return this.ipc.invoke<void>('submit_answer', { runId, id, answers }); }
  submitDecision(runId: string, id: string, allow: boolean, message: string | null) { return this.ipc.invoke<void>('submit_decision', { runId, id, allow, message }); }
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
  sdlcLeftovers(master: string, before: Snapshot, productRepos: string[], build?: BuildScope) { return this.ipc.invoke<Leftovers>('sdlc_leftovers', { master, before, productRepos, build }); }
  sdlcDiscard(master: string, before: Snapshot, paths: string[], build?: BuildScope) { return this.ipc.invoke<void>('sdlc_discard', { master, before, paths, build }); }
  sdlcStartChange(master: string, base: string) { return this.ipc.invoke<string>('sdlc_start_change', { master, base }); }
  sdlcFinishChange(master: string, pending: string, base: string) { return this.ipc.invoke<FinishOutcome>('sdlc_finish_change', { master, pending, base }); }
  sdlcCheckout(master: string, branch: string) { return this.ipc.invoke<void>('sdlc_checkout', { master, branch }); }
  sdlcDecide(master: string, system: string, change: string, decision: Decision, confirmed: boolean) { return this.ipc.invoke<DecideOutcome>('sdlc_decide', { master, system, change, decision, confirmed }); }
  sdlcRunLinks() { return this.ipc.invoke<RunLink[]>('sdlc_run_links'); }
  sdlcLinkRun(link: RunLink) { return this.ipc.invoke<void>('sdlc_link_run', { link }); }
  sdlcWaitRunExit(runId: string, timeoutMs: number) { return this.ipc.invoke<boolean>('sdlc_wait_run_exit', { runId, timeoutMs }); }
  sdlcBuildStatus(master: string, system: string, change: string) { return this.ipc.invoke<BuildStatus>('sdlc_build_status', { master, system, change }); }
  async sdlcReadParsed(master: string, system: string, change: string, doc: string): Promise<ReadResult | ReadError | null> {
    try {
      return await this.ipc.invoke<ReadResult | null>('sdlc_read_parsed', { master, system, change, doc });
    } catch (e) {
      // The backend rejects with the program's own message; it travels on as a result, never as a missing document.
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  sdlcReviewRecord(master: string, system: string, change: string) { return this.ipc.invoke<ReviewRecord | null>('sdlc_review_record', { master, system, change }); }
  sdlcUnsavedRows(master: string, system: string, change: string) { return this.ipc.invoke<UnsavedRows[]>('sdlc_unsaved_rows', { master, system, change }); }
  sdlcBuildPrepare(folder: string, masterRepo: string, system: string, change: string, continueWithLeftovers: boolean, pending: string | null, action: BuildAction) { return this.ipc.invoke<PrepareOutcome>('sdlc_build_prepare', { folder, masterRepo, system, change, action, continueWithLeftovers, pending }); }
  sdlcBuildParticipants(folder: string, masterRepo: string, system: string, change: string, pending: string | null = null) { return this.ipc.invoke<Participant[]>('sdlc_build_participants', { folder, masterRepo, system, change, pending }); }
  sdlcBuildSettle(start: BuildStart) { return this.ipc.invoke<string[]>('sdlc_build_settle', { start }); }
  sdlcBuildHeads(folder: string, repos: string[], change: string) { return this.ipc.invoke<Record<string, string>>('sdlc_build_heads', { folder, repos, change }); }
  sdlcReviewVerify(master: string, system: string, change: string, since: string, before: Snapshot['dirty']) { return this.ipc.invoke<string[]>('sdlc_review_verify', { master, system, change, since, before }); }
  sdlcPluginReadiness(workdir: string | null) { return this.ipc.invoke<Readiness>('sdlc_plugin_readiness', { workdir }); }
  sdlcChangeRepos(folder: string, masterRepo: string, system: string, change: string) { return this.ipc.invoke<ChangeRepo[]>('sdlc_change_repos', { folder, masterRepo, system, change }); }
  sdlcMissingChangeBranches(folder: string, masterRepo: string, system: string, change: string) { return this.ipc.invoke<string[]>('sdlc_missing_change_branches', { folder, masterRepo, system, change }); }
  sdlcDiffFiles(repoPath: string, part: Part) { return this.ipc.invoke<DiffListing>('sdlc_diff_files', { repoPath, part }); }
  sdlcDiffPair(repoPath: string, part: Part, path: string) { return this.ipc.invoke<FilePair>('sdlc_diff_pair', { repoPath, part, path }); }
  sdlcDiffBase(repoPath: string) { return this.ipc.invoke<BaseInfo>('sdlc_diff_base', { repoPath }); }
  sdlcTouchedRepos(folder: string, masterRepo: string, system: string, change: string) { return this.ipc.invoke<PublishRepo[]>('sdlc_touched_repos', { folder, masterRepo, system, change }); }
  sdlcCommitOffenders(folder: string, masterRepo: string, system: string, change: string) { return this.ipc.invoke<Offender[]>('sdlc_commit_offenders', { folder, masterRepo, system, change }); }
  sdlcChecksDir() { return this.ipc.invoke<string>('sdlc_checks_dir'); }
  sdlcChecksLoad(folder: string, masterRepo: string, system: string) { return this.ipc.invoke<ChecksPlan>('sdlc_checks_load', { folder, masterRepo, system }); }
  sdlcRunChecks(folder: string, masterRepo: string, system: string, repo: PublishRepo) { return this.ipc.invoke<RepoChecks>('sdlc_run_checks', { folder, masterRepo, system, repo }); }
  sdlcGhSignedIn(repos: PublishRepo[]) { return this.ipc.invoke<string>('sdlc_gh_signed_in', { repos }); }
  sdlcGhOrigins(repos: PublishRepo[]) { return this.ipc.invoke<void>('sdlc_gh_origins', { repos }); }
  sdlcPublish(folder: string, masterRepo: string, system: string, change: string, repos: PublishRepo[]) { return this.ipc.invoke<PrResult[]>('sdlc_publish', { folder, masterRepo, system, change, repos }); }
  sdlcPullRequests(repos: PublishRepo[], change: string) { return this.ipc.invoke<PrState[]>('sdlc_pull_requests', { repos, change }); }
  zoom(step: ZoomStep) { return this.ipc.invoke<number>('zoom', { step }); }
  pickDirectory() { return this.ipc.open({ directory: true, multiple: false }) as Promise<string | null>; }
  pickOpenSpec() { return this.ipc.open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>; }
  pickSaveSpec() { return this.ipc.save({ filters: SPEC_FILTERS }) as Promise<string | null>; }
  onRunEvent(cb: (runId: string, ev: KataEvent) => void) {
    return this.ipc.listen<{ runId: number; event: KataEvent }>('kata://event', (e) => cb(String(e.payload.runId), e.payload.event));
  }
}
