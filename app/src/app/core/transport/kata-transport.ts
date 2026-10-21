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
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { BuildStatus } from '@bindings/BuildStatus';
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
  abstract sdlcChanges(master: string, system: string): Promise<ChangeInfo[]>;
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
  /** Wait until the engine process of run `runId` has exited. False when it is still alive after `timeoutMs`. */
  abstract sdlcWaitRunExit(runId: string, timeoutMs: number): Promise<boolean>;
  abstract sdlcBuildStatus(master: string, system: string, change: string): Promise<BuildStatus>;
  abstract sdlcUnsavedRows(master: string, system: string, change: string): Promise<UnsavedRows[]>;
  /** `pending` names the repository a run is about to start in on the engineer's ask (a round, or Continue): its leftovers are its own to confirm. */
  abstract sdlcBuildPrepare(folder: string, masterRepo: string, system: string, change: string, continueWithLeftovers: boolean, pending?: string | null): Promise<PrepareOutcome>;
  /** Who takes part in the build, where each is checked out and which uncommitted files each one owns. */
  abstract sdlcBuildParticipants(folder: string, masterRepo: string, system: string, change: string, pending?: string | null): Promise<Participant[]>;
  abstract sdlcBuildSettle(start: BuildStart): Promise<string[]>;
  abstract sdlcBuildHeads(folder: string, repos: string[], change: string): Promise<Record<string, string>>;
  abstract sdlcPluginVersion(path: string): Promise<string | null>;
  abstract sdlcChangeRepos(folder: string, masterRepo: string, system: string, change: string): Promise<ChangeRepo[]>;
  abstract sdlcDiffFiles(repoPath: string, part: Part): Promise<DiffListing>;
  abstract sdlcDiffPair(repoPath: string, part: Part, path: string): Promise<FilePair>;
  abstract sdlcDiffBase(repoPath: string): Promise<BaseInfo>;
  abstract sdlcTouchedRepos(folder: string, masterRepo: string, system: string, change: string): Promise<PublishRepo[]>;
  abstract sdlcCommitOffenders(folder: string, masterRepo: string, system: string, change: string): Promise<Offender[]>;
  abstract sdlcChecksDir(): Promise<string>;
  abstract sdlcChecksLoad(folder: string, masterRepo: string, system: string): Promise<ChecksPlan>;
  abstract sdlcRunChecks(folder: string, masterRepo: string, system: string, repo: PublishRepo): Promise<RepoChecks>;
  abstract sdlcGhSignedIn(repos: PublishRepo[]): Promise<string>;
  abstract sdlcGhOrigins(repos: PublishRepo[]): Promise<void>;
  abstract sdlcPublish(folder: string, masterRepo: string, system: string, change: string, repos: PublishRepo[]): Promise<PrResult[]>;
  abstract sdlcPullRequests(repos: PublishRepo[], change: string): Promise<PrState[]>;
  /** Step the window's zoom. Resolves to the new level, which the backend remembers for the next launch. */
  abstract zoom(step: ZoomStep): Promise<number>;
  /** Register for relayed run events, each tagged with the id of the run it came from. Resolves to the unlisten function. */
  abstract onRunEvent(cb: (runId: string, ev: KataEvent) => void): Promise<() => void>;
}

export const NO_BACKEND = 'this action needs the Kata desktop app (Tauri backend unavailable)';
