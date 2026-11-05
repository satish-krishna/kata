import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Versions } from '@bindings/Versions';
import type { RepoBoard } from '@bindings/RepoBoard';
import type { ReviewStanding } from '@bindings/ReviewStanding';
import type { Stop } from '@bindings/Stop';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Readiness } from '@bindings/Readiness';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { InstructionsState } from '@bindings/InstructionsState';
import type { ChangeView } from '@bindings/ChangeView';
import type { WorkspaceView } from '@bindings/WorkspaceView';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { SnapshotTarget } from '@bindings/SnapshotTarget';
import type { DocumentRead } from '@bindings/DocumentRead';
import type { OpenedChange } from '@bindings/OpenedChange';
import type { Leftovers } from '@bindings/Leftovers';
import type { ChangeStart } from '@bindings/ChangeStart';
import type { AcceptOutcome } from '@bindings/AcceptOutcome';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RejectOutcome } from '@bindings/RejectOutcome';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { TaskLink } from '@bindings/TaskLink';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { Part } from '@bindings/Part';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { OldChecksNotice } from '@bindings/OldChecksNotice';
import type { DeclareView } from '@bindings/DeclareView';
import type { DoneStep } from '@bindings/DoneStep';
import type { PullRequestsView } from '@bindings/PullRequestsView';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import type { ZoomStep } from '../../lib/zoom-keys';
import type { RenameOutcome } from '@bindings/RenameOutcome';
import type { BuildState } from '@bindings/BuildState';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { StartForm } from '@bindings/StartForm';
import type { HistoryEntry } from '@bindings/HistoryEntry';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { CloseOutcome } from '@bindings/CloseOutcome';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { BuildPreviewKind } from '@bindings/BuildPreviewKind';
import type { BuildSection } from '@bindings/BuildSection';
import type { ReviewView } from '@bindings/ReviewView';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { RunForm } from '@bindings/RunForm';
import type { RunningStrip } from '@bindings/RunningStrip';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { DocumentKind } from '../../lib/build-host';
import { KataTransport, type NamingState, type ReviewStandingInput } from './kata-transport';

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
  previewRun(spec: RunSpec) { return this.ipc.invoke<Resolved>('preview_run', { spec }); }
  runSpec(spec: RunSpec, group?: string) { return this.ipc.invoke<string>('run_spec', { spec, group }); }
  cancelRun(runId: string) { return this.ipc.invoke<void>('cancel_run', { runId }); }
  submitAnswer(runId: string, id: string, answers: string[][]) { return this.ipc.invoke<void>('submit_answer', { runId, id, answers }); }
  sendMessage(runId: string, id: string, text: string) { return this.ipc.invoke<void>('send_message', { runId, id, text }); }
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
  sdlcReadContext(master: string, system: string, repo: string) { return this.ipc.invoke<string | null>('sdlc_read_context', { master, system, repo }); }
  sdlcInstructions(folder: string, masterRepo: string) { return this.ipc.invoke<InstructionsState>('sdlc_instructions', { folder, masterRepo }); }
  sdlcState(folder: string, systems: string[]) { return this.ipc.invoke<WorkspaceView>('sdlc_state', { folder, systems }); }
  sdlcChangeState(folder: string, system: string, change: string) { return this.ipc.invoke<ChangeView>('sdlc_change_state', { folder, system, change }); }
  sdlcMissingFolders(folders: string[]) { return this.ipc.invoke<string[]>('sdlc_missing_folders', { folders }); }
  sdlcBranches(master: string) { return this.ipc.invoke<BranchInfo>('sdlc_branches', { master }); }
  sdlcOpenChange(change: ChangeRef, doc: string) { return this.ipc.invoke<OpenedChange>('sdlc_open_change', { change, doc }); }
  sdlcReadDocument(change: ChangeRef, doc: string) { return this.ipc.invoke<DocumentRead>('sdlc_read_document', { change, doc }); }
  sdlcReadDoc(change: ChangeRef, doc: string) { return this.ipc.invoke<string | null>('sdlc_read_doc', { change, doc }); }
  sdlcSnapshot(target: SnapshotTarget) { return this.ipc.invoke<Snapshot>('sdlc_snapshot', { target }); }
  sdlcLeftovers(target: SnapshotTarget, before: Snapshot, build?: BuildScope) { return this.ipc.invoke<Leftovers>('sdlc_leftovers', { target, before, build }); }
  sdlcDiscard(target: SnapshotTarget, before: Snapshot, paths: string[], build?: BuildScope) { return this.ipc.invoke<void>('sdlc_discard', { target, before, paths, build }); }
  sdlcRunHistory(runId: string) { return this.ipc.invoke<HistoryEntry[]>('sdlc_run_history', { runId }); }
  sdlcRunChange(change: ChangeRef, kind: DocumentKind, form: RunForm) { return this.ipc.invoke<string>('sdlc_run_change', { change, kind, form }); }
  sdlcBuildStart(change: ChangeRef, form: StartForm) { return this.ipc.invoke<StartOutcome>('sdlc_build_start', { change, form }); }
  sdlcBuildContinue(change: ChangeRef, repo: string, off?: string[]) { return this.ipc.invoke<StartOutcome>('sdlc_build_continue', { change, repo, ...(off === undefined ? {} : { off }) }); }
  sdlcBuildState(change: ChangeRef) { return this.ipc.invoke<BuildState | null>('sdlc_build_state', { change }); }
  sdlcChangeKey(change: ChangeRef) { return this.ipc.invoke<ChangeKey>('sdlc_change_key', { change }); }
  sdlcBuildCancel(change: ChangeRef, repo: string | null) { return this.ipc.invoke<void>('sdlc_build_cancel', { change, repo }); }
  sdlcBuildRuns(change: ChangeRef) { return this.ipc.invoke<BuildRunRef[]>('sdlc_build_runs', { change }); }
  sdlcPreviewChangeRun(change: ChangeRef, kind: DocumentKind, form: RunForm) { return this.ipc.invoke<RunSpec>('sdlc_preview_change_run', { change, kind, form }); }
  sdlcPreviewBuild(change: ChangeRef, which: BuildPreviewKind, repo: string | null, form: StartForm) { return this.ipc.invoke<BuildSection[]>('sdlc_preview_build', { change, which, repo, form }); }
  sdlcReviewView(change: ChangeRef) { return this.ipc.invoke<ReviewView>('sdlc_review_view', { change }); }
  sdlcReviewStart(change: ChangeRef, off?: string[]) { return this.ipc.invoke<StartOutcome>('sdlc_review_start', { change, ...(off === undefined ? {} : { off }) }); }
  sdlcReviewWaiting(change: ChangeRef) { return this.ipc.invoke<HeldRepo[]>('sdlc_review_waiting', { change }); }
  sdlcRoundOffer(change: ChangeRef) { return this.ipc.invoke<[RoundOffer, RoundPicks]>('sdlc_round_offer', { change }); }
  sdlcRoundPlan(change: ChangeRef, picks: RoundPicks) { return this.ipc.invoke<RoundPlan>('sdlc_round_plan', { change, picks }); }
  sdlcRunning() { return this.ipc.invoke<RunningStrip>('sdlc_running'); }
  sdlcMarkOpened(change: ChangeRef) { return this.ipc.invoke<void>('sdlc_mark_opened', { change }); }
  sdlcCloseAnswer(confirm: boolean) { return this.ipc.invoke<void>('sdlc_close_answer', { confirm }); }
  sdlcChangeName(title: string) { return this.ipc.invoke<string>('sdlc_change_name', { title }); }
  sdlcTriageChange(transcript: string, system: string) { return this.ipc.invoke<string | null>('sdlc_triage_change', { transcript, system }); }
  sdlcStartChange(folder: string, system: string, title: string, workType: string, scope: string, branch?: string) { return this.ipc.invoke<ChangeStart>('sdlc_start_change', { folder, system, title, workType, scope, ...(branch === undefined ? {} : { branch }) }); }
  sdlcNaming(folder: string, masterRepo: string, system: string) { return this.ipc.invoke<NamingState>('sdlc_naming', { folder, masterRepo, system }); }
  sdlcRenameBranch(folder: string, workspaceId: string, system: string, change: string, to: string) { return this.ipc.invoke<RenameOutcome>('sdlc_rename_branch', { folder, workspaceId, system, change, to }); }
  sdlcCheckScope(folder: string, scope: string) { return this.ipc.invoke<string[]>('sdlc_check_scope', { folder, scope }); }
  sdlcCheckout(master: string, branch: string) { return this.ipc.invoke<void>('sdlc_checkout', { master, branch }); }
  sdlcCopyRemoval(change: ChangeRef) { return this.ipc.invoke<CopyRemoval>('sdlc_copy_removal', { change }); }
  sdlcCopyBranch(change: ChangeRef) { return this.ipc.invoke<string>('sdlc_copy_branch', { change }); }
  sdlcRemoveCopy(change: ChangeRef) { return this.ipc.invoke<RemoveOutcome>('sdlc_remove_copy', { change }); }
  sdlcOpenCopyFolder(change: ChangeRef) { return this.ipc.invoke<void>('sdlc_open_copy_folder', { change }); }
  sdlcAccept(change: ChangeRef, doc: ChangeDocument) { return this.ipc.invoke<AcceptOutcome>('sdlc_accept', { change, doc }); }
  sdlcReject(change: ChangeRef) { return this.ipc.invoke<RejectOutcome>('sdlc_reject', { change }); }
  sdlcRunLinks() { return this.ipc.invoke<RunLink[]>('sdlc_run_links'); }
  sdlcLinkRun(link: RunLink) { return this.ipc.invoke<void>('sdlc_link_run', { link }); }
  sdlcTaskLinks() { return this.ipc.invoke<TaskLink[]>('sdlc_task_links'); }
  sdlcWaitRunExit(runId: string, timeoutMs: number) { return this.ipc.invoke<boolean>('sdlc_wait_run_exit', { runId, timeoutMs }); }
  sdlcBuildStatus(change: ChangeRef) { return this.ipc.invoke<BuildStatus>('sdlc_build_status', { change }); }
  sdlcBuildBoard(repos: string[], status: BuildStatus, going: string[], stopped: { [repo: string]: Stop | undefined }) { return this.ipc.invoke<RepoBoard[]>('sdlc_build_board', { repos, status, going, stopped }); }
  sdlcReviewStanding(input: ReviewStandingInput) { return this.ipc.invoke<ReviewStanding>('sdlc_review_standing', { ...input }); }
  sdlcReviewRecord(change: ChangeRef) { return this.ipc.invoke<ReviewRecord | null>('sdlc_review_record', { change }); }
  sdlcBuildHeads(change: ChangeRef, repos: string[]) { return this.ipc.invoke<Record<string, string>>('sdlc_build_heads', { change, repos }); }
  sdlcPluginReadiness(workdir: string | null) { return this.ipc.invoke<Readiness>('sdlc_plugin_readiness', { workdir }); }
  sdlcChangeRepos(change: ChangeRef) { return this.ipc.invoke<ChangeRepo[]>('sdlc_change_repos', { change }); }
  sdlcMissingChangeBranches(change: ChangeRef) { return this.ipc.invoke<string[]>('sdlc_missing_change_branches', { change }); }
  sdlcDiffFiles(repoPath: string, part: Part) { return this.ipc.invoke<DiffListing>('sdlc_diff_files', { repoPath, part }); }
  sdlcCommitFiles(repoPath: string) { return this.ipc.invoke<CommitFiles[]>('sdlc_commit_files', { repoPath }); }
  sdlcDiffPair(repoPath: string, part: Part, path: string) { return this.ipc.invoke<FilePair>('sdlc_diff_pair', { repoPath, part, path }); }
  sdlcDiffBase(repoPath: string) { return this.ipc.invoke<BaseInfo>('sdlc_diff_base', { repoPath }); }
  sdlcOldChecks(folder: string, systems: string[]) { return this.ipc.invoke<OldChecksNotice[]>('sdlc_old_checks', { folder, systems }); }
  sdlcOldChecksSeen(systems: string[]) { return this.ipc.invoke<void>('sdlc_old_checks_seen', { systems }); }
  sdlcChecksView(change: ChangeRef) { return this.ipc.invoke<RepoCheckView[]>('sdlc_checks_view', { change }); }
  sdlcDeclareDone(change: ChangeRef) { return this.ipc.invoke<DeclareView>('sdlc_declare_done', { change }); }
  sdlcPullRequestsView(folder: string, workspaceId: string, system: string, change: string, refresh: boolean) { return this.ipc.invoke<PullRequestsView>('sdlc_pull_requests_view', { folder, workspaceId, system, change, refresh }); }
  loadBuildLayout() { return this.ipc.invoke<unknown>('load_build_layout'); }
  saveBuildLayout(layout: Record<string, unknown>) { return this.ipc.invoke<void>('save_build_layout', { layout }); }
  openUrl(url: string) { return this.ipc.invoke<void>('open_url', { url }); }
  zoom(step: ZoomStep) { return this.ipc.invoke<number>('zoom', { step }); }
  appVersions() { return this.ipc.invoke<Versions>('app_versions'); }
  copyText(text: string) { return navigator.clipboard.writeText(text); }
  pickDirectory() { return this.ipc.open({ directory: true, multiple: false }) as Promise<string | null>; }
  pickOpenSpec() { return this.ipc.open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>; }
  pickSaveSpec() { return this.ipc.save({ filters: SPEC_FILTERS }) as Promise<string | null>; }
  onDoneStep(cb: (step: DoneStep) => void) {
    return this.ipc.listen<DoneStep>('sdlc://done-step', (e) => cb(e.payload));
  }
  onBuildState(cb: (event: BuildEvent) => void) {
    return this.ipc.listen<BuildEvent>('sdlc://build', (e) => cb(e.payload));
  }
  onRunning(cb: (strip: RunningStrip) => void) {
    return this.ipc.listen<RunningStrip>('sdlc://running', (e) => cb(e.payload));
  }
  onCloseAsked(cb: (ask: CloseOutcome) => void) {
    return this.ipc.listen<CloseOutcome>('sdlc://close-asked', (e) => cb(e.payload));
  }
  onRunEvent(cb: (runId: string, ev: KataEvent, seq?: number) => void) {
    return this.ipc.listen<{ runId: number; seq: number; event: KataEvent }>('kata://event', (e) => cb(String(e.payload.runId), e.payload.event, e.payload.seq));
  }
}
