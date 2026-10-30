import { defaultWorkType, orderedWorkTypes, type WorkType } from '../../lib/sdlc-naming';
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import type { BuildAction } from '@bindings/BuildAction';
import type { BuildScope } from '@bindings/BuildScope';
import type { BuildStart } from '@bindings/BuildStart';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Leftovers } from '@bindings/Leftovers';
import type { Problem } from '@bindings/Problem';
import type { Readiness } from '@bindings/Readiness';
import type { RunSpec } from '@bindings/RunSpec';
import type { RepoFiles } from '@bindings/RepoFiles';
import type { Snapshot } from '@bindings/Snapshot';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { RunState } from '../../lib/events';
import type { RunSnapshot } from '../run/reduce';
import { restrictedFor, specFor, transcriptRunId, type StartTrack } from '../../lib/sdlc';
import { masterPath, masterRepo, productRepos as productReposOf } from '../../lib/sdlc-workspace';
import { LockStore } from '../lock/lock.store';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';
import { KataTransport } from '../transport/kata-transport';

/** What a run is about: where the master repo is, which product repos to watch, and what to link the transcript to. */
export type RunTarget = {
  workspaceId: string;
  /** Absolute path of the master repo, or null before one exists (first setup): nothing is snapshotted then. */
  master: string | null;
  /** Folder names of the product repos checked for stray writes after a failed run. */
  productRepos: string[];
  /** The change and stage the transcript belongs to, or null when the caller links it later. */
  link: { system: string; change: string; stage: string } | null;
  /** Names the run in the finished/failed toast; defaults to the lock title. */
  label?: string;
  /**
   * First-time setup with no master yet: every repo in the workspace folder is snapshotted before the run,
   * so a run that stops after creating the master can still report what it left behind there.
   */
  firstSetup?: { folder: string; repos: string[] };
  /** The pending branch of a new change, named in the toast when the engine does not exit in time. */
  pendingBranch?: string;
};

/** `exited` is false when the engine was still alive after the wait: nothing was read or cleaned up then. */
export type RunOutcome = { state: RunState; runId: string | null; snapshot: Snapshot | null; exited: boolean };

/** What the screen needs to place a new change: the workspace, its master repo path and the product repos. */
/** The preview before a run: takes the built spec, answers with the spec to run or null when the engineer cancelled. */
export type Confirm = (spec: RunSpec) => Promise<RunSpec | null>;

/**
 * What starting a change came to. `opened` names the change and its branch, which the master repository is left on. `none`: the run ended and no change folder was created (the idea and the run's id let the engineer describe it again or read the verdict).
 * `stopped`: nothing to report, because no run started or the run's branch was kept for the engineer to settle; a toast already said why where one was due.
 */
export type NewChangeOutcome =
  | { kind: 'opened'; change: string; branch: string }
  | { kind: 'refused' }
  | { kind: 'stopped' }
  | { kind: 'none'; idea: string; runId: string | null };

/** The branch name confirmation of one change: what the dialog shows and the engineer may edit. */
export type NameRequest = {
  system: string;
  change: string;
  pending: string;
  workType: WorkType;
  workTypes: WorkType[];
  suggestion: string;
  /** Why the last attempt was refused, or why no name could be suggested; null otherwise. */
  error: string | null;
  busy: boolean;
  /** The confirmation renames a branch that already has a name: no type to pick, and the suggestion is the current name. */
  rename?: boolean;
};

/** What the confirmation needs to name one change's pending branch. `workType` is the start pick, null when there was none; `track` is the change's own. */
export type NameAsk = {
  folder: string;
  masterRepo: string;
  system: string;
  change: string;
  pending: string;
  workType: WorkType | null;
  track: 'full' | 'fix';
};

/** What renaming a change's branch needs: the branch it has now is the starting name. */
export type RenameAsk = { folder: string; workspaceId: string; masterRepo: string; system: string; change: string; current: string };

/** What the engineer picked when the system has a naming setting. */
export type PickedNaming = { workType: WorkType; scope: string };

export type ChangeTarget = { workspace: WorkspaceEntry; master: string; productRepos: string[] };

/** The master repo a stopped run is compared against, with its pre-run snapshot. */
type Baseline = { master: string; snapshot: Snapshot; productRepos: string[] };
type PendingLink = { workspace_id: string; system: string; change: string; stage: string; started_at: number };

