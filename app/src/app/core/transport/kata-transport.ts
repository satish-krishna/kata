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
import type { SystemView } from '@bindings/SystemView';
import type { ChangeView } from '@bindings/ChangeView';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
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
import type { ReadResult } from '@bindings/ReadResult';
import type { ReadError } from '../../lib/doc-notice';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { Part } from '@bindings/Part';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { Offender } from '@bindings/Offender';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { PublishStep } from '@bindings/PublishStep';
import type { PrState } from '@bindings/PrState';
import type { PublishSummary } from '@bindings/PublishSummary';
import type { RenameOutcome } from '@bindings/RenameOutcome';
import type { DoneView } from '@bindings/DoneView';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import type { ZoomStep } from '../../lib/zoom-keys';
import type { BuildState } from '@bindings/BuildState';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { StartForm } from '@bindings/StartForm';
import type { HistoryEntry } from '@bindings/HistoryEntry';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { CloseOutcome } from '@bindings/CloseOutcome';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { RunForm } from '@bindings/RunForm';
import type { RunningStrip } from '@bindings/RunningStrip';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { BuildPreviewKind } from '@bindings/BuildPreviewKind';
import type { BuildSection } from '@bindings/BuildSection';
import type { ReviewView } from '@bindings/ReviewView';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { DocumentKind } from '../../lib/build-host';

/** A system's naming setting as the backend reads it: none declared, the patterns, or why they cannot be used. `reason` tells the failures apart. */
export type NamingState =
  | { kind: 'none' }
  | { kind: 'setting'; branch: string; pullRequestTitle: string }
  | { kind: 'error'; reason: 'unusable' | 'unreadable' | 'pluginTooOld' | 'pluginMissing' | 'name'; message: string };

/** The one seam between the Workbench and its backend. TauriTransport talks to
 *  the Rust commands; MockTransport stands in with fixtures and a scripted run
 *  in a plain browser. Nothing above this class knows which one it has. The
 *  event hook is callback + unlisten on purpose: no Observable crosses the seam,
 *  so nothing above it can subscribe. */
