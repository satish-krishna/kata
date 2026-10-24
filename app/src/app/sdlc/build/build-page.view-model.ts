import { DestroyRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import type { BuildRow } from '@bindings/BuildRow';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { Problem } from '@bindings/Problem';
import type { Readiness } from '@bindings/Readiness';
import type { Snapshot } from '@bindings/Snapshot';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { Participant } from '@bindings/Participant';
import type { RunSpec } from '@bindings/RunSpec';
import { GivenStore, type BuildChoices } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { ModeStore } from '../../core/mode/mode.store';
import { IDLE, reduce, type RunSnapshot } from '../../core/run/reduce';
import { RunStore } from '../../core/run/run.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { type AskRecord, type RunGiven, type PermissionRecord, type RunState, type RunSummary, type StreamEvent } from '../../lib/events';
import { newlyRecorded, outcomeOf, recordOutcome, repoSessions, sessionsFor, type Pick, type SessionRef } from '../../lib/build-sessions';
import { buildActions, buildStage, repoAction, shownAreas, taskGroups, type BuildStage } from '../../lib/build-stage';
import { fallbackTaskState, hms, ms, situationView, taskState, type SituationView, type Situation, type TaskState } from '../../lib/build-state';
import { shownPart, type DocNotice } from '../../lib/doc-notice';
import { shownReview, type ReviewShown } from '../../lib/sdlc-review';
import { reviewState } from '../../lib/sdlc-done';
import { givenFor, reviewFindings, specFor, type BuildRun, type Finding, type StageAction } from '../../lib/sdlc';
import type { ReplacedFindings } from '../../ui/findings-list';
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
  given: RunGiven | null;
  /** The index of the first event the engineer has not seen since they came back to this run, or null. */
  unseenFrom: number | null;
  /** True for the newest run of its repository, which always shows in full. */
  latest: boolean;
  /** True when the engineer opened this earlier run; an earlier run shows as one line otherwise. */
  expanded: boolean;
  /** How the run went, for its one line: the status, then exit, turns and cost once it completed. */
  outcome: string;
};

/** One session of a repository (or the review): a run live on this page, or an earlier one read from the records. */
export type ShownSession = Omit<ShownRun, 'spec'> & {
  spec: RunSpec | null;
  /** True for a run of this page's driver; false for an earlier run read from the records. */
  live: boolean;
  /** Why an earlier run shows nothing, or null. */
  note: string | null;
  /** False for a live run kept mounted while another pick is on show; absent or true means on show. */
  shown?: boolean;
};

/** What the tasks area says about the review. */
export type ReviewEntry = 'not run' | 'running' | 'finished' | 'stale';

export type StageMessage = { title: string; lines: string[] };

/** What the page is given on every load of the change. */
export type BuildPageInput = {
  ctx: BuildContext;
  master: { repo: string; path: string };
  change: ChangeInfo;
  status: BuildStatus | null;
  done: boolean;
  review: ReviewRecord | null;
};

/** One repository of the tasks area: where it stands, what it offers, and its tasks. */
export type TaskArea = {
  repo: string;
  /** Where the repository stands; null when its facts were impossible and the heading is a fallback. */
  situation: Situation | null;
  heading: SituationView;
  action: 'cancel' | 'continue' | null;
  tasks: { id: string; name: string; state: TaskState }[];
};

/** A status as the page shows it: an andon tone, drawn as a dot, and its label. */
export type StatusText = { tone: 'success' | 'warning' | 'error' | 'idle'; label: string };

/** One task of the tasks area. */
export type TaskRowView = { id: string; name: string; status: StatusText; departure: string | null; picked: boolean };

/** One repository of the tasks area: its heading (name, situation, the button it offers) and its tasks. */
export type TaskGroupView = {
  repo: string;
  status: StatusText;
  /** The work clock against the limit, the wait in progress (not counted), the events not yet seen and the stop line, from `situationView`. */
  clock: string | null;
  paused: string | null;
  unseen: number;
  stopLine: string | null;
  action: 'cancel' | 'continue' | null;
  picked: boolean;
  tasks: TaskRowView[];
};

/** The review's entry under the tasks. */
export type ReviewEntryView = { status: StatusText; action: 'cancel' | 'continue' | null; picked: boolean };

/** The review's findings, with the notice above them. */
export type FindingsView = { notice: DocNotice | null; findings: Finding[]; replaced: ReplacedFindings[]; older: boolean; emptyText: string };

/** Everything the build page shows, computed once so the page itself only draws it. */
export type BuildPageView = {
  stage: BuildStage;
  stageMessage: StageMessage | null;
  /** The build's facts for the bar: `<done>/<total> tasks`, and the elapsed time while the build runs. */
  facts: { tasks: string; elapsed: string | null };
  actions: StageAction[];
  groups: TaskGroupView[];
  review: ReviewEntryView;
  pick: Pick | null;
  sessions: ShownSession[];
  sessionNote: string | null;
  /** Each repository that stopped and why, for the activity area. */
  stops: { repo: string; reason: string }[];
  /** The findings once the review finished; null while it has none to show. */
  findings: FindingsView | null;
  waiting: WaitingItem[];
  announcement: string;
  /** Which of the optional areas have something to show; the tasks area always does. */
  areas: { activity: boolean; files: boolean };
  /** True below 1024 CSS pixels, where the three areas become one column behind a switch. */
  narrow: boolean;
};

/** The two views of a running build: what the agents say and do, and what they changed. */
export type BuildTab = 'activity' | 'changes';

/** What the Changes view looks at. */
export type BuildChanges = { folder: string; masterRepo: string; system: string; change: string };

/** A run the build started: which row it belongs to, its spec, and when it started. */
type Entry = { id: string; key: string; spec: RunSpec; at: number };
/** Seconds of a run's work (waiting for the engineer excluded), of all its waiting, and of the wait it is in now. */
type Clock = { work: number; paused: number; current: number };
/** A review of the whole change: one section of its review document, or the closing text of its run. */
type Review = { at: number | null; label: string | null; findings: Finding[] };

const REVIEW = 'review';
const RUNNING: readonly RunState[] = ['running', 'awaiting'];
/** Below this width the build page's three areas share one column. */
const PAGE_NARROW = '(max-width: 1023.98px)';