/** One repository's uncommitted edits left by a run, with the snapshot that run started from. */
/** What one repository's run left behind. `build` is set when the run belonged to a build: only that change's build log rows are build log data. */
export type RepoLeftovers = { repo: string; path: string; snapshot: Snapshot; data: Leftovers; build?: BuildScope };
/** What the engine needs to start the build: the change and the plugin that can run it. */
export type BuildRequest = {
  folder: string;
  masterRepo: string;
  system: string;
  change: string;
  /** What the engineer asked for; every action meets the same gate. */
  action: BuildAction;
  continueWithLeftovers: boolean;
  /** The repository a round is aimed at: its uncommitted files are its own to confirm, even when its tasks are all done or it is the master. */
  pending?: string | null;
};
export type PrepareResult =
  | { kind: 'ready'; start: BuildStart }
  | { kind: 'needs-confirm'; leftovers: RepoFiles[] }
  /** The change's branch holds other work in `repo`; the engineer picks a new name. */
  | { kind: 'branch-taken'; repo: string; branch: string }
  /** `problems` lists what the check found in the plan or a build log, when that is why the build did not go on. */
  | { kind: 'refused'; reason: string; problems?: Problem[] };
/** A repository run of the build, or the review of the whole change (which runs in the master repository). */
export type BuildRunTarget = { repo: string; path: string; kind: 'repo' | 'review' };
export type BuildLink = {
  workspaceId: string;
  system: string;
  change: string;
  folder: string;
  master: string;
  repos: string[];
  /** Called with the run's id as soon as the run has started and joined the build's lock. */
  onRun?: (runId: string) => void;
};
export type RunEnd = { exit: number | null; error: string | null };
export type DiscardChoice = { repo: string; paths: string[] };

const RESULT_MAX = 120;
/** How long to wait for the engine process to exit before touching the repo. */
const EXIT_WAIT_MS = 15000;
const TERMINAL: readonly RunState[] = ['success', 'warning', 'error'];
const INSTALL_PLUGIN = 'Install the ai-sdlc plugin, then start the build again.';
const updatePlugin = (need: string): string => `Update the ai-sdlc plugin to ${need} or later, then start the build again.`;
const DIRTY = 'uncommitted changes';
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };

const repoName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
const sameDir = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** Product repos are named by folder; they sit next to the master repo in the workspace folder. */
const siblingsOf = (master: string, repos: string[]): string[] => {
  const root = master.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  return repos.map((r) => masterPath(root, r));
};
const stillStopping = (branch: string | undefined): string =>
  branch
    ? `The engine is still stopping. Nothing was cleaned up; the pending branch ${branch} was kept.`
    : 'The engine is still stopping. Nothing was cleaned up.';