export abstract class KataTransport {
  abstract catalog(workdir: string | null): Promise<CatalogEntry[]>;
  abstract listRuns(): Promise<RunRecord[]>;
  abstract loadRun(id: string): Promise<RunDetail>;
  abstract loadSpec(path: string): Promise<RunSpec>;
  abstract saveSpec(path: string, spec: RunSpec): Promise<void>;
  abstract validateSpec(spec: RunSpec): Promise<string[]>;
  /** What the run would be given: every item, the settings, the names of its environment. The spec's `given.required_plugins` and `given.build` say what the run cannot switch off. */
  abstract previewRun(spec: RunSpec): Promise<Resolved>;
  /** Start a run. Resolves to its run id. `group` (`build:<system>/<change>`) tells the backend which runs belong to one build. */
  abstract runSpec(spec: RunSpec, group?: string): Promise<string>;
  /** Every event of a run from its start, in order, each with its position in the run, for a session opened after the run began. Empty for a run the backend does not know. */
  abstract sdlcRunHistory(runId: string): Promise<HistoryEntry[]>;
  /** Start a document run (intent, spec, plan, triage or fix) of a change that exists. The backend composes the run-spec with the change's deny rules and claims the change's own lane. Resolves to the run id. */
  abstract sdlcRunChange(change: ChangeRef, kind: DocumentKind, form: RunForm): Promise<string>;
  /** Start a change's build; nothing starts unless every repository it needs is free. */
  abstract sdlcBuildStart(change: ChangeRef, form: StartForm): Promise<StartOutcome>;
  /** Continue a change's build in one repository. */
  abstract sdlcBuildContinue(change: ChangeRef, repo: string, off?: string[]): Promise<StartOutcome>;
  /** Where a change's build stands, or null when this session hosts no build of it. */
  abstract sdlcBuildState(change: ChangeRef): Promise<BuildState | null>;
  /** Stop the run of one repository (or `review`) of a change's build, or, with none named, every run of it. */
  abstract sdlcBuildCancel(change: ChangeRef, repo: string | null): Promise<void>;
  /** The runs of a change's build that are live, each with its run's id. */
  abstract sdlcBuildRuns(change: ChangeRef): Promise<BuildRunRef[]>;
  /** The run-spec a document run of a change would start with: the backend's composition, the one `sdlcRunChange` launches. Nothing starts. */
  abstract sdlcPreviewChangeRun(change: ChangeRef, kind: DocumentKind, form: RunForm): Promise<RunSpec>;
  /** The run-spec each run of a build preview would start with, one section per folder the kind runs in. Nothing starts. */
  abstract sdlcPreviewBuild(change: ChangeRef, which: BuildPreviewKind, repo: string | null, form: StartForm): Promise<BuildSection[]>;
  /** The latest review as the page lists it: the Review group's rows and the round dialog's groups, in the backend's order. */
  abstract sdlcReviewView(change: ChangeRef): Promise<ReviewView>;
  /** Start a change's review by hand; it waits when another change holds a repository it reads. */
  abstract sdlcReviewStart(change: ChangeRef, off?: string[]): Promise<StartOutcome>;
  /** The repositories other changes hold that keep a change's review from starting; empty when it is free. */
  abstract sdlcReviewWaiting(change: ChangeRef): Promise<HeldRepo[]>;
  /** What a round may fix, and the picks that start selected, from the change's latest review. */
  abstract sdlcRoundOffer(change: ChangeRef): Promise<[RoundOffer, RoundPicks]>;
  /** The requests a round with these picks would start, or why it cannot. */
  abstract sdlcRoundPlan(change: ChangeRef, picks: RoundPicks): Promise<RoundPlan>;
  /** Start the round the picks describe. */
  abstract sdlcRoundStart(change: ChangeRef, picks: RoundPicks): Promise<StartOutcome>;
  /** The running changes: the first three and every one. */
  abstract sdlcRunning(): Promise<RunningStrip>;
  /** The engineer opened a change; it leaves the running changes once nothing of it needs them. */
  abstract sdlcMarkOpened(change: ChangeRef): Promise<void>;
  /** The engineer's answer to the close question. */
  abstract sdlcCloseAnswer(confirm: boolean): Promise<void>;
  abstract cancelRun(runId: string): Promise<void>;
  abstract submitAnswer(runId: string, id: string, answers: string[][]): Promise<void>;
  abstract sendMessage(runId: string, id: string, text: string): Promise<void>;
  abstract submitDecision(runId: string, id: string, allow: boolean, message: string | null): Promise<void>;
  abstract listKatas(): Promise<KataListing>;
  abstract loadKata(name: string): Promise<RunSpec>;
  abstract saveKata(spec: RunSpec): Promise<void>;
  abstract listPresets(): Promise<Preset[]>;
  abstract savePreset(name: string, body: string): Promise<void>;
  abstract exportBundle(spec: RunSpec, out: string): Promise<void>;
  abstract pickDirectory(): Promise<string | null>;
  abstract pickOpenSpec(): Promise<string | null>;
  abstract pickSaveSpec(): Promise<string | null>;
  abstract sdlcSettings(): Promise<Settings>;
  abstract sdlcSaveSettings(settings: Settings): Promise<void>;
  abstract sdlcWorkspaces(): Promise<WorkspaceEntry[]>;
  abstract sdlcSaveWorkspaces(workspaces: WorkspaceEntry[]): Promise<void>;
  abstract sdlcScan(folder: string): Promise<WorkspaceScan>;
  abstract sdlcContextHealth(folder: string, master: string, system: string, repo: string): Promise<ContextState>;
  abstract sdlcInstructions(folder: string, masterRepo: string): Promise<InstructionsState>;
  /** The text of `intent/<system>/context/<repo>.md` in the master, or null when the file is not there. */
  abstract sdlcReadContext(master: string, system: string, repo: string): Promise<string | null>;
  /** Every change of a system as the plugin reports it, with what each shows and offers, from one read. */
  abstract sdlcState(folder: string, system: string): Promise<SystemView>;
  /** One change as the plugin reports it, with what it shows and offers, from one read. Rejects with the reason when the change cannot be read. */
  abstract sdlcChangeState(folder: string, system: string, change: string): Promise<ChangeView>;
  /** Which of the folders no longer exist. A folder existence check only. */
  abstract sdlcMissingFolders(folders: string[]): Promise<string[]>;
  abstract sdlcBranches(master: string): Promise<BranchInfo>;
  abstract sdlcReadDoc(master: string, system: string, change: string, doc: string): Promise<string | null>;
  abstract sdlcSnapshot(master: string): Promise<Snapshot>;
  /** `build` scopes the run to a build: only that change's build log rows are build log data. A run outside a build passes none. */
  abstract sdlcLeftovers(master: string, before: Snapshot, productRepos: string[], build?: BuildScope): Promise<Leftovers>;
  abstract sdlcDiscard(master: string, before: Snapshot, paths: string[], build?: BuildScope): Promise<void>;
  /** The name the plugin will give a change described by `title`, so the preview shows it. */
  abstract sdlcChangeName(title: string): Promise<string>;
  /** Ask the plugin to start a change: its branch and its own copy. A refusal is an answer with the plugin's reasons, not an error. */
  abstract sdlcStartChange(folder: string, system: string, title: string, workType: string, scope: string, branch?: string): Promise<ChangeStart>;
  /** The system's naming setting, or why it cannot be used. */
  abstract sdlcNaming(folder: string, masterRepo: string, system: string): Promise<NamingState>;
  /** Rename the change's branch in every repository that has it. Rejects while a build run is live. */
  abstract sdlcRenameBranch(folder: string, workspaceId: string, system: string, change: string, to: string): Promise<RenameOutcome>;
  /** Repositories where the change's branch name is already taken on GitHub by work this machine does not have. */
  /** Why the scope is not usable, one reason per entry; empty when it is accepted as typed. */
  abstract sdlcCheckScope(folder: string, scope: string): Promise<string[]>;
  abstract sdlcCheckout(master: string, branch: string): Promise<void>;
  /** Accept a document of a change: the plugin commits it and runs the team's accepting hooks. */
  abstract sdlcAccept(change: ChangeRef, doc: ChangeDocument): Promise<AcceptOutcome>;
  /** Reject a change through the plugin, which commits the rejection and removes the change's copy. */
  abstract sdlcReject(change: ChangeRef): Promise<RejectOutcome>;
  /** Whether the change's copy may be removed, from the backend: it asks GitHub for the pull request states, so it is slow. */
  abstract sdlcCopyRemoval(change: ChangeRef): Promise<CopyRemoval>;
  /** The branch the change's copy holds, as the plugin records it. */
  abstract sdlcCopyBranch(change: ChangeRef): Promise<string>;
  /** Remove the change's copy on the engineer's confirmation; the answer says what came of it. */
  abstract sdlcRemoveCopy(change: ChangeRef): Promise<RemoveOutcome>;
  /** Open the folder of the change's copy in the file manager. Rejects when the change is not in a copy. */
  abstract sdlcOpenCopyFolder(change: ChangeRef): Promise<void>;
  abstract sdlcRunLinks(): Promise<RunLink[]>;
  abstract sdlcLinkRun(link: RunLink): Promise<void>;
  /** Which run recorded each task, in the order they were linked. */
  abstract sdlcTaskLinks(): Promise<TaskLink[]>;
  /** Append the links for the tasks a run recorded, in one write. */
  /** Wait until the engine process of run `runId` has exited. False when it is still alive after `timeoutMs`. */
  abstract sdlcWaitRunExit(runId: string, timeoutMs: number): Promise<boolean>;
  abstract sdlcBuildStatus(master: string, system: string, change: string): Promise<BuildStatus>;
  /** A change's spec or plan as the format program reads it; null when the file is not there, and an error result with the program's own message when it cannot read it. */
  abstract sdlcReadParsed(master: string, system: string, change: string, doc: string): Promise<ReadResult | ReadError | null>;
  /** The change's review document as committed, or null when it has none. */
  abstract sdlcReviewRecord(master: string, system: string, change: string): Promise<ReviewRecord | null>;
  abstract sdlcBuildHeads(folder: string, masterRepo: string, system: string, repos: string[], change: string): Promise<Record<string, string>>;
  /** Whether the ai-sdlc plugin is installed and new enough, as the backend decides it for the workspace folder. */
  abstract sdlcPluginReadiness(workdir: string | null): Promise<Readiness>;
  abstract sdlcChangeRepos(folder: string, masterRepo: string, system: string, change: string): Promise<ChangeRepo[]>;
  /** The product repositories in the build that have no `change/<change>` branch, which the Changes view cannot list. */
  abstract sdlcMissingChangeBranches(folder: string, masterRepo: string, system: string, change: string): Promise<string[]>;
  abstract sdlcDiffFiles(repoPath: string, part: Part): Promise<DiffListing>;
  /** The commits on the change branch since the merge base, oldest first, each with the files it touched. */
  abstract sdlcCommitFiles(repoPath: string): Promise<CommitFiles[]>;
  abstract sdlcDiffPair(repoPath: string, part: Part, path: string): Promise<FilePair>;
  abstract sdlcDiffBase(repoPath: string): Promise<BaseInfo>;
  abstract sdlcTouchedRepos(folder: string, masterRepo: string, system: string, change: string): Promise<PublishRepo[]>;
  abstract sdlcCommitOffenders(folder: string, masterRepo: string, system: string, change: string): Promise<Offender[]>;
  /** What each repository of the change's checks came to, as the plugin recorded it. */
  abstract sdlcChecksView(change: ChangeRef): Promise<RepoCheckView[]>;
  abstract sdlcChecksDir(): Promise<string>;
  abstract sdlcChecksLoad(folder: string, masterRepo: string, system: string): Promise<ChecksPlan>;
  abstract sdlcRunChecks(folder: string, masterRepo: string, system: string, repo: PublishRepo): Promise<RepoChecks>;
  abstract sdlcGhSignedIn(repos: PublishRepo[]): Promise<string>;
  abstract sdlcGhOrigins(repos: PublishRepo[]): Promise<void>;
  abstract sdlcPublish(folder: string, workspaceId: string, masterRepo: string, system: string, change: string, repos: PublishRepo[]): Promise<PublishSummary>;
  /** Whether the change shows as done and with which pull request links, from what was saved. GitHub is asked only when nothing is saved and the build is finished. */
  abstract sdlcDoneView(folder: string, masterRepo: string, workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView>;
  /** Ask GitHub for the state of every saved pull request, save the answers, and return the new view. */
  abstract sdlcRefreshPrStates(folder: string, masterRepo: string, workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView>;
  abstract sdlcPullRequests(masterRepo: string, system: string, repos: PublishRepo[], change: string): Promise<PrState[]>;
  /** The build page's arrangement, one per mode and shared by every change. `{}` until one is saved. */
  abstract loadBuildLayout(): Promise<unknown>;
  abstract saveBuildLayout(layout: Record<string, unknown>): Promise<void>;
  /** Open an address in the default browser; the webview ignores `target="_blank"`. */
  abstract openUrl(url: string): Promise<void>;
  /** Step the window's zoom. Resolves to the new level, which the backend remembers for the next launch. */
  abstract zoom(step: ZoomStep): Promise<number>;
  /** Register for what publishing is doing (pushing or opening a pull request, per repository). Resolves to the unlisten function. */
  abstract onPublishStep(cb: (step: PublishStep) => void): Promise<() => void>;
  /** Register for a change's build state each time it changes. Resolves to the unlisten function. */
  abstract onBuildState(cb: (event: BuildEvent) => void): Promise<() => void>;
  /** Register for the running changes each time they may have changed. Resolves to the unlisten function. */
  abstract onRunning(cb: (strip: RunningStrip) => void): Promise<() => void>;
  /** Register for the question the backend asks when the window is closed while runs are live. Resolves to the unlisten function. */
  abstract onCloseAsked(cb: (ask: CloseOutcome) => void): Promise<() => void>;
  /** Register for relayed run events, each tagged with the id of the run it came from and its position in that run (`seq`, absent only in a fixture). Resolves to the unlisten function. */
  abstract onRunEvent(cb: (runId: string, ev: KataEvent, seq?: number) => void): Promise<() => void>;
}

export const NO_BACKEND = 'this action needs the Kata desktop app (Tauri backend unavailable)';