/** A task's state as its row says it. */
const taskStatus = (t: TaskState): StatusText => {
  switch (t.kind) {
    case 'done':
      return { tone: 'success', label: 'Done' };
    case 'running':
      return { tone: 'success', label: 'Running' };
    case 'waiting':
      return { tone: 'idle', label: `Waiting for ${t.onTask} in ${t.onRepo}` };
    case 'stopped':
      return { tone: 'error', label: 'Stopped here' };
    case 'not-started':
      return { tone: 'idle', label: 'Not started' };
  }
};

const reviewStatus = (e: ReviewEntry): StatusText =>
  e === 'running' ? { tone: 'success', label: 'Running' } : e === 'finished' ? { tone: 'success', label: 'Finished' } : e === 'stale' ? { tone: 'warning', label: 'Out of date' } : { tone: 'idle', label: 'Not run' };

const pad = (n: number) => String(n).padStart(2, '0');
/** The wall-clock time of a start, as the divider names it. */
const timeOf = (at: number): string => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The build page's state, which lives as long as the change page that provides it: the driver that starts a run per ready
 * repository and one review, the build's hold on the lock, each repository's row and clocks, the runs of the repository on show,
 * and the review's findings. The page holds the lock from `start` (or a per-repository Continue) until the build is settled.
 * Rows are read through the transport's `sdlcBuildStatus`; nothing here reads a plan or a build log.
 */
@Injectable()
export class BuildPageViewModel {
  private readonly transport = inject(KataTransport);
  private readonly runner = inject(SdlcRunner);
  private readonly lock = inject(LockStore);
  private readonly runs = inject(RunStore);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  /** The preview Continue opens; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);

  private readonly injector = inject(Injector);
  private readonly handed = signal<BuildHandoff | null>(null);
  private get handoff(): BuildHandoff | null {
    return this.handed();
  }
  private set handoff(value: BuildHandoff | null) {
    this.handed.set(value);
  }
  /** What the build was started from, null until it was started once. */
  readonly current = this.handed.asReadonly();
  /** True once a build was started on this page; it stays true after the build ended. */
  readonly started = computed(() => this.handed() !== null);
  /** True while this page holds the lock for its build, from `start` (or a Continue) until `release` gives it back. */
  private holding = false;
  /** The runs the engineer's leftovers confirmation still covers; a run's launch spends its entry. */
  private confirmed = new Set<string>();
  private readonly ctxSig = signal<BuildContext | null>(null);
  private get ctx(): BuildContext | null {
    return this.ctxSig();
  }
  private set ctx(value: BuildContext | null) {
    this.ctxSig.set(value);
  }
  /** What the change page last gave `load`; null until it did. */
  private readonly loaded = signal<BuildPageInput | null>(null);
  /** The review document as last read, null when the change has none. */
  private readonly reviewDoc = signal<ReviewRecord | null>(null);
  private readonly runLinks = signal<RunLink[]>([]);
  private readonly taskLinks = signal<TaskLink[]>([]);
  private readonly records = signal<RunRecord[]>([]);
  /** Where each repository of the change stands now, for judging whether the review is stale. */
  private readonly heads = signal<Record<string, string>>({});
  /** The final state of each earlier run whose transcript was read, by run id; 'unreadable' when it could not be. */
  private readonly details = signal<Readonly<Record<string, RunSnapshot | 'unreadable'>>>({});
  private readonly readingDetail = new Set<string>();
  /** Who takes part in the build and where each is checked out, as the backend last answered. */
  private participants: Participant[] = [];
  private productRepos: string[] = [];
  /** True once the build's branches were settled; continuing then prepares them again. */
  private settled = false;
  private lastTick = 0;
  private pendingFinish: Promise<void> | null = null;
  private readonly readRuns = new Set<string>();

  /** The driver of the latest start; every start makes a fresh one, as each opening of the build did. */
  private readonly drv = signal(this.newDriver());
  private get driver(): BuildDriver {
    return this.drv();
  }
  /** The final state of each run the lock forgot when the page was released, by run id: the runs stay on show after that. */
  private readonly frozen = signal<Readonly<Record<string, RunSnapshot>>>({});
  private readonly status = signal<BuildStatus | null>(null);
  /** Whether any repository the page lists has changed files, as the Changes view lists them. */
  private readonly changedFiles = signal(false);
  private readonly log = signal<Entry[]>([]);
  private readonly clocks = signal<Readonly<Record<string, Clock>>>({});
  private readonly reviews = signal<Review[]>([]);
  /** True when the findings come from a review run's closing words because the change has no review document. */
  private readonly fromWords = signal(false);
  /** The review run ended without adding a review to the review document, so there is no new review to show. */
  private readonly unrecorded = signal(false);
  /** What the one owner of the notice table says about the review document; null when it needs none. */
  private readonly reviewDocNotice = signal<DocNotice | null>(null);
  /** How many reviews the review document held when the review run started; the run is judged by what it added. */
  private sectionsBefore = 0;
  /** Where the master repository stood when the review run started; null when it could not be read. */
  private masterBefore: string | null = null;
  /** The master's uncommitted files (path to content hash) when the review run started; the run is judged by what changed beyond them. */
  private dirtyBefore: Snapshot['dirty'] = {};
  /** The warning naming the other files a review run changed in the master; null when it kept to the review document. */
  private readonly runNotice = signal<DocNotice | null>(null);
  private readonly chosen = signal<Pick | null>(null);
  /** The earlier runs the engineer opened in full, by run id. */
  private readonly openedRuns = signal<ReadonlySet<string>>(new Set());
  private readonly broken = signal(false);
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

  /** Why Continue did not go on, with what the check found; the refusal dialog is open exactly while this is set. */
  readonly refusal = signal<{ reason: string; problems: Problem[] } | null>(null);

  /** True below the width where the build page's three areas become one column behind a switch. */
  private readonly pageNarrow = signal(false);

  readonly tab = signal<BuildTab>('activity');
  readonly announcement = signal('');
  /** A request to bring a repository's open question into view and focus it; the view carries it out. */
  readonly focusRequest = signal<{ repo: string; n: number } | null>(null);

  readonly phase = computed<BuildPhase>(() => (this.broken() ? 'stopped' : this.driver.phase()));
  readonly active = computed(() => this.phase() === 'building' || this.phase() === 'reviewing');
  readonly report = computed(() => this.driver.report());

  readonly tasksLabel = computed(() => {
    const tasks = this.status()?.tasks ?? [];
    return `${tasks.filter((t) => t.row !== null).length}/${tasks.length} tasks`;
  });