function summarize(result: string | null | undefined): string {
  const flat = (result ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return 'done';
  return flat.length > RESULT_MAX ? `${flat.slice(0, RESULT_MAX - 1)}…` : flat;
}

const hasLeftovers = (l: Leftovers): boolean =>
  [l.new_commits, l.discardable, l.touched_dirty, l.created, l.product_repos_changed, l.product_repos_unchecked].some((xs) => xs.length > 0);

/** Commits are what a build is for, so only uncommitted edits count as left behind. */
const uncommittedOnly = (l: Leftovers): Leftovers => ({ ...EMPTY, discardable: l.discardable, touched_dirty: l.touched_dirty, created: l.created });
const hasUncommitted = (l: Leftovers): boolean => l.discardable.length > 0 || l.touched_dirty.length > 0 || l.created.length > 0;

/**
 * Runs AI-SDLC agent work end to end: snapshot the master repo, hold the lock, link the transcript to its
 * change, and when the run did not succeed report what it left behind. Every run ends with a toast. Both
 * AI-SDLC screens go through this service; neither re-implements any of it.
 */
@Injectable({ providedIn: 'root' })
export class SdlcRunner {
  private readonly transport = inject(KataTransport);
  private readonly lock = inject(LockStore);
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  private readonly injector = inject(Injector);
  private readonly pending = signal<RepoLeftovers[]>([]);
  /** What the build's runs left, held until the build is over: the dialog must not open under a live build. */
  private held: RepoLeftovers[] = [];
  private closeWaiters: (() => void)[] = [];
  private linkTarget: PendingLink | null = null;

  /** What the last non-successful run left behind; the screen's leftover dialog renders it. */
  readonly leftovers = computed<RepoLeftovers[] | null>(() => (this.pending().length === 0 ? null : this.pending()));

  private readonly afterRun = signal(false);
  /** A run has ended but its after-run work (engine exit, report) is still going: the session view cannot close yet. */
  readonly settling = this.afterRun.asReadonly();
  private readonly picked = signal<WorkType | null>(null);
  /** The work type picked for the change being started, kept for the confirmation of its branch name; null without a naming setting. */
  readonly pickedWorkType = this.picked.asReadonly();

  private readonly request = signal<NameRequest | null>(null);
  /** The branch name confirmation on show; null when none is open. */
  readonly nameRequest = this.request.asReadonly();
  private readonly namedCount = signal(0);
  /** Counts the branches named so far; a page showing the change reads it again when this moves. */
  readonly named = this.namedCount.asReadonly();
  private ask: NameAsk | null = null;
  private renameAsk: RenameAsk | null = null;
  private settleName: ((named: { branch: string; change: string } | null) => void) | null = null;
  private nameSeq = 0;
  /** The type picked at the start of the change that is waiting for a name, kept for opening the confirmation again. */
  private pickedFor: { change: string; type: WorkType } | null = null;

  /**
   * Ask the engineer to confirm the name of `change`'s pending branch. The type starts as the start pick, else the change's own track's default.
   * Resolves with the renamed branch, or null when the dialog was closed.
   */
  async requestName(ask: NameAsk): Promise<{ branch: string; change: string } | null> {
    this.closeName();
    const picked = this.pickedFor?.change === ask.change ? this.pickedFor.type : null;
    const track = defaultWorkType(ask.track === 'fix' ? 'decide' : 'full');
    const workType = ask.workType ?? picked ?? track;
    this.ask = ask;
    this.request.set({
      system: ask.system,
      change: ask.change,
      pending: ask.pending,
      workType,
      workTypes: orderedWorkTypes(ask.track === 'fix' ? 'decide' : 'full'),
      suggestion: '',
      error: null,
      busy: true,
    });
    const named = new Promise<{ branch: string; change: string } | null>((resolve) => {
      this.settleName = resolve;
    });
    await this.suggest(workType);
    return named;
  }

  /**
   * Ask the engineer for a new name for the branch `ask.current`, in every repository that has it. No type is picked and the
   * current name is the starting point. Resolves with the new branch, or null when the dialog was closed.
   */
  async requestRename(ask: RenameAsk): Promise<{ branch: string; change: string } | null> {
    this.closeName();
    this.renameAsk = ask;
    this.request.set({
      system: ask.system,
      change: ask.change,
      pending: ask.current,
      workType: defaultWorkType('full'),
      workTypes: [],
      suggestion: ask.current,
      error: null,
      busy: false,
      rename: true,
    });
    return new Promise((resolve) => {
      this.settleName = resolve;
    });
  }

  /** The engineer picked another type: the suggestion follows it. */
  async setNameType(type: WorkType): Promise<void> {
    const cur = this.request();
    if (cur === null) return;
    this.request.set({ ...cur, workType: type, busy: true });
    await this.suggest(type);
  }

  private async suggest(type: WorkType): Promise<void> {
    const ask = this.ask;
    if (ask === null) return;
    const seq = ++this.nameSeq;
    let suggestion = '';
    let error: string | null = null;
    try {
      suggestion = await this.transport.sdlcSuggestBranch(ask.folder, ask.masterRepo, ask.system, ask.change, type);
    } catch (e) {
      error = message(e);
    }
    const cur = this.request();
    if (seq !== this.nameSeq || cur === null) return;
    this.request.set({ ...cur, suggestion, error, busy: false });
  }

  /** Rename the pending branch to `name`. A refusal stays on the request and the confirmation stays open. */
  async confirmName(name: string): Promise<void> {
    const ask = this.ask;
    const cur = this.request();
    if (cur === null || cur.busy) return;
    if (this.renameAsk !== null) return this.confirmRename(this.renameAsk, name);
    if (ask === null) return;
    this.request.set({ ...cur, error: null, busy: true });
    let outcome: FinishOutcome;
    try {
      outcome = await this.transport.sdlcConfirmBranch(ask.folder, ask.masterRepo, ask.system, ask.change, ask.pending, name, cur.workType);
    } catch (e) {
      this.request.update((r) => (r === null ? r : { ...r, error: message(e), busy: false }));
      return;
    }
    if (typeof outcome === 'string' || !('renamed' in outcome)) {
      this.request.update((r) => (r === null ? r : { ...r, error: 'The branch was not renamed.', busy: false }));
      return;
    }
    this.pickedFor = null;
    this.finishName(outcome.renamed);
    this.namedCount.update((n) => n + 1);
  }

  /** Rename the change's branch everywhere. A refusal stays on the request and the confirmation stays open. */
  private async confirmRename(ask: RenameAsk, name: string): Promise<void> {
    this.request.update((r) => (r === null ? r : { ...r, error: null, busy: true }));
    try {
      const done = await this.transport.sdlcRenameBranch(ask.folder, ask.workspaceId, ask.masterRepo, ask.system, ask.change, name);
      this.finishName({ branch: done.new, change: ask.change });
      this.namedCount.update((n) => n + 1);
    } catch (e) {
      this.request.update((r) => (r === null ? r : { ...r, error: message(e), busy: false }));
    }
  }

  /** Close the confirmation without naming: the change stays on its pending branch and offers the confirmation again. */
  closeName(): void {
    this.finishName(null);
  }

  private finishName(named: { branch: string; change: string } | null): void {
    const settle = this.settleName;
    this.settleName = null;
    this.ask = null;
    this.renameAsk = null;
    this.nameSeq++;
    this.request.set(null);
    settle?.(named);
  }

  constructor() {
    // Link the transcript the moment its id shows up, not at the end: a run that never ends still gets linked.
    effect(() => {
      const id = transcriptRunId(this.runs.events());
      untracked(() => this.linkOnce(id));
    });
  }

  private isBusy(): boolean {
    const busy = this.runs.state();
    return this.lock.active() !== null || busy === 'running' || busy === 'awaiting';
  }

  async run(title: string, spec: RunSpec, target: RunTarget): Promise<RunOutcome> {
    if (this.isBusy()) {
      this.toasts.error('Another task is already running.');
      return { state: 'error', runId: null, snapshot: null, exited: true };
    }
    let snapshot: Snapshot | null = null;
    let candidates: Map<string, Snapshot> | null = null;
    if (target.master !== null) {
      try {
        snapshot = await this.transport.sdlcSnapshot(target.master);
      } catch (e) {
        this.toasts.error(`Could not read the master repo before the run: ${message(e)}`);
        return { state: 'error', runId: null, snapshot: null, exited: true };
      }
    } else if (target.firstSetup) {
      candidates = await this.snapshotAll(target.firstSetup);
    }
    this.linkTarget = target.link
      ? { workspace_id: target.workspaceId, ...target.link, started_at: Math.floor(Date.now() / 1000) }
      : null;
    // Settling from before the run ends, so the finished view never shows an enabled Close ahead of the work below.
    this.afterRun.set(true);
    let state: RunState;
    try {
      state = await this.lock.runAgent(title, spec);
    } catch (e) {
      this.afterRun.set(false);
      throw e;
    }
    const runId = transcriptRunId(this.runs.events());
    this.linkOnce(runId);
    this.linkTarget = null;
    // The session view stays up after the run: the after-run work below happens under it, and the caller
    // (finish a branch, navigate) carries on only once the operator has closed it.
    try {
      // The terminal event reaches the UI before the engine process is gone; a cancelled engine may still be
      // writing. Nothing reads or changes the repo until it has exited.
      if (!(await this.engineExited())) {
        this.toasts.error(stillStopping(target.pendingBranch));
        return { state, runId, snapshot, exited: false };
      }
      const label = target.label ?? title;
      if (state === 'success') {
        this.toasts.success(`${label} finished · ${summarize(this.runs.summary()?.result)}`);
      } else {
        await this.reportStopped(label, state, target, snapshot, candidates);
      }
      return { state, runId, snapshot, exited: true };
    } finally {
      this.afterRun.set(false);
      await this.lock.dismissed();
    }
  }

  /** Check the build can start and ask the backend to prepare it. Nothing else is touched before the plugin check passes (R2.5); the backend then refuses a plan or build log that fails the check (R8.1). */
  async prepareBuild(req: BuildRequest): Promise<PrepareResult> {
    let readiness: Readiness;
    try {
      readiness = await this.transport.sdlcPluginReadiness(req.folder);
    } catch {
      readiness = { kind: 'missing' };
    }
    if (readiness.kind === 'tooOld') return { kind: 'refused', reason: updatePlugin(readiness.need) };
    if (readiness.kind === 'missing') return { kind: 'refused', reason: INSTALL_PLUGIN };
    try {
      const out = await this.transport.sdlcBuildPrepare(req.folder, req.masterRepo, req.system, req.change, req.continueWithLeftovers, req.pending ?? null, req.action);
      if (out.kind === 'refused') return { kind: 'refused', reason: out.message, problems: out.problems };
      if (out.kind === 'branchTaken') return { kind: 'branch-taken', repo: out.repo, branch: out.branch };
      if (out.kind === 'ready') {
        this.held = [];
        return { kind: 'ready', start: out.start };
      }
      return { kind: 'needs-confirm', leftovers: out.leftovers };
    } catch (e) {
      return { kind: 'refused', reason: message(e) };
    }
  }

  /**
   * One run of the build inside one repository. Snapshots the repository first, joins the run to the build's
   * lock, links its transcript, and once the run and its engine are gone keeps whatever it left uncommitted.
   */
  async runInRepo(target: BuildRunTarget, spec: RunSpec, link: BuildLink): Promise<RunEnd> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.transport.sdlcSnapshot(target.path);
    } catch (e) {
      return { exit: null, error: `Could not read ${target.repo} before the run: ${message(e)}` };
    }
    // A build log row sits in the master's tree, so it is classified against the master's snapshot; a repository's own covers only its own tree.
    let masterSnapshot = snapshot;
    if (!sameDir(target.path, link.master)) {
      try {
        masterSnapshot = await this.transport.sdlcSnapshot(link.master);
      } catch (e) {
        return { exit: null, error: `Could not read ${repoName(link.master)} before the run: ${message(e)}` };
      }
    }
    const review = target.kind === 'review';
    let heads: Record<string, string> | undefined;
    if (review) {
      try {
        heads = await this.transport.sdlcBuildHeads(link.folder, repoName(link.master), link.system, [target.repo, ...link.repos], link.change);
      } catch (e) {
        this.toasts.error(`Could not record where each repository stood: ${message(e)}`);
      }
    }
    const id = await this.runs.startRun(spec, `build:${link.system}/${link.change}`);
    if (id === null) return { exit: null, error: 'The run did not start' };
    this.lock.addRun(id, spec);
    link.onRun?.(id);
    const startedAt = Math.floor(Date.now() / 1000);
    let linked = false;
    const end = await this.untilEnded(id, (runId) => {
      if (linked) return;
      linked = true;
      this.transport
        .sdlcLinkRun({
          workspace_id: link.workspaceId,
          system: link.system,
          change: link.change,
          stage: review ? 'review' : `build:${target.repo}`,
          run_id: runId,
          started_at: startedAt,
          ...(heads ? { heads } : {}),
        })
        .catch((e: unknown) => this.toasts.error(`Could not link the run to the change: ${message(e)}`));
    });
    const exit = end.exit ?? (end.state === 'success' ? 0 : null);
    const error = this.lastError(end);
    if (!(await this.engineExited(id))) {
      this.toasts.error(`${target.repo}: the engine is still stopping. Nothing was cleaned up.`);
      return { exit, error: 'The engine is still stopping' };
    }
    const build: BuildScope = { system: link.system, change: link.change };
    let data = EMPTY;
    try {
      data = await this.transport.sdlcLeftovers(target.path, snapshot, [], build);
    } catch (e) {
      this.toasts.error(`Could not read what the run left in ${target.repo}: ${message(e)}`);
    }
    // A build log row sits in the master's tree but belongs to the repository it records: it is listed there.
    const rows = await this.rowsOwnedBy(target.repo, link);
    const kept = uncommittedOnly(data);
    // A row that was already unsaved before the run changed before and during it; any other row, this run wrote.
    const unsaved = rows.filter((r) => !kept.touched_dirty.includes(r) && !kept.created.includes(r));
    kept.touched_dirty = [...kept.touched_dirty, ...unsaved.filter((r) => r in masterSnapshot.dirty)];
    kept.created = [...kept.created, ...unsaved.filter((r) => !(r in masterSnapshot.dirty))];
    if (hasUncommitted(kept)) this.held = [...this.held.filter((h) => h.repo !== target.repo), { repo: target.repo, path: target.path, snapshot, data: kept, build }];
    return { exit, error };
  }

  /** The unsaved build log rows a repository owns, read from the build's participants; none when they cannot be read. */
  private async rowsOwnedBy(repo: string, link: BuildLink): Promise<string[]> {
    try {
      const parts = await this.transport.sdlcBuildParticipants(link.folder, repoName(link.master), link.system, link.change, null);
      return parts.find((p) => p.repo === repo)?.rows ?? [];
    } catch (e) {
      this.toasts.error(`Could not read the build log rows of ${repo}: ${message(e)}`);
      return [];
    }
  }

  /** The build is over: show what its runs left uncommitted, wait for the engine's operator to decide, then settle the branches. */
  async finishBuild(start: BuildStart): Promise<void> {
    const held = this.held;
    this.held = [];
    if (held.length > 0) {
      this.setPending([...held.filter((h) => h.repo === start.master.repo), ...held.filter((h) => h.repo !== start.master.repo)]);
      await this.leftoversClosed();
    }
    try {
      await this.transport.sdlcBuildSettle(start);
    } catch (e) {
      this.toasts.error(`Could not settle the build's branches: ${message(e)}`);
    }
  }

  /** Discard what the operator chose in each repository, then close the dialog and keep the rest. False when any discard failed. */
  async discardAll(choices: DiscardChoice[]): Promise<boolean> {
    for (const c of choices) {
      if (c.paths.length === 0) continue;
      if (!(await this.discard(c.repo, c.paths))) return false;
    }
    this.closeLeftovers();
    return true;
  }

  /** Discard the chosen paths of one repository, against that repository's own snapshot. The dialog stays open if it fails. */
  async discard(repo: string, paths: string[]): Promise<boolean> {
    const entry = this.pending().find((p) => p.repo === repo);
    if (!entry) return false;
    try {
      await this.transport.sdlcDiscard(entry.path, entry.snapshot, paths, ...(entry.build ? [entry.build] : []));
    } catch (e) {
      this.toasts.error(`Could not discard: ${message(e)}`);
      return false;
    }
    this.setPending(this.pending().filter((p) => p.repo !== repo));
    return true;
  }

  closeLeftovers(): void {
    this.setPending([]);
  }

  private setPending(next: RepoLeftovers[]): void {
    this.pending.set(next);
    if (next.length > 0) return;
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves with the run's final snapshot. The transcript is reported the moment its id shows up, not at the end. */
  private untilEnded(id: string, onTranscript: (runId: string) => void): Promise<RunSnapshot> {
    const view = this.runs.snapshot(id);
    return new Promise((resolve) => {
      const ref = effect(
        () => {
          const snap = view();
          const transcript = transcriptRunId(snap.events);
          const ended = TERMINAL.includes(snap.state);
          untracked(() => {
            if (transcript) onTranscript(transcript);
            if (ended) {
              ref.destroy();
              resolve(snap);
            }
          });
        },
        { injector: this.injector },
      );
    });
  }

  private lastError(snap: RunSnapshot): string | null {
    for (let i = snap.events.length - 1; i >= 0; i--) {
      const ev = snap.events[i];
      if (ev.type === 'log' && ev.level === 'error') return ev.message;
    }
    return null;
  }

  /**
   * New change: branch off `change/pending-<stamp>`, run the intent skill (`full`) or the triage that decides the track (`decide`),
   * then rename or delete the branch once the run is over, whatever its outcome. `confirm` is the preview: it gets the built spec and answers with the spec to
   * run, or null when the engineer cancelled, in which case no branch is made.
   */
  async newChange(target: ChangeTarget, system: string, idea: string, track: StartTrack, confirm?: Confirm, naming?: PickedNaming): Promise<NewChangeOutcome> {
    const { workspace, master, productRepos } = target;
    if (this.isBusy()) {
      this.toasts.error('Another task is already running.');
      return { kind: 'refused' };
    }
    const decide = track === 'decide';
    const base = workspace.base_branch;
    this.picked.set(naming?.workType ?? null);
    let spec: RunSpec;
    try {
      const [settings, catalog] = await Promise.all([this.transport.sdlcSettings(), this.transport.catalog(workspace.folder)]);
      const ctx = { folder: workspace.folder, system, change: null, idea, ...(naming ? { scope: naming.scope } : {}) };
      if (decide) {
        const restricted = restrictedFor(workspace.folder, await this.transport.sdlcScan(workspace.folder), await this.transport.sdlcChecksDir());
        spec = specFor('triage', null, ctx, settings, catalog, undefined, restricted);
      } else {
        spec = specFor('intent', null, ctx, settings, catalog);
      }
    } catch (e) {
      this.toasts.error(`Could not prepare the ${decide ? 'triage' : 'intent'} run: ${message(e)}`);
      return { kind: 'stopped' };
    }
    // The preview comes before the branch: cancelling it leaves nothing behind.
    if (confirm) {
      const confirmed = await confirm(spec);
      if (!confirmed) return { kind: 'stopped' };
      spec = confirmed;
    }
    let branch: string;
    try {
      branch = await this.transport.sdlcStartChange(master, base);
    } catch (e) {
      this.toasts.error(`Could not start a change: ${message(e)}`);
      return { kind: 'stopped' };
    }
    const out = await this.run('Starting a change', spec, {
      workspaceId: workspace.id,
      master,
      productRepos,
      link: null,
      label: decide ? 'Triage' : 'Intent',
      pendingBranch: branch,
    });
    if (!out.exited) return { kind: 'stopped' };
    await this.leftoversClosed();
    const outcome = await this.finish(master, branch, base, out.snapshot, productRepos);
    if (outcome === null) return { kind: 'stopped' };
    if (outcome === 'deleted') {
      // The triage's verdict is in the run's record: the home says so, and no toast or navigation talks over it.
      if (!decide) {
        this.toasts.info('No change was created.');
        await this.router.navigate(['/sdlc']);
      }
      return { kind: 'none', idea, runId: out.runId };
    }
    const waiting = 'needs-name' in outcome;
    const change = waiting ? outcome['needs-name'].change : outcome.renamed.change;
    if (out.runId) {
      try {
        await this.transport.sdlcLinkRun({
          workspace_id: workspace.id,
          system,
          change,
          stage: decide ? 'start' : 'intent',
          run_id: out.runId,
          started_at: Math.floor(Date.now() / 1000),
        });
      } catch (e) {
        this.toasts.error(`Could not link the run to the change: ${message(e)}`);
      }
    }
    await this.router.navigate(['/sdlc', system, change]);
    if (!waiting) return { kind: 'opened', change, branch: outcome.renamed.branch };
    // The change page shows the confirmation. Closing it leaves the change on its pending branch, which the page offers it again for.
    if (naming) this.pickedFor = { change, type: naming.workType };
    const named = await this.requestName({
      folder: workspace.folder,
      masterRepo: repoName(master),
      system,
      change,
      pending: outcome['needs-name'].pending,
      workType: naming?.workType ?? null,
      track: await this.trackOf(master, system, change, decide),
    });
    return named === null ? { kind: 'stopped' } : { kind: 'opened', change: named.change, branch: named.branch };
  }

  /** The track the change ended on, for the type the confirmation preselects; the start's own track when it cannot be read. */
  private async trackOf(master: string, system: string, change: string, decide: boolean): Promise<'full' | 'fix'> {
    try {
      return (await this.transport.sdlcReadChange(master, system, change)).track;
    } catch {
      return decide ? 'fix' : 'full';
    }
  }

  /** Finish the pending branch. A dirty tree opens the leftover dialog once and retries after it closes. */
  private async finish(
    master: string,
    branch: string,
    base: string,
    snapshot: Snapshot | null,
    productRepos: string[],
  ): Promise<FinishOutcome | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transport.sdlcFinishChange(master, branch, base);
      } catch (e) {
        const dirty = message(e).includes(DIRTY);
        const data = dirty && attempt === 0 && snapshot ? await this.readLeftovers(master, snapshot, productRepos) : EMPTY;
        if (snapshot && hasLeftovers(data)) {
          this.setPending([this.entry(master, snapshot, data)]);
          await this.leftoversClosed();
          continue;
        }
        this.toasts.error(`Could not finish the change: ${message(e)}. The pending branch ${branch} was kept.`);
        return null;
      }
    }
  }

  private async reportStopped(
    label: string,
    state: RunState,
    target: RunTarget,
    snapshot: Snapshot | null,
    candidates: Map<string, Snapshot> | null,
  ): Promise<void> {
    const why = this.failureReason();
    const verb = `${state === 'warning' ? 'stopped' : 'failed'}${why ? ` · ${why}` : ''}`;
    let where: Baseline | null =
      target.master !== null && snapshot !== null ? { master: target.master, snapshot, productRepos: target.productRepos } : null;
    if (where === null && target.firstSetup && candidates) where = await this.masterAfterSetup(target.firstSetup.folder, candidates);
    if (where === null) {
      this.toasts.error(`${label} ${verb} · there was no master repo to compare against`);
      return;
    }
    const data = await this.readLeftovers(where.master, where.snapshot, where.productRepos);
    const commits = plural(data.new_commits.length, 'commit', 'commits');
    const files = plural(data.discardable.length + data.touched_dirty.length + data.created.length, 'file', 'files');
    this.toasts.error(`${label} ${verb} · ${commits} landed, ${files} left uncommitted`);
    if (hasLeftovers(data)) this.setPending([this.entry(where.master, where.snapshot, data)]);
  }

  /** Why the run ended, in its own words: claude's result, else the engine's last error log; null when neither says. */
  private failureReason(): string | null {
    const result = this.runs.summary()?.result;
    const errors = this.runs.events().flatMap((ev) => (ev.type === 'log' && ev.level === 'error' ? [ev.message] : []));
    const text = result || (errors.at(-1) ?? '');
    return text ? summarize(text) : null;
  }

  /** Snapshot every repo of a folder that has no master yet. A repo that cannot be read is skipped. */
  private async snapshotAll(setup: { folder: string; repos: string[] }): Promise<Map<string, Snapshot>> {
    const out = new Map<string, Snapshot>();
    for (const repo of setup.repos) {
      try {
        out.set(repo, await this.transport.sdlcSnapshot(masterPath(setup.folder, repo)));
      } catch {
        // Not a readable repo: it cannot become the master's baseline, and setup still runs.
      }
    }
    return out;
  }

  /** After a first setup stopped: the master it created, compared against that repo's pre-run snapshot. */
  private async masterAfterSetup(folder: string, candidates: Map<string, Snapshot>): Promise<Baseline | null> {
    try {
      const scan = await this.transport.sdlcScan(folder);
      const repo = masterRepo(scan);
      const snapshot = repo === null ? undefined : candidates.get(repo);
      if (repo === null || snapshot === undefined) return null;
      return { master: masterPath(folder, repo), snapshot, productRepos: productReposOf(scan) };
    } catch {
      return null;
    }
  }

  /** Wait for the engine process to exit. A failed wait counts as "still running": better to touch nothing. */
  private async engineExited(id?: string): Promise<boolean> {
    const runId = id ?? this.runs.lastRunId();
    // No id means the engine was never spawned, so there is no process to wait for.
    if (runId === null) return true;
    try {
      return await this.transport.sdlcWaitRunExit(runId, EXIT_WAIT_MS);
    } catch {
      return false;
    }
  }

  private async readLeftovers(master: string, snapshot: Snapshot, productRepos: string[]): Promise<Leftovers> {
    try {
      return await this.transport.sdlcLeftovers(master, snapshot, siblingsOf(master, productRepos));
    } catch (e) {
      this.toasts.error(`Could not read what the run left behind: ${message(e)}`);
      return EMPTY;
    }
  }

  private leftoversClosed(): Promise<void> {
    if (this.pending().length === 0) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  private entry(master: string, snapshot: Snapshot, data: Leftovers): RepoLeftovers {
    return { repo: repoName(master), path: master, snapshot, data };
  }

  private linkOnce(runId: string | null): void {
    const link = this.linkTarget;
    if (!link || !runId) return;
    this.linkTarget = null;
    this.transport.sdlcLinkRun({ ...link, run_id: runId }).catch((e: unknown) => {
      this.toasts.error(`Could not link the run to the change: ${message(e)}`);
    });
  }
}
