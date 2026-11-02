import type { WorkType } from '../../lib/sdlc-naming';
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import type { BuildScope } from '@bindings/BuildScope';
import type { Leftovers } from '@bindings/Leftovers';
import type { RecordedPullRequest } from '@bindings/RecordedPullRequest';
import type { RunSpec } from '@bindings/RunSpec';
import type { Snapshot } from '@bindings/Snapshot';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { RunState } from '../../lib/events';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { ChangeStart } from '@bindings/ChangeStart';
import { documentForm, type DocumentKind } from '../../lib/build-host';
import { IDLE, type RunSnapshot } from '../run/reduce';
import { ChangeRunStore, changeRunKey } from '../run/change-run.store';
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
};

/** `exited` is false when the engine was still alive after the wait: nothing was read or cleaned up then. */
export type RunOutcome = { state: RunState; runId: string | null; snapshot: Snapshot | null; exited: boolean };

/** What the screen needs to place a new change: the workspace, its master repo path and the product repos. */
/** The preview before a run: takes the built spec, answers with the spec to run or null when the engineer cancelled. */
export type Confirm = (spec: RunSpec) => Promise<RunSpec | null>;

/**
 * What starting a change came to. `opened` names the change and the branch the plugin gave it (null when a triage's own skill started it).
 * `retry`: the plugin refused the branch name or the scope and the engineer is asked again, with the plugin's reasons as they are.
 * `none`: a triage ended and no change was started (the idea and the run's id let the engineer describe it again or read the verdict).
 * `stopped`: nothing to report, because no run started or the run's engine was still stopping; a toast already said why where one was due.
 */
export type NewChangeOutcome =
  | { kind: 'opened'; change: string; branch: string | null }
  | { kind: 'retry'; ask: 'branch' | 'scope'; problems: string[] }
  | { kind: 'refused' }
  | { kind: 'stopped' }
  | { kind: 'none'; idea: string; runId: string | null };

/** The branch name dialog of one change: what it shows and the engineer may edit. */
export type NameRequest = {
  system: string;
  change: string;
  /** The branch the change has now, which the name starts from. */
  current: string;
  suggestion: string;
  /** Why the last attempt was refused; null otherwise. */
  error: string | null;
  busy: boolean;
  /** The dialog renames a branch that already has a name. */
  rename: true;
};

/** What renaming a change's branch needs: the branch it has now is the starting name. */
export type RenameAsk = { folder: string; workspaceId: string; system: string; change: string; current: string };

/** What a rename came to: the new branch and the pull requests opened from the old name, which the engineer closes by hand. */
export type Renamed = { branch: string; change: string; from: string; oldPullRequests: RecordedPullRequest[] };

/** What the engineer picked when the system has a naming setting. */
export type PickedNaming = { workType: WorkType; scope: string };

export type ChangeTarget = { workspace: WorkspaceEntry; master: string; productRepos: string[] };

/** The master repo a stopped run is compared against, with its pre-run snapshot. */
type Baseline = { master: string; snapshot: Snapshot; productRepos: string[] };
type PendingLink = { workspace_id: string; system: string; change: string; stage: string; started_at: number };

/** One repository's uncommitted edits left by a run, with the snapshot that run started from. */
/** What one repository's run left behind. `build` is set when the run belonged to a build: only that change's build log rows are build log data. */
export type RepoLeftovers = { repo: string; path: string; snapshot: Snapshot; data: Leftovers; build?: BuildScope };
/** The change a document run belongs to, when the change exists: the backend then composes the run-spec and claims the change's lane. */
export type ChangeLaunch = { ref: ChangeRef; kind: DocumentKind };
export type DiscardChoice = { repo: string; paths: string[] };

const RESULT_MAX = 120;
/** The time limit of a document run whose confirmed spec set none: the six hours the run-specs of AI-SDLC runs carry. */
/** How long to wait for the engine process to exit before touching the repo. */
const EXIT_WAIT_MS = 15000;
const TERMINAL: readonly RunState[] = ['success', 'warning', 'error'];
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };

const repoName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** Product repos are named by folder; they sit next to the master repo in the workspace folder. */
const siblingsOf = (master: string, repos: string[]): string[] => {
  const root = master.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  return repos.map((r) => masterPath(root, r));
};
const STILL_STOPPING = 'The engine is still stopping. Nothing was cleaned up.';