  /** What the engineer picked, else the first repository, or the review once the build is reviewed. Null before the status is read. */
  readonly pick = computed<Pick | null>(() => {
    const chosen = this.chosen();
    if (chosen !== null) return chosen;
    const status = this.status();
    if (status === null) return null;
    const stage = this.stage();
    if (stage === 'review-finished' || stage === 'done') return { kind: 'review' };
    const first = this.groupKeys()[0];
    return first === undefined ? { kind: 'review' } : { kind: 'repo', repo: first };
  });

  /** The row on show: the repository (or the review) the pick belongs to. */
  readonly selected = computed(() => {
    // Read from the status, not from the rows: a row says how much is unseen in a repository, which depends on the one on show.
    const pick = this.pick();
    if (pick === null) return null;
    if (pick.kind === 'review') return REVIEW;
    if (pick.kind === 'repo') return pick.repo;
    return this.status()?.tasks.find((t) => t.id === pick.task)?.repo ?? null;
  });

  /** Every run of the build, grouped by the repository (or the review) it belongs to. All stay mounted; only the selected group shows. */
  readonly groups = computed<{ key: string; runs: ShownRun[] }[]>(() => {
    const marks = this.marks();
    const opened = this.openedRuns();
    const out = new Map<string, ShownRun[]>();
    for (const e of this.log()) {
      const snap = this.snapOf(e.id);
      const run: ShownRun = {
        id: e.id,
        startedAt: timeOf(e.at),
        spec: e.spec,
        state: snap.state,
        events: snap.events,
        summary: snap.summary,
        asks: snap.asks,
        permissions: snap.permissions,
        given: snap.given,
        unseenFrom: marks[e.id] ?? null,
        latest: false,
        expanded: opened.has(e.id),
        outcome: outcomeOf(snap.state, snap.summary),
      };
      out.set(e.key, [...(out.get(e.key) ?? []), run]);
    }
    return [...out].map(([key, runs]) => ({ key, runs: runs.map((r, i) => (i === runs.length - 1 ? { ...r, latest: true } : r)) }));
  });

  /** What the Changes view reads, once the build has started. */
  readonly changesContext = this.changes.asReadonly();
  /** Turns taken by every run of the build, so the Changes view reads again as the agents work. */
  readonly turns = computed(() => this.log().reduce((n, e) => n + this.snapOf(e.id).events.filter((ev) => ev.type === 'turn').length, 0));
  /** Bash calls finished by every run of the build; each one may have committed a build log row. */
  private readonly bashDone = computed(() =>
    this.log().reduce((n, e) => n + this.snapOf(e.id).events.filter((ev) => ev.type === 'tool.result' && ev.name === 'Bash').length, 0),
  );
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

  /** The build log's rows, which say which task made which commit. */
  readonly buildRows = computed<BuildRow[]>(() => (this.status()?.tasks ?? []).flatMap((t) => (t.row === null ? [] : [t.row])));
  /** The task the engineer picked, with its repository; null when the pick is a repository or the review. */
  readonly pickedTask = computed<{ id: string; repo: string } | null>(() => {
    const pick = this.pick();
    if (pick === null || pick.kind !== 'task') return null;
    const repo = this.status()?.tasks.find((t) => t.id === pick.task)?.repo;
    return repo === undefined ? null : { id: pick.task, repo };
  });
  /** The repositories whose run stopped, whose uncommitted files were left by it. */
  readonly stoppedRepos = computed<string[]>(() => this.taskAreas().flatMap((g) => (g.situation?.kind === 'stopped' ? [g.repo] : [])));

  /** The notice above the findings: the review document's problems or its older layout; null when it needs none. */
  readonly reviewNotice = computed(() => this.runNotice() ?? this.reviewDocNotice());
  /** The latest review's findings, most serious first. */
  readonly findings = computed<Finding[]>(() => this.reviews().at(-1)?.findings ?? []);
  /** Earlier reviews, each with the time of the review that replaced it (or its own number and date, from the document), newest first. */
  readonly replaced = computed<ReplacedFindings[]>(() => {
    const all = this.reviews();
    return all
      .slice(0, -1)
      .map((r, i) => ({ at: all[i + 1].at === null ? '' : timeOf(all[i + 1].at!), findings: r.findings, ...(r.label === null ? {} : { label: r.label }) }))
      .reverse();
  });
  /** True when the findings are read from the review run's words, the layout before the review document. */
  readonly older = computed(() => this.fromWords() && this.reviews().length > 0);
  /** What the findings list says when the latest review found nothing. */
  readonly emptyText = computed(() => (this.unrecorded() ? 'The review did not record its findings' : this.older() ? 'The review found nothing.' : 'Reviewed, nothing found.'));

  constructor() {
    const pageQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(PAGE_NARROW) : null;
    if (pageQuery !== null) {
      this.pageNarrow.set(pageQuery.matches);
      const onPage = (e: MediaQueryListEvent) => this.pageNarrow.set(e.matches);
      pageQuery.addEventListener('change', onPage);
      inject(DestroyRef).onDestroy(() => pageQuery.removeEventListener('change', onPage));
    }
    // The rows follow the build log: read it again whenever a run starts or ends, and whenever a run finishes a Bash call,
    // since an agent logs each task by committing it.
    effect(() => {
      this.driver.going();
      this.phase();
      this.bashDone();
      untracked(() => void this.refresh());
    });
    // The sessions follow the runs: read them again whenever a run starts or ends.
    effect(() => {
      this.log();
      this.driver.going();
      untracked(() => void this.readSessions());
    });
    // An earlier session's transcript is read when it is first shown open.
    effect(() => {
      const open = this.shownSessions().filter((s) => !s.live && (s.latest || s.expanded));
      untracked(() => open.forEach((s) => void this.readDetail(s.id)));
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
      const counts = this.log().map((e) => ({ e, count: this.snapOf(e.id).events.length }));
      untracked(() => this.markSeen(key, counts));
    });
    // A run that starts waiting on the engineer is announced once; an announcement never moves the focus.
    effect(() => {
      const waiting = this.waitingNotices();
      untracked(() => this.announce(waiting));
    });
    // The build is over, or stopped: show what the runs left, settle the branches, read the review, then give the page back.
    effect(() => {
      const phase = this.phase();
      if (phase === 'building' || phase === 'reviewing') return;
      untracked(() => {
        this.pendingFinish = this.release(phase);
      });
    });
  }

