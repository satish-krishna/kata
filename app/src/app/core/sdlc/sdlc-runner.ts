import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Leftovers } from '@bindings/Leftovers';
import type { RunSpec } from '@bindings/RunSpec';
import type { Snapshot } from '@bindings/Snapshot';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { RunState } from '../../lib/events';
import { specFor, transcriptRunId } from '../../lib/sdlc';
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
};

export type RunOutcome = { state: RunState; runId: string | null; snapshot: Snapshot | null };

/** What the screen needs to place a new change: the workspace, its master repo path and the product repos. */
export type ChangeTarget = { workspace: WorkspaceEntry; master: string; productRepos: string[] };

type PendingLeftovers = { master: string; snapshot: Snapshot; data: Leftovers };
type PendingLink = { workspace_id: string; system: string; change: string; stage: string; started_at: number };

const RESULT_MAX = 120;
const DIRTY = 'uncommitted changes';
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], product_repos_changed: [] };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function summarize(result: string | null | undefined): string {
  const flat = (result ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return 'done';
  return flat.length > RESULT_MAX ? `${flat.slice(0, RESULT_MAX - 1)}…` : flat;
}

const hasLeftovers = (l: Leftovers): boolean =>
  l.new_commits.length + l.discardable.length + l.touched_dirty.length + l.product_repos_changed.length > 0;

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

  private readonly pending = signal<PendingLeftovers | null>(null);
  private closeWaiters: (() => void)[] = [];
  private linkTarget: PendingLink | null = null;

  /** What the last non-successful run left behind; the screen's leftover dialog renders it. */
  readonly leftovers = computed(() => this.pending()?.data ?? null);

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
      return { state: 'error', runId: null, snapshot: null };
    }
    let snapshot: Snapshot | null = null;
    if (target.master !== null) {
      try {
        snapshot = await this.transport.sdlcSnapshot(target.master);
      } catch (e) {
        this.toasts.error(`Could not read the master repo before the run: ${message(e)}`);
        return { state: 'error', runId: null, snapshot: null };
      }
    }
    this.linkTarget = target.link
      ? { workspace_id: target.workspaceId, ...target.link, started_at: Math.floor(Date.now() / 1000) }
      : null;
    const state = await this.lock.runAgent(title, spec);
    const runId = transcriptRunId(this.runs.events());
    this.linkOnce(runId);
    this.linkTarget = null;
    const label = target.label ?? title;
    if (state === 'success') {
      this.toasts.success(`${label} finished · ${summarize(this.runs.summary()?.result)}`);
    } else {
      await this.reportStopped(label, state, target, snapshot);
    }
    return { state, runId, snapshot };
  }

  /** Discard the chosen leftover paths. The dialog stays open if the discard fails. */
  async discard(paths: string[]): Promise<void> {
    const p = this.pending();
    if (!p) return;
    try {
      await this.transport.sdlcDiscard(p.master, p.snapshot, paths);
    } catch (e) {
      this.toasts.error(`Could not discard: ${message(e)}`);
      return;
    }
    this.closeLeftovers();
  }

  closeLeftovers(): void {
    this.pending.set(null);
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * New change: branch off `change/pending-<stamp>`, run the intent skill, then rename or delete the branch
   * once the run is over, whatever its outcome.
   */
  async newChange(target: ChangeTarget, system: string, idea: string): Promise<void> {
    const { workspace, master, productRepos } = target;
    if (this.isBusy()) {
      this.toasts.error('Another task is already running.');
      return;
    }
    const base = workspace.base_branch;
    let spec: RunSpec;
    try {
      const [settings, catalog] = await Promise.all([this.transport.sdlcSettings(), this.transport.catalog(workspace.folder)]);
      spec = specFor('intent', null, { folder: workspace.folder, system, change: null, idea }, settings, catalog);
    } catch (e) {
      this.toasts.error(`Could not prepare the intent run: ${message(e)}`);
      return;
    }
    let branch: string;
    try {
      branch = await this.transport.sdlcStartChange(master, base);
    } catch (e) {
      this.toasts.error(`Could not start a change: ${message(e)}`);
      return;
    }
    const out = await this.run('Starting a change', spec, {
      workspaceId: workspace.id,
      master,
      productRepos,
      link: null,
      label: 'Intent',
    });
    await this.leftoversClosed();
    const outcome = await this.finish(master, branch, base, out.snapshot, productRepos);
    if (outcome === null) return;
    if (outcome === 'deleted') {
      this.toasts.info('No change was created.');
      await this.router.navigate(['/sdlc']);
      return;
    }
    const { change } = outcome.renamed;
    if (out.runId) {
      try {
        await this.transport.sdlcLinkRun({
          workspace_id: workspace.id,
          system,
          change,
          stage: 'intent',
          run_id: out.runId,
          started_at: Math.floor(Date.now() / 1000),
        });
      } catch (e) {
        this.toasts.error(`Could not link the run to the change: ${message(e)}`);
      }
    }
    await this.router.navigate(['/sdlc', system, change]);
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
          this.pending.set({ master, snapshot, data });
          await this.leftoversClosed();
          continue;
        }
        this.toasts.error(`Could not finish the change: ${message(e)}. The pending branch ${branch} was kept.`);
        return null;
      }
    }
  }

  private async reportStopped(label: string, state: RunState, target: RunTarget, snapshot: Snapshot | null): Promise<void> {
    const verb = state === 'warning' ? 'stopped' : 'failed';
    if (target.master === null || snapshot === null) {
      this.toasts.error(`${label} ${verb} · there was no master repo to compare against`);
      return;
    }
    const data = await this.readLeftovers(target.master, snapshot, target.productRepos);
    const commits = plural(data.new_commits.length, 'commit', 'commits');
    const files = plural(data.discardable.length + data.touched_dirty.length, 'file', 'files');
    this.toasts.error(`${label} ${verb} · ${commits} landed, ${files} left uncommitted`);
    if (hasLeftovers(data)) this.pending.set({ master: target.master, snapshot, data });
  }

  private async readLeftovers(master: string, snapshot: Snapshot, productRepos: string[]): Promise<Leftovers> {
    try {
      return await this.transport.sdlcLeftovers(master, snapshot, productRepos);
    } catch (e) {
      this.toasts.error(`Could not read what the run left behind: ${message(e)}`);
      return EMPTY;
    }
  }

  private leftoversClosed(): Promise<void> {
    if (this.pending() === null) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
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
