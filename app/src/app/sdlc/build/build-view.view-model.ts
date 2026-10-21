import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { Participant } from '@bindings/Participant';
import type { RunSpec } from '@bindings/RunSpec';
import { LockStore } from '../../core/lock/lock.store';
import { ModeStore } from '../../core/mode/mode.store';
import { RunStore } from '../../core/run/run.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import type { AskRecord, PermissionRecord, RunState, RunSummary, StreamEvent } from '../../lib/events';
import { reviewFindings, specFor, transcriptRunId, type BuildRun, type Finding } from '../../lib/sdlc';
import type { ReplacedFindings } from '../../ui/findings-list';
import type { RepoRow } from '../../ui/repo-status-list';
import type { WaitingItem } from '../../ui/waiting-notice';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildDriver, NotCheckedOut, type BuildPhase, type RunEnd, type RunOptions, type RunTarget } from './build-driver';

/** What the build runs against: the workspace, the system and the change. */
export type BuildContext = {
  workspaceId: string;
  folder: string;
  system: string;
  change: string;
  /** Every product repository the system names, whether or not the plan does: the agents are denied edits in all of them (R18.5). */
  systemRepos: string[];
};

/** One run of the selected repository, as the observe pane shows it. */
export type ShownRun = {
  id: string;
  startedAt: string;
  spec: RunSpec;
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
  /** The index of the first event the engineer has not seen since they came back to this run, or null. */
  unseenFrom: number | null;
};

/** The two views of a running build: what the agents say and do, and what they changed. */
export type BuildTab = 'activity' | 'changes';

/** What the Changes view looks at. */
export type BuildChanges = { folder: string; masterRepo: string; system: string; change: string };

export const CHANGES_BANNER = "The build is running. Uncommitted edits are the agents' work in progress and are marked with a dot.";

/** A run the build started: which row it belongs to, its spec, and when it started. */
type Entry = { id: string; key: string; spec: RunSpec; at: number };
/** Seconds of a run's work (waiting for the engineer excluded), of all its waiting, and of the wait it is in now. */
type Clock = { work: number; paused: number; current: number };
/** A review of the whole change, read from its run's closing text. */
type Review = { at: number; findings: Finding[] };

const REVIEW = 'review';
const RUNNING: readonly RunState[] = ['running', 'awaiting'];

const pad = (n: number) => String(n).padStart(2, '0');
/** The wall-clock time of a start, as the divider names it. */
const timeOf = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const hms = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const ms = (secs: number): string => `${Math.floor(Math.max(0, secs) / 60)}:${pad(Math.floor(Math.max(0, secs)) % 60)}`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The build view's state: the driver that starts a run per ready repository and one review, the build's hold on the lock,
 * each repository's row and clocks, the runs of the repository on show, and the review's findings.
 * Rows are read through the transport's `sdlcBuildStatus`; nothing here reads a plan or a build log.
 */