  /**
   * Take the lock and run the build with a fresh driver, keeping the log of the runs before it. May be called again once the
   * build ended (Continue build, Another round, Run review). False when another task holds the lock or a build is still going:
   * nothing starts then.
   */
  async start(handoff: BuildHandoff, ctx: BuildContext): Promise<boolean> {
    if (this.started() && this.active()) {
      this.toasts.error('Another task is already running.');
      return false;
    }
    if (!this.lock.beginBuild('Build')) return false;
    this.holding = true;
    this.handoff = handoff;
    this.confirmed = new Set(handoff.continueOnLeftovers ?? []);
    this.ctx = ctx;
    this.settled = false;
    this.broken.set(false);
    this.drv.set(this.newDriver());
    try {
      const status = await this.readStatus();
      const master = handoff.start.master.repo;
      this.productRepos = (await this.readParticipants(handoff.round?.repo ?? null)).filter((p) => !p.master).map((p) => p.repo);
      this.status.set(status);
      this.changes.set({ folder: ctx.folder, masterRepo: master, system: ctx.system, change: ctx.change });
      if (handoff.round !== null) await this.loadEarlierReview(ctx);
      await this.driver.begin(handoff.timeoutSecs, handoff.round ?? undefined, handoff.choices);
    } catch (e) {
      this.toasts.error(`Could not start the build: ${message(e)}`);
      this.broken.set(true);
    }
    return true;
  }

  /**
   * Everything the page shows about a change, given on every load of the change: a page opened on a change with nothing
   * running shows the same sessions, tasks and findings as one that just ran.
   */
  async load(input: BuildPageInput): Promise<void> {
    this.loaded.set(input);
    this.ctx = input.ctx;
    this.status.set(input.status);
    this.reviewDoc.set(input.review);
    await Promise.all([this.readSessions(), this.readChanges()]);
    if (this.latest(REVIEW) !== null) return;
    // No review run in this session: the findings come from the review document, or from the latest review run's words.
    await this.noteReviewNotice(input.review);
    if (input.review !== null) this.showReviews(shownReview(input.review, null), null);
    else await this.reviewFromWords(input.ctx);
  }

  /** Show a repository, a task or the review. */
  choose(pick: Pick): void {
    this.chosen.set(pick);
  }

  /** The repositories of the tasks area, in order: the plan's, then the master once it has tasks or runs. */
  private readonly groupKeys = computed<string[]>(() => {
    const status = this.status();
    const master = this.masterRef()?.repo ?? null;
    if (status === null) return [];
    return taskGroups(status, master ?? '', master !== null && this.sessionRefs().has(master));
  });

  /** The change's stage as the change page last read it; a page that was never loaded counts as ready to build. */
  private readonly changeStage = computed<'build-ready' | 'build-stopped' | 'build-finished'>(() => {
    const stage = this.loaded()?.change.stage;
    return stage === 'build-stopped' || stage === 'build-finished' ? stage : 'build-ready';
  });

  /** Which stage the build page is at. */
  readonly stage = computed<BuildStage>(() => {
    const done = (this.loaded()?.done ?? false) && this.changeStage() === 'build-finished';
    const phase = done || !this.started() ? 'none' : this.phase();
    return buildStage({ done, phase, anyStopped: this.driver.stopped().size > 0, stage: this.changeStage() });
  });

  /** The actions the page offers at its stage. */
  readonly actions = computed<StageAction[]>(() => buildActions(this.stage()));

  /** What the page says about its stage; null at a stage that says nothing. */
  readonly stageMessage = computed<StageMessage | null>(() => {
    switch (this.stage()) {
      case 'stopped': {
        const lines: string[] = [];
        const report = this.report();
        if (report !== null) {
          for (const u of report.unfinished) lines.push(`${u.repo} has unfinished tasks: ${u.tasks.join(', ')}`);
          for (const w of report.waiting) lines.push(`${w.repo} is waiting for ${w.onTask} in ${w.onRepo}`);
        }
        return { title: 'The build stopped. Nothing more can run.', lines };
      }
      case 'cancelled':
        return { title: 'The build was cancelled.', lines: [] };
      case 'review-finished':
      case 'done':
        return { title: 'Every task is in the build log.', lines: [] };
      default:
        return null;
    }
  });

  /** The sessions of every repository (and the review), oldest first: the runs of this page and the change's run links. */
  private readonly sessionRefs = computed<Map<string, SessionRef[]>>(() => {
    const ctx = this.ctx;
    const out = new Map<string, SessionRef[]>();
    if (ctx === null) return out;
    for (const [key, links] of repoSessions(this.runLinks(), { workspaceId: ctx.workspaceId, system: ctx.system, change: ctx.change })) {
      out.set(key, links.map((l) => ({ runId: l.run_id, startedAt: l.started_at })));
    }
    for (const e of this.log()) {
      const list = out.get(e.key) ?? [];
      if (!list.some((r) => r.runId === e.id)) out.set(e.key, [...list, { runId: e.id, startedAt: Math.floor(e.at / 1000) }].sort((a, b) => a.startedAt - b.startedAt));
    }
    return out;
  });

  /** Every session by run id: the live ones from the run store (or what was frozen), the earlier ones from their transcripts. */
  private readonly sessionById = computed<Map<string, ShownSession>>(() => {
    const live = new Map(this.groups().flatMap((g) => g.runs.map((r) => [r.id, r] as const)));
    const opened = this.openedRuns();
    const details = this.details();
    const records = this.records();
    const out = new Map<string, ShownSession>();
    for (const refs of this.sessionRefs().values()) {
      for (const ref of refs) {
        const run = live.get(ref.runId);
        if (run !== undefined) {
          out.set(ref.runId, { ...run, live: true, note: null });
          continue;
        }
        const detail = details[ref.runId];
        const snap = detail === undefined || detail === 'unreadable' ? IDLE : detail;
        out.set(ref.runId, {
          id: ref.runId,
          startedAt: timeOf(ref.startedAt * 1000),
          spec: null,
          state: snap.state,
          events: snap.events,
          summary: snap.summary,
          asks: snap.asks,
          permissions: snap.permissions,
          given: snap.given,
          unseenFrom: null,
          latest: false,
          expanded: opened.has(ref.runId),
          outcome: recordOutcome(records.find((r) => r.id === ref.runId) ?? null),
          live: false,
          note: detail === 'unreadable' ? 'Transcript not available' : null,
        });
      }
    }
    return out;
  });

  private readonly sessionPick = computed(() => {
    const pick = this.pick();
    return pick === null ? { sessions: [] as SessionRef[], unknown: false } : sessionsFor(pick, this.status()?.tasks ?? [], this.sessionRefs(), this.taskLinks());
  });