function summarize(result: string | null | undefined): string {
  const flat = (result ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return 'done';
  return flat.length > RESULT_MAX ? `${flat.slice(0, RESULT_MAX - 1)}…` : flat;
}

const hasLeftovers = (l: Leftovers): boolean =>
  [l.new_commits, l.discardable, l.touched_dirty, l.created, l.product_repos_changed, l.product_repos_unchecked].some((xs) => xs.length > 0);

/** Commits are what a build is for, so only uncommitted edits count as left behind. */

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
  private readonly changeRuns = inject(ChangeRunStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  private readonly injector = inject(Injector);
  private readonly pending = signal<RepoLeftovers[]>([]);
  private closeWaiters: (() => void)[] = [];
  /** The link of the solo run in flight; a change run keeps its own, so runs of different changes link apart. */
  private linkTarget: { link: PendingLink | null } | null = null;

  /** What the last non-successful run left behind; the screen's leftover dialog renders it. */
  readonly leftovers = computed<RepoLeftovers[] | null>(() => (this.pending().length === 0 ? null : this.pending()));

  private readonly afterRun = signal(0);
  /** A run has ended but its after-run work (engine exit, report) is still going: the session view cannot close yet. */
  readonly settling = computed(() => this.afterRun() > 0);
  private readonly request = signal<NameRequest | null>(null);
  /** The branch name confirmation on show; null when none is open. */
  readonly nameRequest = this.request.asReadonly();
  private readonly namedCount = signal(0);
  /** Counts the branches named so far; a page showing the change reads it again when this moves. */
  readonly named = this.namedCount.asReadonly();
  private renameAsk: RenameAsk | null = null;
  private settleName: ((named: Renamed | null) => void) | null = null;

  /**
   * Ask the engineer for a new name for the branch `ask.current`, in every repository that has it. No type is picked and the
   * current name is the starting point. Resolves with the new branch, or null when the dialog was closed.
   */
  async requestRename(ask: RenameAsk): Promise<Renamed | null> {
    this.closeName();
    this.renameAsk = ask;
    this.request.set({
      system: ask.system,
      change: ask.change,
      current: ask.current,
      suggestion: ask.current,
      error: null,
      busy: false,
      rename: true,
    });
    return new Promise((resolve) => {
      this.settleName = resolve;
    });
  }

  /** Rename the change's branch to `name`. A refusal stays on the request and the dialog stays open. */
  async confirmName(name: string): Promise<void> {
    const cur = this.request();
    if (cur === null || cur.busy || this.renameAsk === null) return;
    return this.confirmRename(this.renameAsk, name);
  }

  /** Rename the change's branch everywhere. A refusal stays on the request and the confirmation stays open. */
  private async confirmRename(ask: RenameAsk, name: string): Promise<void> {
    this.request.update((r) => (r === null ? r : { ...r, error: null, busy: true }));
    try {
      const done = await this.transport.sdlcRenameBranch(ask.folder, ask.workspaceId, ask.system, ask.change, name);
      if (done.outcome === 'refused') {
        // The plugin renamed nothing; its reasons are shown as it printed them.
        const reasons = done.problems.join('\n');
        this.request.update((r) => (r === null ? r : { ...r, error: reasons, busy: false }));
        return;
      }
      this.finishName({ branch: done.to, change: ask.change, from: done.from, oldPullRequests: done.oldPullRequests });
      this.namedCount.update((n) => n + 1);
    } catch (e) {
      this.request.update((r) => (r === null ? r : { ...r, error: message(e), busy: false }));
    }
  }

  /** Close the dialog without renaming anything. */
  closeName(): void {
    this.finishName(null);
  }

  private finishName(named: Renamed | null): void {
    const settle = this.settleName;
    this.settleName = null;
    this.renameAsk = null;
    this.request.set(null);
    settle?.(named);
  }

  constructor() {
    // Link the transcript the moment its id shows up, not at the end: a run that never ends still gets linked.
    effect(() => {
      const id = transcriptRunId(this.runs.events());
      untracked(() => this.linkOnce(this.linkTarget, id));
    });
  }

  /** A document run of a change that exists: the backend composes the run-spec (the deny rules, the change's own lane); only what the engineer confirmed in the preview travels. */
  private launchChangeRun(change: ChangeLaunch, spec: RunSpec): Promise<string> {
    return this.transport.sdlcRunChange(change.ref, change.kind, documentForm(spec));
  }

  private isBusy(): boolean {
    const busy = this.runs.state();
    return this.lock.active() !== null || busy === 'running' || busy === 'awaiting';
  }

  async run(title: string, spec: RunSpec, target: RunTarget, change?: ChangeLaunch): Promise<RunOutcome> {
    // A change's document run has a session of its own: only that change's own live run refuses it, and the backend refuses what needs a folder another run holds.
    const key = change ? changeRunKey(change.ref) : null;
    if (key === null ? this.isBusy() : this.changeRuns.has(key)) {
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
    const holder = {
      link: target.link ? { workspace_id: target.workspaceId, ...target.link, started_at: Math.floor(Date.now() / 1000) } : (null as PendingLink | null),
    };
    // Settling from before the run ends, so the finished view never shows an enabled Close ahead of the work below.
    this.afterRun.update((n) => n + 1);
    // The run being watched: the solo run, or the backend's id of the change's run once it has launched.
    let backendId: string | null = null;
    let watch = null as { destroy(): void } | null;
    const view = (): RunSnapshot =>
      change
        ? backendId === null
          ? IDLE
          : this.runs.snapshot(backendId)()
        : { ...IDLE, events: this.runs.events(), summary: this.runs.summary() };
    let state: RunState;
    try {
      if (change && key !== null) {
        const via = async (confirmed: RunSpec): Promise<string> => {
          const id = await this.launchChangeRun(change, confirmed);
          backendId = id;
          // Link the transcript the moment its id shows up, not at the end: a run that never ends still gets linked.
          watch = effect(() => {
            const transcript = transcriptRunId(this.runs.snapshot(id)().events);
            untracked(() => this.linkOnce(holder, transcript));
          }, { injector: this.injector });
          return id;
        };
        state = await this.lock.runAgent(title, spec, via, key);
      } else {
        this.linkTarget = holder;
        state = await this.lock.runAgent(title, spec);
      }
    } catch (e) {
      this.afterRun.update((n) => n - 1);
      watch?.destroy();
      throw e;
    }
    const transcript = transcriptRunId(view().events);
    this.linkOnce(holder, transcript);
    watch?.destroy();
    if (this.linkTarget === holder) this.linkTarget = null;
    // The session view stays up after the run: the after-run work below happens under it, and the caller
    // (finish a branch, navigate) carries on only once the operator has closed it.
    try {
      // The terminal event reaches the UI before the engine process is gone; a cancelled engine may still be
      // writing. Nothing reads or changes the repo until it has exited.
      if (!(await this.engineExited(change ? (backendId ?? undefined) : undefined, change !== undefined))) {
        this.toasts.error(STILL_STOPPING);
        return { state, runId: transcript, snapshot, exited: false };
      }
      const label = target.label ?? title;
      if (state === 'success') {
        this.toasts.success(`${label} finished · ${summarize(view().summary?.result)}`);
      } else {
        await this.reportStopped(label, state, target, snapshot, candidates, view());
      }
      return { state, runId: transcript, snapshot, exited: true };
    } finally {
      this.afterRun.update((n) => n - 1);
      await this.lock.dismissed(key ?? undefined);
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
   * New change. `full`: the plugin starts the change (its branch and its own copy), then the intent skill runs inside the copy. `decide`: the
   * triage runs, and when its skill starts a change (the light track's fix, through the plugin) that change is opened. `confirm` is the
   * preview: it gets the built spec and answers with the spec to run, or null when the engineer cancelled, in which case nothing is made.
   * `branch` is the name the engineer gave after the plugin refused the first one.
   */
  async newChange(
    target: ChangeTarget,
    system: string,
    idea: string,
    track: StartTrack,
    confirm?: Confirm,
    naming?: PickedNaming,
    branch?: string,
  ): Promise<NewChangeOutcome> {
    const { workspace, master, productRepos } = target;
    if (this.isBusy()) {
      this.toasts.error('Another task is already running.');
      return { kind: 'refused' };
    }
    const decide = track === 'decide';
    let spec: RunSpec;
    let previewed: string | null = null;
    try {
      const [settings, catalog] = await Promise.all([this.transport.sdlcSettings(), this.transport.catalog(workspace.folder)]);
      const ctx = { folder: workspace.folder, system, change: null, idea, ...(naming ? { scope: naming.scope } : {}) };
      if (decide) {
        const restricted = restrictedFor(workspace.folder, await this.transport.sdlcScan(workspace.folder), await this.transport.sdlcChecksDir());
        spec = specFor('triage', null, ctx, settings, catalog, restricted);
      } else {
        previewed = await this.transport.sdlcChangeName(idea);
        spec = specFor('intent', null, { ...ctx, change: previewed }, settings, catalog);
      }
    } catch (e) {
      this.toasts.error(`Could not prepare the ${decide ? 'triage' : 'intent'} run: ${message(e)}`);
      return { kind: 'stopped' };
    }
    // The preview comes before anything is made: cancelling it leaves nothing behind.
    if (confirm) {
      const confirmed = await confirm(spec);
      if (!confirmed) return { kind: 'stopped' };
      spec = confirmed;
    }
    return decide
      ? this.triage(workspace, master, productRepos, system, idea, spec)
      : this.startAndRun(workspace, master, productRepos, system, idea, spec, previewed, naming, branch);
  }

  /** Full track: ask the plugin to start the change, then run the intent skill in it. */
  private async startAndRun(
    workspace: WorkspaceEntry,
    master: string,
    productRepos: string[],
    system: string,
    idea: string,
    confirmed: RunSpec,
    previewed: string | null,
    naming: PickedNaming | undefined,
    branch: string | undefined,
  ): Promise<NewChangeOutcome> {
    let started: ChangeStart;
    try {
      started = await this.transport.sdlcStartChange(workspace.folder, system, idea, naming?.workType ?? 'feat', naming?.scope ?? '', ...(branch ? [branch] : []));
    } catch (e) {
      this.toasts.error(`Could not start a change: ${message(e)}`);
      return { kind: 'stopped' };
    }
    if (started.outcome === 'refused') {
      // The plugin's words, as they are: the dialog shows them when the engineer can answer, a toast otherwise.
      if (started.kind === 'branchTaken' || started.kind === 'branchInvalid') return { kind: 'retry', ask: 'branch', problems: started.problems };
      if (started.kind === 'scope') return { kind: 'retry', ask: 'scope', problems: started.problems };
      this.toasts.error(started.problems.join('\n'));
      return { kind: 'stopped' };
    }
    const { change } = started;
    // The name was settled before the preview; a start across midnight can differ, and the run must be about the change that exists.
    const rename = (text: string): string => (previewed !== null && previewed !== change ? text.split(previewed).join(change) : text);
    const spec: RunSpec = { ...confirmed, name: rename(confirmed.name), task: rename(confirmed.task) };
    const out = await this.run(
      'Starting a change',
      spec,
      { workspaceId: workspace.id, master, productRepos, link: null, label: 'Intent' },
      { ref: { workspace: workspace.folder, system, change }, kind: 'intent' },
    );
    if (!out.exited) return { kind: 'stopped' };
    await this.leftoversClosed();
    await this.linkAndOpen(workspace, system, change, 'intent', out.runId);
    return { kind: 'opened', change, branch: started.branch };
  }

  /** Light-track start: the triage runs; a change its skill started through the plugin is opened, and none is a verdict for the home to show. */
  private async triage(
    workspace: WorkspaceEntry,
    master: string,
    productRepos: string[],
    system: string,
    idea: string,
    spec: RunSpec,
  ): Promise<NewChangeOutcome> {
    const listed = async (): Promise<string[] | null> => {
      try {
        return (await this.transport.sdlcState(workspace.folder, system)).changes.map((c) => c.state.change);
      } catch (e) {
        this.toasts.error(`Could not read the changes of ${system}: ${message(e)}`);
        return null;
      }
    };
    const before = await listed();
    if (before === null) return { kind: 'stopped' };
    const out = await this.run('Starting a change', spec, { workspaceId: workspace.id, master, productRepos, link: null, label: 'Triage' });
    if (!out.exited) return { kind: 'stopped' };
    await this.leftoversClosed();
    const after = await listed();
    if (after === null) return { kind: 'stopped' };
    const change = after.find((c) => !before.includes(c));
    // The triage's verdict is in the run's record: the home says so, and no toast or navigation talks over it.
    if (change === undefined) return { kind: 'none', idea, runId: out.runId };
    await this.linkAndOpen(workspace, system, change, 'start', out.runId);
    return { kind: 'opened', change, branch: null };
  }

  /** Link the run that made a change to it, then open the change. */
  private async linkAndOpen(workspace: WorkspaceEntry, system: string, change: string, stage: string, runId: string | null): Promise<void> {
    if (runId) {
      try {
        await this.transport.sdlcLinkRun({ workspace_id: workspace.id, system, change, stage, run_id: runId, started_at: Math.floor(Date.now() / 1000) });
      } catch (e) {
        this.toasts.error(`Could not link the run to the change: ${message(e)}`);
      }
    }
    await this.router.navigate(['/sdlc', system, change]);
  }

  private async reportStopped(
    label: string,
    state: RunState,
    target: RunTarget,
    snapshot: Snapshot | null,
    candidates: Map<string, Snapshot> | null,
    ended: RunSnapshot,
  ): Promise<void> {
    const why = this.failureReason(ended);
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
  private failureReason(ended: RunSnapshot): string | null {
    const result = ended.summary?.result;
    const errors = ended.events.flatMap((ev) => (ev.type === 'log' && ev.level === 'error' ? [ev.message] : []));
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
  private async engineExited(id?: string, own = false): Promise<boolean> {
    const runId = own ? (id ?? null) : (this.runs.lastRunId());
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

  private linkOnce(holder: { link: PendingLink | null } | null, runId: string | null): void {
    const link = holder?.link;
    if (!holder || !link || !runId) return;
    holder.link = null;
    this.transport.sdlcLinkRun({ ...link, run_id: runId }).catch((e: unknown) => {
      this.toasts.error(`Could not link the run to the change: ${message(e)}`);
    });
  }
}