@Injectable()
export class BuildViewModel {
  private readonly transport = inject(KataTransport);
  private readonly runner = inject(SdlcRunner);
  private readonly lock = inject(LockStore);
  private readonly runs = inject(RunStore);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);

  private handoff: BuildHandoff | null = null;
  /** The runs the engineer's leftovers confirmation still covers; a run's launch spends its entry. */
  private confirmed = new Set<string>();
  private ctx: BuildContext | null = null;
  /** Who takes part in the build and where each is checked out, as the backend last answered. */
  private participants: Participant[] = [];
  private productRepos: string[] = [];
  /** True once the build's branches were settled; continuing then prepares them again. */
  private settled = false;
  private lastTick = 0;
  private pendingFinish: Promise<void> | null = null;
  private readonly readRuns = new Set<string>();

  private readonly driver = new BuildDriver({
    status: () => this.readStatus(),
    start: (target, opts) => this.startRun(target, opts),
    heads: () => this.readHeads(),
  });
  private readonly status = signal<BuildStatus | null>(null);
  private readonly log = signal<Entry[]>([]);
  private readonly clocks = signal<Readonly<Record<string, Clock>>>({});
  private readonly reviews = signal<Review[]>([]);
  private readonly picked = signal<string | null>(null);
  private readonly broken = signal(false);
  private readonly finishing = signal(false);
  private readonly reading = signal(false);
  private readonly changes = signal<BuildChanges | null>(null);
  /** How many events of each run the engineer had seen when its Activity was last on show, by run id. */
  private readonly seen = signal<Readonly<Record<string, number>>>({});
  /** Where the events the engineer missed begin in each run of the pane they just came back to, by run id. */
  private readonly marks = signal<Readonly<Record<string, number>>>({});
  private lastOnShow: string | null = null;
  private announced = new Set<string>();
  private focusCount = 0;

  /** The row Continue is waiting to confirm, and the lines the confirm lists. */
  private asking: string | null = null;
  private readonly pendingLeftovers = signal<string[] | null>(null);
  /** The confirm for continuing on top of the stopped repository's leftovers: one line per repository and file; null while closed. */
  readonly leftoverPrompt = computed(() => {
    const lines = this.pendingLeftovers();
    return lines === null ? null : { lines };
  });

  readonly tab = signal<BuildTab>('activity');
  readonly announcement = signal('');
  /** A request to bring a repository's open question into view and focus it; the view carries it out. */
  readonly focusRequest = signal<{ repo: string; n: number } | null>(null);
  readonly changesBanner = CHANGES_BANNER;

  readonly phase = computed<BuildPhase>(() => (this.broken() ? 'stopped' : this.driver.phase()));
  readonly active = computed(() => this.phase() === 'building' || this.phase() === 'reviewing');
  readonly report = this.driver.report;
  /** Close waits while the build's branches are being settled and while the leftover dialog is open. */
  readonly closeBlocked = computed(() => this.finishing() || this.runner.leftovers() !== null);

  readonly tasksLabel = computed(() => {
    const tasks = this.status()?.tasks ?? [];
    return `${tasks.filter((t) => t.row !== null).length}/${tasks.length} tasks`;
  });

  readonly rows = computed<RepoRow[]>(() => {
    const status = this.status();
    if (status === null) return [];
    const rows = status.repos.map((r) => this.repoRow(r.repo, status));
    const master = this.masterName();
    const masterRow = master !== null && !status.repos.some((r) => r.repo === master) ? this.masterRow(master) : null;
    if (masterRow !== null) rows.push(masterRow);
    rows.push(this.reviewRow());
    return rows;
  });

  /** The row on show: the one picked, else the first. */
  readonly selected = computed(() => {
    // Read from the status, not from the rows: a row says how much is unseen in a repository, which depends on the one on show.
    const status = this.status();
    return this.picked() ?? (status === null ? null : (status.repos[0]?.repo ?? REVIEW));
  });

  /** Every run of the build, grouped by the repository (or the review) it belongs to. All stay mounted; only the selected group shows. */
  readonly groups = computed<{ key: string; runs: ShownRun[] }[]>(() => {
    const marks = this.marks();
    const out = new Map<string, ShownRun[]>();
    for (const e of this.log()) {
      const snap = this.runs.snapshot(e.id)();
      const run: ShownRun = {
        id: e.id,
        startedAt: timeOf(e.at),
        spec: e.spec,
        state: snap.state,
        events: snap.events,
        summary: snap.summary,
        asks: snap.asks,
        permissions: snap.permissions,
        unseenFrom: marks[e.id] ?? null,
      };
      out.set(e.key, [...(out.get(e.key) ?? []), run]);
    }
    return [...out].map(([key, runs]) => ({ key, runs }));
  });

  /** The runs of the selected repository. */
  readonly shown = computed<ShownRun[]>(() => {
    const key = this.selected();
    return this.groups().find((g) => g.key === key)?.runs ?? [];
  });

  /** What the Changes view reads, once the build has started. */
  readonly changesContext = this.changes.asReadonly();
  /** Turns taken by every run of the build, so the Changes view reads again as the agents work. */
  readonly turns = computed(() => this.log().reduce((n, e) => n + this.runs.snapshot(e.id)().events.filter((ev) => ev.type === 'turn').length, 0));
  /** Events that arrived in the views not on show: for the Activity tab, only while Changes is open. */
  readonly activityNew = computed(() => (this.tab() === 'changes' ? this.log().reduce((n, e) => n + this.unseenOfRun(e), 0) : 0));
  /** The runs waiting on the engineer, whichever view is on show. */
  readonly waitingNotices = computed<WaitingItem[]>(() => {
    const out: WaitingItem[] = [];
    for (const w of this.lock.waiting()) {
      const repo = this.log().find((e) => e.id === w.runId)?.key;
      if (repo === undefined) continue;
      const left = this.lock.deadlineSecs(w.runId);
      out.push({ repo, kind: w.kind, countdown: left === null ? null : ms(left) });
    }
    return out;
  });
  /** On Activity, the runs waiting in a repository other than the one on show. */
  readonly otherWaiting = computed(() => (this.tab() === 'activity' ? this.waitingNotices().filter((w) => w.repo !== this.selected()) : []));

  /** What the selected row offers: Cancel while its run goes, Continue once it stopped. */
  readonly action = computed<'cancel' | 'continue' | null>(() => {
    const key = this.selected();
    if (key === null) return null;
    if (this.driver.stopped().has(key)) return 'continue';
    const live = key === REVIEW ? this.phase() === 'reviewing' : this.driver.going().has(key);
    return live ? 'cancel' : null;
  });

  /** The findings are on show once the build has finished and its review has been read. */
  readonly reviewShown = computed(() => this.phase() === 'finished' && !this.reading() && this.reviews().length > 0);
  /** The latest review's findings, most serious first. */
  readonly findings = computed<Finding[]>(() => this.reviews().at(-1)?.findings ?? []);
  /** Earlier reviews, each with the time of the review that replaced it, newest first. */
  readonly replaced = computed<ReplacedFindings[]>(() => {
    const all = this.reviews();
    return all
      .slice(0, -1)
      .map((r, i) => ({ at: timeOf(all[i + 1].at), findings: r.findings }))
      .reverse();
  });

  constructor() {
    // The rows follow the build log: read it again whenever a run starts or ends.
    effect(() => {
      this.driver.going();
      this.phase();
      untracked(() => void this.refresh());
    });
    // A run's work clock stops while it waits on the engineer; the wait has its own clock.
    effect(() => {
      const t = this.lock.elapsedSecs();
      const waiting = new Set(this.lock.waiting().map((w) => w.runId));
      untracked(() => this.tick(t, waiting));
    });
    // What the engineer has seen: a pane on show is seen as it grows; coming back to one marks where the missed events begin.
    effect(() => {
      const key = this.onShow();
      const counts = this.log().map((e) => ({ e, count: this.runs.snapshot(e.id)().events.length }));
      untracked(() => this.markSeen(key, counts));
    });
    // A run that starts waiting on the engineer is announced once; an announcement never moves the focus.
    effect(() => {
      const waiting = this.waitingNotices();
      untracked(() => this.announce(waiting));
    });
    // The build is over, or stopped: free the lock, show what the runs left, settle the branches, read the review.
    effect(() => {
      const phase = this.phase();
      if (phase === 'building' || phase === 'reviewing') return;
      untracked(() => {
        this.pendingFinish = this.finish(phase);
      });
    });
  }

  /** Take the lock and run the build, once. False when another task holds the lock: nothing starts then. */
  async start(handoff: BuildHandoff, ctx: BuildContext): Promise<boolean> {
    if (this.handoff !== null) return true;
    if (!this.lock.beginBuild('Build')) return false;
    this.handoff = handoff;
    this.confirmed = new Set(handoff.continueOnLeftovers ?? []);
    this.ctx = ctx;
    try {
      const status = await this.readStatus();
      const master = handoff.start.master.repo;
      this.productRepos = (await this.readParticipants(handoff.round?.repo ?? null)).filter((p) => !p.master).map((p) => p.repo);
      this.status.set(status);
      this.changes.set({ folder: ctx.folder, masterRepo: master, system: ctx.system, change: ctx.change });
      if (handoff.round !== null) await this.loadEarlierReview(ctx);
      await this.driver.begin(handoff.timeoutSecs, handoff.round ?? undefined);
    } catch (e) {
      this.toasts.error(`Could not start the build: ${message(e)}`);
      this.broken.set(true);
    }
    return true;
  }

  select(name: string): void {
    this.picked.set(name);
  }

  /** Show one of the views. This changes what is on show and nothing else: no run, read or lock is touched. */
  showTab(tab: string): void {
    if (tab === 'activity' || tab === 'changes') this.tab.set(tab);
  }

  /** Go to a waiting repository: its Activity, with its open question brought into view and focused. */
  goTo(repo: string): void {
    this.picked.set(repo);
    this.tab.set('activity');
    this.focusRequest.set({ repo, n: ++this.focusCount });
  }

  cancelBuild(): void {
    this.driver.cancelAll();
  }

  cancelRun(): void {
    const key = this.selected();
    if (key !== null) this.driver.cancel(key);
  }

  /**
   * Run the selected, stopped row again, after the engineer confirms continuing on top of whatever it left (R6.4).
   * What it left is what the build's participants say its repository owns: its own uncommitted files and the unsaved
   * rows of its build log, in the master or not. After the branches were settled they are prepared again, which reports
   * the same leftovers; while other repositories still run nothing is prepared and the participants are read directly (R6.7).
   */
  async continueRun(): Promise<void> {
    const key = this.selected();
    const h = this.handoff;
    const ctx = this.ctx;
    if (key === null || h === null || ctx === null) return;
    await this.pendingFinish;
    const owner = this.ownerOf(key);
    try {
      if (this.settled) {
        const out = await this.transport.sdlcBuildPrepare(ctx.folder, h.start.master.repo, ctx.system, ctx.change, false, owner);
        if (out.kind === 'needsConfirm') {
          this.ask(key, out.leftovers.flatMap((r) => r.files.map((f) => `${r.repo}: ${f}`)));
          return;
        }
        this.handoff = { ...h, start: out.start };
        this.settled = false;
      } else {
        const mine = (await this.readParticipants(owner)).find((p) => p.repo === owner);
        const left = [...(mine?.files ?? []), ...(mine?.rows ?? [])];
        if (left.length > 0) {
          this.ask(key, left.map((f) => `${owner}: ${f}`));
          return;
        }
      }
    } catch (e) {
      this.toasts.error(`Could not prepare the branches to continue the build: ${message(e)}`);
      return;
    }
    await this.resume(key);
  }

  /** The engineer confirmed continuing on top of the leftovers: the run starts without discarding them. */
  async confirmContinue(): Promise<void> {
    const key = this.asking;
    const h = this.handoff;
    const ctx = this.ctx;
    this.asking = null;
    this.pendingLeftovers.set(null);
    if (key === null || h === null || ctx === null) return;
    if (this.settled) {
      try {
        const out = await this.transport.sdlcBuildPrepare(ctx.folder, h.start.master.repo, ctx.system, ctx.change, true, this.ownerOf(key));
        if (out.kind !== 'ready') {
          this.toasts.error('Could not prepare the branches to continue the build.');
          return;
        }
        this.handoff = { ...h, start: out.start };
        this.settled = false;
      } catch (e) {
        this.toasts.error(`Could not prepare the branches to continue the build: ${message(e)}`);
        return;
      }
    }
    this.confirmed.add(key);
    await this.resume(key);
  }

  cancelContinue(): void {
    this.asking = null;
    this.pendingLeftovers.set(null);
  }

  /** The repository a row of the build is about: the review runs in the master. */
  private ownerOf(key: string): string {
    return key === REVIEW ? this.handoff!.start.master.repo : key;
  }

  /** Ask the backend who takes part in the build now; `pending` is the repository a run is about to start in. */
  private async readParticipants(pending: string | null): Promise<Participant[]> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    this.participants = await this.transport.sdlcBuildParticipants(ctx.folder, h.start.master.repo, ctx.system, ctx.change, pending);
    return this.participants;
  }

  /** Where a repository of the build is checked out. */
  private pathOf(repo: string): string | undefined {
    return this.participants.find((p) => p.repo === repo)?.path;
  }

  private ask(key: string, lines: string[]): void {
    this.asking = key;
    this.pendingLeftovers.set(lines);
  }

  private async resume(key: string): Promise<void> {
    this.broken.set(false);
    this.lock.resumeBuild();
    await this.driver.continueRepo(key);
  }

  answer(runId: string, e: { id: string; answers: string[][] }): void {
    this.lock.answer(runId, e.id, e.answers);
  }

  decide(runId: string, e: { id: string; allow: boolean; message: string | null }): void {
    this.lock.decide(runId, e.id, e.allow, e.message);
  }

  /** Release the lock; true when it was released, false while the end of the build is still being settled. */
  async close(): Promise<boolean> {
    await this.pendingFinish;
    if (this.closeBlocked()) return false;
    this.lock.close();
    return true;
  }

  // --- what the engineer has seen

  /** The repository whose Activity is on show, if Activity is. */
  private readonly onShow = computed(() => (this.tab() === 'activity' ? this.selected() : null));

  private unseenOfRun(e: Entry): number {
    if (e.key === this.onShow()) return 0;
    return Math.max(0, this.runs.snapshot(e.id)().events.length - (this.seen()[e.id] ?? 0));
  }

  private unseenOf(key: string): number {
    return this.log().filter((e) => e.key === key).reduce((n, e) => n + this.unseenOfRun(e), 0);
  }

  private markSeen(key: string | null, counts: { e: Entry; count: number }[]): void {
    const known = this.seen();
    const next: Record<string, number> = { ...known };
    if (key !== this.lastOnShow) {
      let marks: Record<string, number> = {};
      if (key !== null) for (const { e, count } of counts) if (e.key === key && count > (known[e.id] ?? 0)) marks = { ...marks, [e.id]: known[e.id] ?? 0 };
      this.marks.set(marks);
      this.lastOnShow = key;
    }
    if (key !== null) for (const { e, count } of counts) if (e.key === key) next[e.id] = count;
    if (Object.keys(next).some((id) => next[id] !== known[id])) this.seen.set(next);
  }

  /** Say once, and out loud, that a run started waiting on the engineer. Nothing here moves the tab, the repository or the focus. */
  private announce(waiting: WaitingItem[]): void {
    const now = new Set(waiting.map((w) => w.repo + ':' + w.kind));
    const fresh = waiting.filter((w) => !this.announced.has(w.repo + ':' + w.kind));
    this.announced = now;
    if (now.size === 0) {
      this.announcement.set('');
      return;
    }
    if (fresh.length > 0) {
      this.announcement.set(fresh.map((w) => 'The agent in ' + w.repo + ' is waiting for your ' + (w.kind === 'answer' ? 'answer' : 'approval') + '.').join(' '));
    }
  }

  // --- rows

  private repoRow(name: string, status: BuildStatus): RepoRow {
    const repo = status.repos.find((r) => r.repo === name)!;
    const entry = this.latest(name);
    const clock = entry ? this.clockOf(entry) : null;
    const paused = entry && this.isWaiting(entry.id) ? this.pausedOf(entry.id) : null;
    const unseen = this.unseenOf(name);
    const row = (tone: RepoRow['tone'], label: string): RepoRow => ({ name, tone, label, clock, paused, unseen });
    const stop = this.driver.stopped().get(name);
    if (stop) return row('error', stop.reason);
    if (this.driver.going().has(name)) {
      if (paused !== null) return row('warning', 'Waiting for you');
      return row('success', repo.firstUnfinished ? `Working · ${repo.firstUnfinished}` : 'Working');
    }
    switch (repo.state.kind) {
      case 'waiting':
        return row('idle', `Waiting for ${repo.state.onTask} in ${repo.state.onRepo}`);
      case 'done':
        return row('success', `Finished · ${repo.finished}/${repo.tasks}`);
      default:
        return row('idle', 'Not started');
    }
  }

  private masterName(): string | null {
    return this.handoff?.start.master.repo ?? null;
  }

  /** The master repository's row, once it has a round pending, running, stopped or done; null when it has nothing to show. */
  private masterRow(name: string): RepoRow | null {
    const entry = this.latest(name);
    const stop = this.driver.stopped().get(name);
    const going = this.driver.going().has(name);
    const pending = this.driver.round()?.repo === name;
    if (!stop && !going && !pending && entry === null) return null;
    const clock = entry ? this.clockOf(entry) : null;
    const paused = entry && going && this.isWaiting(entry.id) ? this.pausedOf(entry.id) : null;
    const row = (tone: RepoRow['tone'], label: string): RepoRow => ({ name, tone, label, clock, paused, unseen: this.unseenOf(name) });
    if (stop) return row('error', stop.reason);
    if (going) return paused !== null ? row('warning', 'Waiting for you') : row('success', 'Working');
    return pending ? row('idle', 'Not started') : row('success', 'Finished');
  }

  private reviewRow(): RepoRow {
    const entry = this.latest(REVIEW);
    const clock = entry ? this.clockOf(entry) : null;
    const paused = entry && this.phase() === 'reviewing' && this.isWaiting(entry.id) ? this.pausedOf(entry.id) : null;
    const unseen = this.unseenOf(REVIEW);
    const row = (tone: RepoRow['tone'], label: string): RepoRow => ({ name: REVIEW, tone, label, clock, paused, unseen });
    const stop = this.driver.stopped().get(REVIEW);
    if (stop) return row('error', stop.reason);
    if (this.phase() === 'reviewing') return paused !== null ? row('warning', 'Waiting for you') : row('success', 'Working');
    return this.phase() === 'finished' ? row('success', 'Finished') : row('idle', 'Not started');
  }

  private latest(key: string): Entry | null {
    const entries = this.log().filter((e) => e.key === key);
    return entries.at(-1) ?? null;
  }

  private isWaiting(runId: string): boolean {
    return this.lock.waiting().some((w) => w.runId === runId);
  }

  private clockOf(e: Entry): string {
    const limit = this.handoff?.timeoutSecs ?? 0;
    return `work ${hms(this.clocks()[e.id]?.work ?? 0)} of ${hms(limit)}`;
  }

  private pausedOf(runId: string): string {
    return `${ms(this.clocks()[runId]?.current ?? 0)} waiting (not counted)`;
  }

  private tick(t: number, waiting: ReadonlySet<string>): void {
    const dt = t - this.lastTick;
    this.lastTick = t;
    if (dt <= 0) return;
    const next: Record<string, Clock> = { ...this.clocks() };
    for (const e of this.log()) {
      if (!RUNNING.includes(this.runs.snapshot(e.id)().state)) continue;
      const c = next[e.id] ?? { work: 0, paused: 0, current: 0 };
      next[e.id] = waiting.has(e.id)
        ? { work: c.work, paused: c.paused + dt, current: c.current + dt }
        : { work: c.work + dt, paused: c.paused, current: 0 };
    }
    this.clocks.set(next);
  }

  // --- the driver's dependencies

  private async readStatus(): Promise<BuildStatus> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    return this.transport.sdlcBuildStatus(h.start.master.path, ctx.system, ctx.change);
  }

  private readHeads(): Promise<Record<string, string>> {
    const ctx = this.ctx!;
    // The master is a build participant: a round there that commits makes the review stale like any product repository's.
    return this.transport.sdlcBuildHeads(ctx.folder, [this.handoff!.start.master.repo, ...this.productRepos], ctx.change);
  }

  private async refresh(): Promise<void> {
    if (this.handoff === null) return;
    try {
      this.status.set(await this.readStatus());
    } catch (e) {
      this.toasts.error(`Could not read the build log: ${message(e)}`);
    }
  }

  private async startRun(target: RunTarget, opts: RunOptions): Promise<RunEnd> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    const review = target === 'review';
    const repo = review ? h.start.master.repo : target.repo;
    const path = review ? h.start.master.path : this.pathOf(repo);
    // The backend names where each participant is checked out; a repository it does not name has no folder to run in.
    if (path === undefined) throw new NotCheckedOut(repo);
    const run: BuildRun = {
      target,
      timeoutSecs: opts.timeoutSecs,
      instructions: opts.instructions ?? null,
      workspaceFolder: ctx.folder,
      masterRepo: h.start.master.repo,
      systemRepos: [...new Set([...ctx.systemRepos, ...this.productRepos])],
      checksDir: h.checksDir,
      continueOnLeftovers: this.confirmed.delete(review ? REVIEW : repo),
    };
    const settings = this.modes.settings() ?? (await this.modes.load());
    const spec = specFor('build', null, { folder: ctx.folder, system: ctx.system, change: ctx.change }, settings, [], run);
    const key = review ? REVIEW : repo;
    const end = await this.runner.runInRepo(
      { repo, path, kind: review ? 'review' : 'repo' },
      spec,
      {
        workspaceId: ctx.workspaceId,
        system: ctx.system,
        change: ctx.change,
        folder: ctx.folder,
        master: h.start.master.path,
        repos: this.productRepos,
        onRun: (id) => this.noteRun(id, key, spec, opts.signal),
      },
    );
    // A cancel settles the run's state before the engine reports an exit code: it is the engineer's cancel (130).
    return opts.signal.aborted && end.exit !== 0 ? { exit: 130, error: null } : end;
  }

  private noteRun(id: string, key: string, spec: RunSpec, signal: AbortSignal): void {
    this.log.update((l) => [...l, { id, key, spec, at: Date.now() }]);
    this.clocks.update((c) => ({ ...c, [id]: { work: 0, paused: 0, current: 0 } }));
    const stop = () => void this.runs.cancelRun(id);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }

  // --- the end of a build

  private async finish(phase: BuildPhase): Promise<void> {
    const h = this.handoff;
    if (h === null) return;
    this.lock.endBuild();
    if (phase === 'finished') void this.readReview();
    this.finishing.set(true);
    try {
      await this.runner.finishBuild(h.start);
      this.settled = true;
    } finally {
      this.finishing.set(false);
    }
  }

  /** The review run the build just finished: its findings come from the closing text of its transcript. */
  private async readReview(): Promise<void> {
    const entry = this.latest(REVIEW);
    if (entry === null || this.readRuns.has(entry.id)) return;
    this.readRuns.add(entry.id);
    this.reading.set(true);
    try {
      await this.readReviewOf(entry);
    } finally {
      this.reading.set(false);
    }
  }

  private async readReviewOf(entry: Entry): Promise<void> {
    const stem = transcriptRunId(this.runs.snapshot(entry.id)().events);
    if (stem === null) {
      this.toasts.error('Could not find the review run\'s transcript, so its findings cannot be shown.');
      return;
    }
    try {
      const findings = reviewFindings(await this.transport.loadRun(stem));
      this.reviews.update((r) => [...r, { at: entry.at, findings }]);
    } catch (e) {
      this.toasts.error(`Could not read the review's findings: ${message(e)}`);
    }
  }

  /** A round starts from a finished review: the latest one linked to this change becomes the one the new review replaces. */
  private async loadEarlierReview(ctx: BuildContext): Promise<void> {
    try {
      const links = (await this.transport.sdlcRunLinks()).filter(
        (l) => l.workspace_id === ctx.workspaceId && l.system === ctx.system && l.change === ctx.change && l.stage === REVIEW,
      );
      const last = links.reduce<(typeof links)[number] | null>((a, l) => (a === null || l.started_at > a.started_at ? l : a), null);
      if (last === null) return;
      const findings = reviewFindings(await this.transport.loadRun(last.run_id));
      this.reviews.set([{ at: last.started_at * 1000, findings }]);
    } catch {
      // The earlier review's transcript may be gone; the new review is then simply the only one.
    }
  }
}