  /** The sessions of the pick: the latest shows open, every earlier one folds to its start time and outcome until picked. */
  readonly shownSessions = computed<ShownSession[]>(() => {
    const refs = this.sessionPick().sessions;
    const byId = this.sessionById();
    return refs.flatMap((ref, i) => {
      const session = byId.get(ref.runId);
      return session === undefined ? [] : [{ ...session, latest: i === refs.length - 1 }];
    });
  });

  /**
   * Every pane the page keeps mounted, in a stable order: the sessions of the pick, shown, and every other live run, hidden, so a
   * pick never removes a live pane. An ended session mounts only while it is picked; it holds nothing a remount would lose.
   */
  private readonly mountedSessions = computed<ShownSession[]>(() => {
    const shown = new Map(this.shownSessions().map((s) => [s.id, s] as const));
    const out: ShownSession[] = [];
    for (const [id, session] of this.sessionById()) {
      const on = shown.get(id);
      if (on !== undefined) out.push({ ...on, shown: true });
      else if (session.live) out.push({ ...session, latest: true, shown: false });
    }
    return out;
  });

  /** Said above the sessions of a task the build cannot tell the session of. */
  readonly sessionNote = computed<string | null>(() => {
    const pick = this.pick();
    if (pick === null || pick.kind !== 'task' || !this.sessionPick().unknown) return null;
    const repo = this.status()?.tasks.find((t) => t.id === pick.task)?.repo;
    return repo === undefined ? null : `This task was recorded before Kata linked tasks to runs, or on another machine. Showing every session of ${repo}.`;
  });

  /** The latest ended session of a repository, as the records say it ended. */
  private latestExit(key: string): number | null | 'no-run' {
    const byId = this.sessionById();
    const ended = (this.sessionRefs().get(key) ?? []).filter((r) => {
      const session = byId.get(r.runId);
      return session === undefined || !RUNNING.includes(session.state);
    });
    const last = ended.at(-1);
    const record = last === undefined ? undefined : this.records().find((r) => r.id === last.runId);
    return record === undefined ? 'no-run' : (record.exit ?? null);
  }

  /** Whether the review is running or stopped, for the action its entry offers. */
  private readonly reviewSituation = computed(() => ({ live: this.started() && this.phase() === 'reviewing', stopped: this.driver.stopped().has(REVIEW) }));

  /** The tasks area: a heading per repository from where it stands, and its tasks with what each shows. */
  readonly taskAreas = computed<TaskArea[]>(() => {
    const status = this.status();
    if (status === null) return [];
    const review = this.reviewSituation();
    return this.groupKeys().map((repo) => {
      const repoStatus = status.repos.find((r) => r.repo === repo);
      const stop = this.driver.stopped().get(repo);
      const going = this.driver.going().has(repo);
      const entry = this.latest(repo);
      const heading = situationView(
        {
          live: going,
          stop: stop === undefined ? null : { task: stop.task, reason: stop.reason },
          state: repoStatus?.state ?? null,
          firstUnfinished: repoStatus?.firstUnfinished ?? null,
          session: this.started() ? 'this' : 'none',
          stage: this.changeStage(),
          latestExit: this.latestExit(repo),
        },
        {
          workSecs: entry === null ? null : (this.clocks()[entry.id]?.work ?? 0),
          limitSecs: this.handoff?.timeoutSecs ?? 0,
          waitSecs: entry !== null && going && this.isWaiting(entry.id) ? (this.clocks()[entry.id]?.current ?? 0) : null,
          unseen: this.unseenOf(repo),
        },
      );
      const { situation } = heading;
      return {
        repo,
        situation,
        heading,
        action: repoAction(situation ?? { kind: 'idle' }, repo, review),
        tasks: status.tasks.filter((t) => t.repo === repo).map((t) => ({ id: t.id, name: t.name, state: this.stateOfTask(t, situation) })),
      };
    });
  });

  /** What the tasks area says about the review. */
  readonly reviewEntry = computed<ReviewEntry>(() => {
    if (this.started() && this.phase() === 'reviewing') return 'running';
    const ctx = this.ctx;
    if (ctx === null) return 'not run';
    const scope = { workspaceId: ctx.workspaceId, system: ctx.system, change: ctx.change };
    const state = reviewState(this.runLinks(), this.records(), this.heads(), scope, this.reviewDoc(), this.masterRef()?.repo ?? null);
    return state.kind === 'current' || state.kind === 'current-document' ? 'finished' : state.kind === 'stale' ? 'stale' : 'not run';
  });

