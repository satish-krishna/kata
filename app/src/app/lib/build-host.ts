// The shapes the backend's build host, running-changes strip and close guard send over the Tauri seam.
// They are written by hand because they live in the `kata-app` crate, which has no ts-rs export; the
// serde attributes on the Rust side (`app/src-tauri/src/build_host.rs`, `running.rs`, `close_guard.rs`)
// are the source of truth. Moving them into `kata-sdlc`'s `view` module would generate them.
import type { BuildState } from '@bindings/BuildState';
import type { Given } from '@bindings/Given';
import type { KataEvent } from './events';

/** A change as the webview names it. */
export interface ChangeRef { workspace: string; system: string; change: string }

/** A repository by its normalized path; `name` is the folder's name. */
export interface RepoKey { key: string; name: string }

/** One change of one system in one workspace, as the backend keys it. */
export interface ChangeKey { workspace: RepoKey; system: string; change: string }

/** A repository another change holds. */
export interface HeldRepo { repo: string; holder: ChangeKey }

/** What the engineer chose for a build. */
export interface BuildForm {
  timeoutSecs: number;
  instructions?: string | null;
  continueOnLeftovers?: boolean;
  rounds?: { repo: string; instructions: string }[];
}

/** What starting or continuing a build, or starting a review or a round, came to. */
export type StartOutcome =
  | { kind: 'started'; uncommitted: Record<string, string[]> }
  | { kind: 'alreadyRunning' }
  | { kind: 'held'; held: HeldRepo[] }
  | { kind: 'refused'; problems: string[] }
  | { kind: 'couldNotRun'; output: string };

/** A change's build state, announced on `sdlc://build`. */
export interface BuildEvent { change: ChangeKey; state: BuildState; reviewWaiting: HeldRepo[] }

/** The kinds of run the backend tells apart. */
export type RunKind = 'setup' | 'context' | 'intent' | 'spec' | 'plan' | 'triage' | 'fix' | 'build' | 'review' | 'solo';

/** The document runs of a change that exists, which `sdlcRunChange` launches. */
export type DocumentKind = 'intent' | 'spec' | 'plan' | 'triage' | 'fix';

/** What the engineer chose for a document run; the backend composes the rest of the run-spec. */
export interface RunForm {
  name: string;
  task: string;
  permissionMode: 'bypass' | 'prompt' | 'auto';
  timeoutSecs: number;
  bare?: boolean;
  instructions?: string | null;
  continueOnLeftovers?: boolean;
  /** The items the engineer switched off in the preview. */
  given?: Given | null;
}

/** One event of a run with its position in the run, counted from 0. */
export interface HistoryEntry { seq: number; event: KataEvent }

/** A run of a change that waits on the engineer. */
export interface RunRef { run: number; kind: RunKind; repo: string | null }

/** What a running change needs or does. */
export type EntryState =
  | { state: 'needsAnswer'; text: string; run: number }
  | { state: 'needsPermission'; action: string; run: number }
  | { state: 'stopped'; repo: string; reason: string }
  | { state: 'held'; holder: ChangeKey }
  | { state: 'reviewWaiting'; holder: ChangeKey }
  | { state: 'working'; stage: RunKind; repo: string | null; run: number }
  | { state: 'finished' };

/** One running change. */
export type RunningEntry = EntryState & { change: ChangeKey; since: number; waiting: RunRef[] };

/** The strip: the first entries and every entry. */
export interface RunningStrip { shown: RunningEntry[]; all: RunningEntry[] }

/** One line of the close question. */
export interface RunningLine { change: string | null; what: string }

/** What the window does next; the webview only ever sees `ask`. */
export type CloseOutcome =
  | { type: 'close' }
  | { type: 'ask'; running: RunningLine[] }
  | { type: 'cancelThenClose'; ids: number[] }
  | { type: 'stay' };
