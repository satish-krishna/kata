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
  abstract runSpec(spec: RunSpec): Promise<void>;
  abstract cancelRun(): Promise<void>;
  abstract submitAnswer(id: string, answers: string[][]): Promise<void>;
  abstract submitDecision(id: string, allow: boolean, message: string | null): Promise<void>;
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
  abstract sdlcLeftovers(master: string, before: Snapshot, productRepos: string[]): Promise<Leftovers>;
  abstract sdlcDiscard(master: string, before: Snapshot, paths: string[]): Promise<void>;
  abstract sdlcStartChange(master: string, base: string): Promise<string>;
  abstract sdlcFinishChange(master: string, pending: string, base: string): Promise<FinishOutcome>;
  abstract sdlcCheckout(master: string, branch: string): Promise<void>;
  abstract sdlcDecide(master: string, system: string, change: string, decision: Decision, confirmed: boolean): Promise<DecideOutcome>;
  abstract sdlcRunLinks(): Promise<RunLink[]>;
  abstract sdlcLinkRun(link: RunLink): Promise<void>;
  /** Register for relayed run events. Resolves to the unlisten function. */
  abstract onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void>;
}

export const NO_BACKEND = 'this action needs the Kata desktop app (Tauri backend unavailable)';