  /** Everything the build page shows, from the members above; the page itself decides nothing. */
  readonly view = computed<BuildPageView>(() => {
    const pick = this.pick();
    const stage = this.stage();
    const areas = this.taskAreas();
    const review = this.reviewSituation();
    const entry = this.reviewEntry();
    const pickedRepo = pick?.kind === 'repo' ? pick.repo : pick?.kind === 'task' ? this.status()?.tasks.find((t) => t.id === pick.task)?.repo : undefined;
    const hasSessions = [...this.sessionRefs().values()].some((refs) => refs.length > 0);
    const hasChanges = this.changedFiles();
    const findings = this.reviewFindingsView(stage);
    return {
      stage,
      stageMessage: this.stageMessage(),
      facts: { tasks: this.tasksLabel(), elapsed: this.started() && this.active() ? hms(this.lock.elapsedSecs()) : null },
      actions: this.actions(),
      groups: areas.map((g) => ({
        repo: g.repo,
        status: { tone: g.heading.tone, label: g.heading.label },
        clock: g.heading.clock,
        paused: g.heading.paused,
        unseen: g.heading.unseen,
        stopLine: g.heading.stopLine,
        action: g.action,
        picked: pickedRepo === g.repo,
        tasks: g.tasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: taskStatus(t.state),
          departure: t.state.kind === 'done' ? t.state.departure : null,
          picked: pick?.kind === 'task' && pick.task === t.id,
        })),
      })),
      review: { status: reviewStatus(entry), action: repoAction({ kind: 'idle' }, REVIEW, review), picked: pick?.kind === 'review' },
      pick,
      sessions: this.mountedSessions(),
      sessionNote: this.sessionNote(),
      stops: areas.flatMap((g) => (g.heading.stopLine === null ? [] : [{ repo: g.repo, reason: g.heading.stopLine }])),
      findings,
      waiting: this.waitingNotices(),
      announcement: this.announcement(),
      areas: shownAreas({ stage, hasSessions, hasChanges }),
      narrow: this.pageNarrow(),
    };
  });

  /** The review's findings for the page: shown once the build's review finished and has been read. */
  private reviewFindingsView(stage: BuildStage): FindingsView | null {
    if ((stage !== 'review-finished' && stage !== 'done') || this.reading()) return null;
    if (this.reviews().length === 0 && !this.unrecorded()) return null;
    return { notice: this.reviewNotice(), findings: this.findings(), replaced: this.replaced(), older: this.older(), emptyText: this.emptyText() };
  }

  /** Where the master repository is: what the build was started from, else what the change page loaded. */
  private masterRef(): { repo: string; path: string } | null {
    return this.handoff?.start.master ?? this.loaded()?.master ?? null;
  }

  /** Read the change's run links, task links and run records, and where each repository stands. */
  private async readSessions(): Promise<void> {
    const ctx = this.ctx;
    const master = this.masterRef();
    if (ctx === null || master === null) return;
    try {
      const [links, tasks, records] = await Promise.all([this.transport.sdlcRunLinks(), this.transport.sdlcTaskLinks(), this.transport.listRuns()]);
      this.runLinks.set(links);
      this.taskLinks.set(tasks);
      this.records.set(records);
    } catch (e) {
      this.toasts.error(`Could not read the earlier sessions: ${message(e)}`);
    }
    try {
      const repos = [master.repo, ...(this.status()?.repos.map((r) => r.repo) ?? [])];
      this.heads.set(await this.transport.sdlcBuildHeads(ctx.folder, [...new Set(repos)], ctx.change));
    } catch {
      this.heads.set({});
    }
  }

  /** Read an earlier session's transcript the first time it is shown. */
  private async readDetail(id: string): Promise<void> {
    if (this.readingDetail.has(id) || this.details()[id] !== undefined) return;
    this.readingDetail.add(id);
    let snap: RunSnapshot | 'unreadable';
    try {
      snap = (await this.transport.loadRun(id)).events.reduce(reduce, IDLE);
    } catch {
      snap = 'unreadable';
    }
    this.details.update((d) => ({ ...d, [id]: snap }));
  }

  /** Open an earlier run in full, or fold it back to its one line. */
  toggleRun(id: string): void {
    const next = new Set(this.openedRuns());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openedRuns.set(next);
  }

  select(name: string): void {
    this.choose(name === REVIEW ? { kind: 'review' } : { kind: 'repo', repo: name });
  }

  /** A heading of the build page asked to cancel or continue its repository (or the review). */
  repoAction(e: { repo: string; action: 'cancel' | 'continue' }): void {
    this.select(e.repo);
    if (e.action === 'cancel') this.cancelRun();
    else void this.continueRun();
  }

  /** Go to a waiting repository: its Activity, with its open question brought into view and focused. */
  goTo(repo: string): void {
    this.select(repo);
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
    if (!(await this.previewContinue(key))) return;
    const owner = this.ownerOf(key);
    try {
      if (this.settled) {
        const out = await this.transport.sdlcBuildPrepare(ctx.folder, h.start.master.repo, ctx.system, ctx.change, false, owner, 'continue');
        if (out.kind === 'refused') {
          this.refusal.set({ reason: out.message, problems: out.problems });
          return;
        }
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
        const out = await this.transport.sdlcBuildPrepare(ctx.folder, h.start.master.repo, ctx.system, ctx.change, true, this.ownerOf(key), 'continue');
        if (out.kind === 'refused') {
          this.refusal.set({ reason: out.message, problems: out.problems });
          return;
        }
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

  closeRefusal(): void {
    this.refusal.set(null);
  }

  cancelContinue(): void {
    this.asking = null;
    this.pendingLeftovers.set(null);
  }

  /** The key the build's choices are kept under. */
  private buildKey(): string {
    const ctx = this.ctx!;
    return `${ctx.system}/${ctx.change}`;
  }

  /**
   * Show the preview of continuing one repository (or the review), pre-set to the build's choices. What the engineer
   * confirms becomes the build's: it is kept, and the driver gives it to this repository's next run and every run after.
   * False when the engineer cancelled.
   */
  private async previewContinue(key: string): Promise<boolean> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    const review = key === REVIEW;
    const repo = review ? h.start.master.repo : key;
    try {
      const run = this.runFor(review ? REVIEW : { repo }, h.timeoutSecs, null, false);
      const settings = this.modes.settings() ?? (await this.modes.load());
      const spec = specFor('build', null, { folder: ctx.folder, system: ctx.system, change: ctx.change }, settings, [], run);
      const result = await this.preview.openBuild({
        title: review ? 'Continue review' : `Continue ${repo}`,
        kind: 'continue-one',
        sections: [{ title: review ? 'Review' : repo, repo: review ? null : repo, spec, workdir: spec.workdir }],
        from: { session: this.givens.session(), job: null, build: this.givens.build(this.buildKey())?.off ?? h.choices?.off ?? null },
        limitSecs: h.timeoutSecs,
      });
      if (result === null) return false;
      const choices: BuildChoices = { off: result.off };
      this.givens.setBuild(this.buildKey(), choices);
      this.handoff = { ...h, choices };
      this.driver.setChoices(choices);
      return true;
    } catch (e) {
      this.toasts.error(`Could not preview the run: ${message(e)}`);
      return false;
    }
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
    // While other repositories still run the page already holds the lock; after the build was settled it takes it again.
    if (!this.holding) {
      if (!this.lock.beginBuild('Build')) return;
      this.holding = true;
    }
    await this.driver.continueRepo(key);
  }

  answer(runId: string, e: { id: string; answers: string[][] }): void {
    this.lock.answer(runId, e.id, e.answers);
  }

  decide(runId: string, e: { id: string; allow: boolean; message: string | null }): void {
    this.lock.decide(runId, e.id, e.allow, e.message);
  }

  // --- what the engineer has seen

  /** The repository whose Activity is on show, if Activity is. */
  private readonly onShow = computed(() => (this.tab() === 'activity' ? this.selected() : null));

  private unseenOfRun(e: Entry): number {
    if (e.key === this.onShow()) return 0;
    return Math.max(0, this.snapOf(e.id).events.length - (this.seen()[e.id] ?? 0));
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

  /** What a task shows; a task the situation table cannot place (or a repository whose situation is unknown) shows the fallback. */
  private stateOfTask(t: TaskStatus, situation: Situation | null): TaskState {
    if (situation === null) return fallbackTaskState(t);
    try {
      return taskState(t, situation);
    } catch {
      return fallbackTaskState(t);
    }
  }

  private latest(key: string): Entry | null {
    const entries = this.log().filter((e) => e.key === key);
    return entries.at(-1) ?? null;
  }

  private isWaiting(runId: string): boolean {
    return this.lock.waiting().some((w) => w.runId === runId);
  }

  private tick(t: number, waiting: ReadonlySet<string>): void {
    const dt = t - this.lastTick;
    this.lastTick = t;
    if (dt <= 0) return;
    const next: Record<string, Clock> = { ...this.clocks() };
    for (const e of this.log()) {
      if (!RUNNING.includes(this.snapOf(e.id).state)) continue;
      const c = next[e.id] ?? { work: 0, paused: 0, current: 0 };
      next[e.id] = waiting.has(e.id)
        ? { work: c.work, paused: c.paused + dt, current: c.current + dt }
        : { work: c.work + dt, paused: c.paused, current: 0 };
    }
    this.clocks.set(next);
  }

  // --- the driver's dependencies

  private newDriver(): BuildDriver {
    return new BuildDriver({
      status: () => this.readStatus(),
      start: (target, opts) => this.startRun(target, opts),
      heads: () => this.readHeads(),
    });
  }

  /** A run's state: its final one once the lock forgot it, else the run store's. */
  private snapOf(id: string): RunSnapshot {
    return this.frozen()[id] ?? this.runs.snapshot(id)();
  }

  private async readStatus(): Promise<BuildStatus> {
    const master = this.masterRef()!;
    const ctx = this.ctx!;
    return this.transport.sdlcBuildStatus(master.path, ctx.system, ctx.change);
  }

  private readHeads(): Promise<Record<string, string>> {
    const ctx = this.ctx!;
    // The master is a build participant: a round there that commits makes the review stale like any product repository's.
    return this.transport.sdlcBuildHeads(ctx.folder, [this.handoff!.start.master.repo, ...this.productRepos], ctx.change);
  }

  /** Read whether any repository has changed files, the way the Changes view lists them; a failed read counts as none. */
  private async readChanges(): Promise<void> {
    const ctx = this.ctx;
    const master = this.masterRef();
    if (ctx === null || master === null) return;
    try {
      const repos = await this.transport.sdlcChangeRepos(ctx.folder, master.repo, ctx.system, ctx.change);
      const lists = await Promise.all(repos.map((r) => this.transport.sdlcDiffFiles(r.path, 'whole').then((l) => l.files.length > 0, () => false)));
      this.changedFiles.set(lists.some(Boolean));
    } catch {
      this.changedFiles.set(false);
    }
  }

  private async refresh(): Promise<void> {
    if (this.masterRef() === null || this.ctx === null) return;
    void this.readChanges();
    try {
      this.status.set(await this.readStatus());
    } catch (e) {
      this.toasts.error(`Could not read the build log: ${message(e)}`);
    }
  }

  private runFor(target: RunTarget, timeoutSecs: number, instructions: string | null, continueOnLeftovers: boolean): BuildRun {
    const h = this.handoff!;
    const ctx = this.ctx!;
    return {
      target,
      timeoutSecs,
      instructions,
      workspaceFolder: ctx.folder,
      masterRepo: h.start.master.repo,
      systemRepos: [...new Set([...ctx.systemRepos, ...this.productRepos])],
      checksDir: h.checksDir,
      continueOnLeftovers,
    };
  }

  private async startRun(target: RunTarget, opts: RunOptions): Promise<RunEnd> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    const review = target === 'review';
    if (review) await this.noteSectionsBefore();
    const repo = review ? h.start.master.repo : target.repo;
    const path = review ? h.start.master.path : this.pathOf(repo);
    // The backend names where each participant is checked out; a repository it does not name has no folder to run in.
    if (path === undefined) throw new NotCheckedOut(repo);
    const run = this.runFor(target, opts.timeoutSecs, opts.instructions ?? null, this.confirmed.delete(review ? REVIEW : repo));
    const settings = this.modes.settings() ?? (await this.modes.load());
    const spec = specFor('build', null, { folder: ctx.folder, system: ctx.system, change: ctx.change }, settings, [], run);
    // The build's choices, as they stand when this run starts; a run the driver starts by itself never opens a preview.
    spec.given = { ...spec.given, ...givenFor(opts.choices.off, spec.workdir) };
    const key = review ? REVIEW : repo;
    // The build log as it stands before the run, to tell which tasks the run recorded.
    const before = review ? null : await this.readStatus().catch(() => null);
    const started: { id: string | null } = { id: null };
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
        onRun: (id) => {
          started.id = id;
          this.noteRun(id, key, spec, opts.signal);
        },
      },
    );
    if (before !== null && started.id !== null) await this.linkTasks(before, repo, started.id);
    // A cancel settles the run's state before the engine reports an exit code: it is the engineer's cancel (130).
    return opts.signal.aborted && end.exit !== 0 ? { exit: 130, error: null } : end;
  }

  /** Append a link from the run to each task it recorded in the build log. A failed append is a toast and changes nothing else. */
  private async linkTasks(before: BuildStatus, repo: string, runId: string): Promise<void> {
    const ctx = this.ctx!;
    try {
      const tasks = newlyRecorded(before, await this.readStatus(), repo);
      if (tasks.length === 0) return;
      await this.transport.sdlcLinkTasks(tasks.map((task) => ({ workspace_id: ctx.workspaceId, system: ctx.system, change: ctx.change, repo, task, run_id: runId })));
      this.taskLinks.set(await this.transport.sdlcTaskLinks());
    } catch (e) {
      this.toasts.error(`Could not link the tasks to the run: ${message(e)}`);
    }
  }

  private noteRun(id: string, key: string, spec: RunSpec, signal: AbortSignal): void {
    this.log.update((l) => [...l, { id, key, spec, at: Date.now() }]);
    this.clocks.update((c) => ({ ...c, [id]: { work: 0, paused: 0, current: 0 } }));
    const stop = () => void this.runs.cancelRun(id);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }

  // --- the end of a build

  /**
   * The one place the page gives the lock back: once the build is not building or reviewing, its branches are settled and no
   * leftover is on show, the lock is closed, which frees the page, the toolbar and the way back.
   */
  private async release(phase: BuildPhase): Promise<void> {
    const h = this.handoff;
    if (h === null) return;
    this.lock.endBuild();
    if (phase === 'finished') void this.readReview();
    try {
      await this.runner.finishBuild(h.start);
      this.settled = true;
    } finally {
      await this.leftoversGone();
      this.freeze();
      this.lock.close();
      this.holding = false;
    }
  }

  /** Resolves once no leftover dialog is open; the engineer's choice in it is what closes it. */
  private leftoversGone(): Promise<void> {
    if (this.runner.leftovers() === null) return Promise.resolve();
    return new Promise((resolve) => {
      const ref = effect(
        () => {
          if (this.runner.leftovers() !== null) return;
          untracked(() => {
            ref.destroy();
            resolve();
          });
        },
        { injector: this.injector },
      );
    });
  }

  /** Closing the lock makes the run store forget the build's runs; keep what they showed. */
  private freeze(): void {
    const next: Record<string, RunSnapshot> = { ...this.frozen() };
    for (const e of this.log()) next[e.id] ??= this.snapOf(e.id);
    this.frozen.set(next);
  }

  /** The review run the build just finished: its findings come from the change's review document, or from the closing text of its transcript when it has none. */
  private async readReview(): Promise<void> {
    const entry = this.latest(REVIEW);
    if (entry === null || this.readRuns.has(entry.id)) return;
    this.readRuns.add(entry.id);
    this.reading.set(true);
    try {
      await this.readReviewOf();
    } finally {
      this.reading.set(false);
    }
  }

  /** The review document of the change, null when it has none, undefined when it cannot be read (reported). */
  private async readDocument(): Promise<ReviewRecord | null | undefined> {
    const h = this.handoff!;
    const ctx = this.ctx!;
    try {
      return await this.transport.sdlcReviewRecord(h.start.master.path, ctx.system, ctx.change);
    } catch (e) {
      this.toasts.error(`Could not read the review document: ${message(e)}`);
      return undefined;
    }
  }

  /** Sets the reviews on show from what `shownReview` decided; false when there is no review to show. */
  private showReviews(shown: ReviewShown, at: number | null): boolean {
    if (shown.kind === 'none') return false;
    if (shown.kind === 'words') {
      this.fromWords.set(true);
      this.reviews.update((r) => [...r, { at, label: null, findings: shown.findings }]);
      return true;
    }
    this.fromWords.set(false);
    const labeled = (r: { number: number; reviewedAt: string; findings: Finding[] }): Review => ({
      at: null,
      label: `Review ${r.number} of ${r.reviewedAt}`,
      findings: r.findings,
    });
    this.reviews.set([...shown.earlier].reverse().map(labeled).concat({ at: null, label: null, findings: shown.latest.findings }));
    return true;
  }

  /** What the review run left in the review document: a new review to show, or the plain fact that it recorded none. */
  private async readReviewOf(): Promise<void> {
    const document = await this.readDocument();
    if (document === undefined) return;
    await this.noteReviewNotice(document);
    const strayed = await this.strayedFiles();
    this.runNotice.set(
      strayed.length === 0 ? null : { tone: 'warning', text: 'The review run changed more than the review document', lines: strayed },
    );
    if (strayed.length > 0 || document === null || document.reviews.length <= this.sectionsBefore) {
      // The run's check failed three times, or it never wrote: whatever the document holds is an earlier review, not this one.
      this.reviews.set([]);
      this.fromWords.set(false);
      this.unrecorded.set(true);
      return;
    }
    this.unrecorded.set(false);
    this.showReviews(shownReview(document, null), null);
  }

  /** The files the review run changed in the master besides the review document; none when it kept to it. */
  private async strayedFiles(): Promise<string[]> {
    if (this.masterBefore === null) return ['could not check the master repository: its head before the run is unknown'];
    try {
      return await this.transport.sdlcReviewVerify(this.handoff!.start.master.path, this.ctx!.system, this.ctx!.change, this.masterBefore, this.dirtyBefore);
    } catch (e) {
      return [`could not check the master repository: ${message(e)}`];
    }
  }

  /** Counts the reviews in the review document before a review run starts. A document that cannot be read counts as none. */
  private async noteSectionsBefore(): Promise<void> {
    this.unrecorded.set(false);
    this.runNotice.set(null);
    try {
      const snapshot = await this.transport.sdlcSnapshot(this.handoff!.start.master.path);
      this.masterBefore = snapshot.head;
      this.dirtyBefore = snapshot.dirty;
    } catch {
      this.masterBefore = null;
      this.dirtyBefore = {};
    }
    try {
      const document = await this.transport.sdlcReviewRecord(this.handoff!.start.master.path, this.ctx!.system, this.ctx!.change);
      this.sectionsBefore = document?.reviews.length ?? 0;
    } catch {
      this.sectionsBefore = 0;
    }
  }

  /** The notice for the review document, from the one owner of the table; a plugin that cannot be asked about counts as missing. */
  private async noteReviewNotice(document: ReviewRecord | null): Promise<void> {
    if (document === null) {
      this.reviewDocNotice.set(null);
      return;
    }
    let readiness: Readiness;
    try {
      readiness = await this.transport.sdlcPluginReadiness(this.ctx!.folder);
    } catch {
      readiness = { kind: 'missing' };
    }
    this.reviewDocNotice.set(shownPart({ layout: document.layout, problems: document.problems }, readiness).notice);
  }

  /** A round starts from a finished review: the latest one linked to this change becomes the one the new review replaces. */
  private async loadEarlierReview(ctx: BuildContext): Promise<void> {
    const document = await this.readDocument();
    if (document === undefined) return;
    if (document !== null) {
      this.showReviews(shownReview(document, null), null);
      return;
    }
    await this.reviewFromWords(ctx);
  }

  /** The findings of the latest review run linked to this change, from the closing words of its transcript. */
  private async reviewFromWords(ctx: BuildContext): Promise<void> {
    try {
      const links = (await this.transport.sdlcRunLinks()).filter(
        (l) => l.workspace_id === ctx.workspaceId && l.system === ctx.system && l.change === ctx.change && l.stage === REVIEW,
      );
      const last = links.reduce<(typeof links)[number] | null>((a, l) => (a === null || l.started_at > a.started_at ? l : a), null);
      if (last === null) return;
      const words = reviewFindings(await this.transport.loadRun(last.run_id));
      this.reviews.set([]);
      this.showReviews(shownReview(null, words), last.started_at * 1000);
    } catch {
      // The earlier review's transcript may be gone; the new review is then simply the only one.
    }
  }
}
