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
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ChangeName } from '@bindings/ChangeName';
import type { StageEvent } from '@bindings/StageEvent';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildAction } from '@bindings/BuildAction';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { TaskLink } from '@bindings/TaskLink';
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
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { Offender } from '@bindings/Offender';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { PrResult } from '@bindings/PrResult';
import type { PublishStep } from '@bindings/PublishStep';
import type { PrState } from '@bindings/PrState';
import type { DoneView } from '@bindings/DoneView';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import type { ZoomStep } from '../../lib/zoom-keys';

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
  abstract cancelRun(runId: string): Promise<void>;
  abstract submitAnswer(runId: string, id: string, answers: string[][]): Promise<void>;
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
  /** The changes of a system with the title of each intent, from the folder alone: no stage is read and no program is started. */
  abstract sdlcChangeNames(master: string, system: string): Promise<ChangeName[]>;
  /** Start reading the stage of every change in the background and resolve to the pass id at once. Each result arrives through `onStageEvent`. A pass started while another is running supersedes it; the superseded pass reports nothing more. `first` names a change to read before the others. */
  abstract sdlcReadStages(master: string, system: string, first?: string | null): Promise<number>;
  /** One change read in full, for the list row and the change page. Rejects with the reason when the change cannot be read. */
  abstract sdlcReadChange(master: string, system: string, change: string): Promise<ChangeInfo>;
  /** Which of the folders no longer exist. A folder existence check only. */
  abstract sdlcMissingFolders(folders: string[]): Promise<string[]>;
  abstract sdlcBranches(master: string): Promise<BranchInfo>;
  abstract sdlcReadDoc(master: string, system: string, change: string, doc: string): Promise<string | null>;
  abstract sdlcSnapshot(master: string): Promise<Snapshot>;
  /** `build` scopes the run to a build: only that change's build log rows are build log data. A run outside a build passes none. */
  abstract sdlcLeftovers(master: string, before: Snapshot, productRepos: string[], build?: BuildScope): Promise<Leftovers>;
  abstract sdlcDiscard(master: string, before: Snapshot, paths: string[], build?: BuildScope): Promise<void>;
  abstract sdlcStartChange(master: string, base: string): Promise<string>;
  abstract sdlcFinishChange(master: string, pending: string, base: string): Promise<FinishOutcome>;
  abstract sdlcCheckout(master: string, branch: string): Promise<void>;
  abstract sdlcDecide(master: string, system: string, change: string, decision: Decision, confirmed: boolean): Promise<DecideOutcome>;
  abstract sdlcRunLinks(): Promise<RunLink[]>;
  abstract sdlcLinkRun(link: RunLink): Promise<void>;
  /** Which run recorded each task, in the order they were linked. */
  abstract sdlcTaskLinks(): Promise<TaskLink[]>;
  /** Append the links for the tasks a run recorded, in one write. */
  abstract sdlcLinkTasks(links: TaskLink[]): Promise<void>;
  /** Wait until the engine process of run `runId` has exited. False when it is still alive after `timeoutMs`. */
  abstract sdlcWaitRunExit(runId: string, timeoutMs: number): Promise<boolean>;
  abstract sdlcBuildStatus(master: string, system: string, change: string): Promise<BuildStatus>;
  /** A change's spec or plan as the format program reads it; null when the file is not there, and an error result with the program's own message when it cannot read it. */
  abstract sdlcReadParsed(master: string, system: string, change: string, doc: string): Promise<ReadResult | ReadError | null>;
  /** The change's review document as committed, or null when it has none. */
  abstract sdlcReviewRecord(master: string, system: string, change: string): Promise<ReviewRecord | null>;
  /** The files a review run changed in the master besides the change's review document, since the head `since`; empty when it kept to the document. */
  abstract sdlcReviewVerify(master: string, system: string, change: string, since: string, before: Snapshot['dirty']): Promise<string[]>;
  abstract sdlcUnsavedRows(master: string, system: string, change: string): Promise<UnsavedRows[]>;
  /** `pending` names the repository a run is about to start in on the engineer's ask (a round, or Continue): its leftovers are its own to confirm. */
  abstract sdlcBuildPrepare(folder: string, masterRepo: string, system: string, change: string, continueWithLeftovers: boolean, pending: string | null, action: BuildAction): Promise<PrepareOutcome>;
  /** Who takes part in the build, where each is checked out and which uncommitted files each one owns. */
  abstract sdlcBuildParticipants(folder: string, masterRepo: string, system: string, change: string, pending?: string | null): Promise<Participant[]>;
  abstract sdlcBuildSettle(start: BuildStart): Promise<string[]>;
  abstract sdlcBuildHeads(folder: string, repos: string[], change: string): Promise<Record<string, string>>;
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
  abstract sdlcChecksDir(): Promise<string>;
  abstract sdlcChecksLoad(folder: string, masterRepo: string, system: string): Promise<ChecksPlan>;
  abstract sdlcRunChecks(folder: string, masterRepo: string, system: string, repo: PublishRepo): Promise<RepoChecks>;
  abstract sdlcGhSignedIn(repos: PublishRepo[]): Promise<string>;
  abstract sdlcGhOrigins(repos: PublishRepo[]): Promise<void>;
  abstract sdlcPublish(folder: string, workspaceId: string, masterRepo: string, system: string, change: string, repos: PublishRepo[]): Promise<PrResult[]>;
  /** Whether the change shows as done and with which pull request links, from what was saved. GitHub is asked only when nothing is saved and the build is finished. */
  abstract sdlcDoneView(folder: string, masterRepo: string, workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView>;
  /** Ask GitHub for the state of every saved pull request, save the answers, and return the new view. */
  abstract sdlcRefreshPrStates(folder: string, masterRepo: string, workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView>;
  abstract sdlcPullRequests(repos: PublishRepo[], change: string): Promise<PrState[]>;
  /** The build page's arrangement, one per mode and shared by every change. `{}` until one is saved. */
  abstract loadBuildLayout(): Promise<unknown>;
  abstract saveBuildLayout(layout: Record<string, unknown>): Promise<void>;
  /** Open an address in the default browser; the webview ignores `target="_blank"`. */
  abstract openUrl(url: string): Promise<void>;
  /** Step the window's zoom. Resolves to the new level, which the backend remembers for the next launch. */
  abstract zoom(step: ZoomStep): Promise<number>;
  /** Register for what publishing is doing (pushing or opening a pull request, per repository). Resolves to the unlisten function. */
  abstract onPublishStep(cb: (step: PublishStep) => void): Promise<() => void>;
  /** Register for what a stage pass reports, each event tagged with its pass id. Resolves to the unlisten function. */
  abstract onStageEvent(cb: (ev: StageEvent) => void): Promise<() => void>;
  /** Register for relayed run events, each tagged with the id of the run it came from. Resolves to the unlisten function. */
  abstract onRunEvent(cb: (runId: string, ev: KataEvent) => void): Promise<() => void>;
}

export const NO_BACKEND = 'this action needs the Kata desktop app (Tauri backend unavailable)';
