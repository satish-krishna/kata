import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { BuildPhase } from '@bindings/BuildPhase';
import type { BuildPreviewKind } from '@bindings/BuildPreviewKind';
import type { BuildRow } from '@bindings/BuildRow';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { BuildState } from '@bindings/BuildState';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { RepoBoard } from '@bindings/RepoBoard';
import type { ReviewStanding } from '@bindings/ReviewStanding';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { ChangeView } from '@bindings/ChangeView';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { Readiness } from '@bindings/Readiness';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { ReviewRows } from '@bindings/ReviewRows';
import type { RoundGroup } from '@bindings/RoundGroup';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import { picksOf } from '../../ui/build-dialog';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { RunSpec } from '@bindings/RunSpec';
import type { StartForm } from '@bindings/StartForm';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { Stop } from '@bindings/Stop';
import type { TaskLink } from '@bindings/TaskLink';
import { GivenStore, type BuildChoices } from '../../core/given/given.store';
import { RunPreviewViewModel, type BuildSectionRequest } from '../../core/given/run-preview.view-model';
import { IDLE, reduce, type RunSnapshot } from '../../core/run/reduce';
import { RunStore } from '../../core/run/run.store';
import { ProgressStore } from '../../core/progress/progress.store';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { ChangeDraftStore } from '../../core/sdlc/change-draft.store';
import { RunLandingStore } from '../../core/run/run-landing.store';
import { pendingKind, type AskRecord, type MessageRecord, type MessageRefusal, type RunGiven, type PermissionRecord, type RunState, type RunSummary, type StreamEvent } from '../../lib/events';
import { activityFor, linksOfFollowedRuns, outcomeOf, recordOutcome, repoSessions, sessionsFor, tabOf, type Chosen, type LiveRun, type Pick, type SessionRef, type SessionTab } from '../../lib/build-sessions';
import { sameChange } from '../../lib/build-host';
import { sameStepChange } from '../../lib/sdlc-steps';
import { buildStage, shownAreas, taskGroups, type BuildStage } from '../../lib/build-stage';
import { hms, ms, situationView, type Situation, type SituationView, type TaskState } from '../../lib/build-state';
import { layoutStage as layoutStageOf, type LayoutStage } from '../../lib/build-layout-stage';
import { progressLabels, type ProgressStepId } from '../../lib/progress-steps';
import { shownPart, type DocNotice } from '../../lib/doc-notice';
import { shownReview, type ReviewShown } from '../../lib/sdlc-review';
import { REVIEW_MISSING_TEXT } from '../../lib/sdlc-done';
import { DEFAULT_BUILD_SECS, reviewFindings, stageName, transcriptRunId, type Finding, type StageAction } from '../../lib/sdlc';
import { groupFindings, type FindingGroup } from '../../lib/sdlc-findings';
import { filterCounts, taskList, type TaskFilter, type TaskLine, type TaskListView } from '../../lib/build-task-list';
import type { BuildDialogMode } from '../../ui/build-dialog';
import type { ReplacedFindings } from '../../ui/findings-list';
import type { HeldView } from '../../ui/held-panel';
import type { WaitingItem } from '../../ui/waiting-notice';

/** What the build runs against: the workspace, the system and the change. */
export type BuildContext = {
  workspaceId: string;
  folder: string;
  system: string;
  change: string;
  /** Every product repository the system names, whether or not the plan does. */
  systemRepos: string[];
};

/** One run of the selected repository, as the observe pane shows it. */
export type ShownRun = {
  id: string;
  startedAt: string;
  /** The spec the run started with; the backend composes it, so the page has none for a run it did not launch. */
  spec: RunSpec | null;
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
  given: RunGiven | null;
  messages: MessageRecord[];
  refusal: MessageRefusal | null;
  /** The index of the first event the engineer has not seen since they came back to this run, or null. */
  unseenFrom: number | null;
  /** True for the newest run of its repository, which always shows in full. */
  latest: boolean;
  /** How the run went, for its one line: the status, then exit, turns and cost once it completed. */
  outcome: string;
};

/** One session of a repository (or the review): a run the backend had live while the page was open, or an earlier one read from the records. */
export type ShownSession = ShownRun & {
  /** True for a run the backend had live while the page was open; false for an earlier run read from the records. */
  live: boolean;
  /** Why an earlier run shows nothing, or null. */
  note: string | null;
  /** True for the one session of its repository in view: the one the engineer picked, else the newest. */
  shown: boolean;
  /** True when the session has an unanswered question or a pending permission. */
  waiting: boolean;
  /** What the session's tab says: running, a question waiting, or how it ended. */
  tab: SessionTab;
  /** True for a live run kept mounted while another pick is on show; it is not on the page at all. */
  offPick?: boolean;
};

/** What the tasks area says about the review. */
export type ReviewEntry = 'not run' | 'running' | 'finished' | 'stale';

export type StageMessage = { title: string; lines: string[] };

/** What the page is given on every load of the change. */
export type BuildPageInput = {
  ctx: BuildContext;
  /** The master repository's name, which orders the lists; never a path, since the backend resolves where the change lives. */
  masterRepo: string;
  change: ChangeView;
  status: BuildStatus | null;
  done: boolean;
  review: ReviewRecord | null;
};

/** One repository of the tasks area: where it stands, what it offers, and its tasks. */
export type TaskArea = {
  repo: string;
  situation: Situation;
  heading: SituationView;
  action: 'cancel' | 'continue' | null;
  tasks: { id: string; name: string; state: TaskState; commits: string[] }[];
  /** The commits the plugin reports in this repository that name no task. */
  untasked: string[];
};

/** A status as the page shows it: an andon tone, drawn as a dot, and its label. */
export type StatusText = { tone: 'success' | 'warning' | 'error' | 'idle'; label: string };

/** One task of the tasks area. */
export type TaskRowView = { id: string; name: string; status: StatusText; departure: string | null; picked: boolean; commits: string[] };

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
  /** Tasks finished out of all of the repository's. */
  progress: { done: number; total: number };
  /** What the repository lists on their own line and what it folds, under the filter. */
  list: TaskListView;
  /** The repository's checks as the plugin recorded them; null while they are not read. */
  checks: RepoCheckView | null;
};

/** One row of the Review group: the finding as the page draws and picks it, under the backend's key and one-line summary. */
export type ReviewRowShown = { key: string; finding: Finding; summary: string };

/** The Review group, from the backend's rows: its order, its counts and its low split are the backend's. */
export type ReviewRowsShown = {
  counts: ReviewRows['counts'];
  total: number;
  groups: { repo: string | null; rows: ReviewRowShown[]; low: ReviewRowShown[] }[];
};

/** The review's entry under the tasks. */
export type ReviewEntryView = {
  status: StatusText;
  action: 'cancel' | 'continue' | null;
  picked: boolean;
  /** The latest review's findings as the backend lists them; null while the review is not finished. */
  rows: ReviewRowsShown | null;
  /** The notice above the rows when the work changed since the review; null otherwise. */
  stale: string | null;
  /** The review finished and found nothing. */
  nothingFound: boolean;
  /** The repositories (the empty string for findings naming none) whose folded low findings are open. */
  openLow: ReadonlySet<string>;
};

/** The review's findings, with the notice above them. */
export type FindingsView = { notice: DocNotice | null; groups: FindingGroup[]; findings: Finding[]; replaced: ReplacedFindings[]; older: boolean; emptyText: string };

const READING_REVIEW = 'Reading the review…';
const REVIEW_NOT_RUN = 'The review runs by itself once the last task is recorded.';
const REVIEW_RUNNING = 'The review is running. Its findings appear here when it ends.';
const NO_DEPARTURES = 'No departures from the plan.';

/** A task's recorded departure from the plan. */
export type Departure = { repo: string; task: string | null; text: string };

/** What the findings area shows: one message in place of the review, or the review with the notice above it, then the departures. */
export type FindingsAreaView = {
  /** Said instead of the review: while it is read, before it runs, while it runs; null when the review itself shows. */
  message: string | null;
  /** The out-of-date notice above a stale review's findings. */
  staleNotice: string | null;
  review: FindingsView | null;
  /** Every recorded departure; null while the review is read. */
  departures: Departure[] | null;
  /** Said in place of the departures when there are none. */
  noDepartures: string | null;
};

/** The findings area as the page shows it: the review's own states, and the panel when the review waits for another change. */
export type FindingsAreaShown = FindingsAreaView & { waiting: HeldView | null };

/** Where the engineer picked a finding: the file and line to show in the changed files, and a count so picking again shows it again. */
export type FindingPlace = { file: string; line: number | null; text: string; n: number; repo?: string };

/** The findings area for each state of the review. */
export function findingsAreaOf(i: { reading: boolean; entry: ReviewEntry; review: FindingsView; departures: Departure[] }): FindingsAreaView {
  const departures = i.reading ? null : i.departures;
  const noDepartures = departures !== null && departures.length === 0 ? NO_DEPARTURES : null;
  const said = (message: string): FindingsAreaView => ({ message, staleNotice: null, review: null, departures, noDepartures });
  if (i.reading) return said(READING_REVIEW);
  if (i.entry === 'not run') return said(REVIEW_NOT_RUN);
  if (i.entry === 'running') return said(REVIEW_RUNNING);
  return { message: null, staleNotice: i.entry === 'stale' ? REVIEW_MISSING_TEXT.stale : null, review: i.review, departures, noDepartures };
}

/** Everything the build page shows, computed once so the page itself only draws it. */
export type BuildPageView = {
  stage: BuildStage;
  stageMessage: StageMessage | null;
  /** The build's facts for the bar: `<done>/<total> tasks`, and the elapsed time while the build runs. */
  facts: { tasks: string; elapsed: string | null };
  actions: StageAction[];
  groups: TaskGroupView[];
  /** The task filter on show and how many tasks each choice holds across the build. */
  filter: { value: TaskFilter; counts: Record<TaskFilter, number> };
  /** The Departed filter is on and no task departed. */
  noDepartures: boolean;
  /** The picked task's departure from the plan, when it is a finished task that recorded one. */
  pickedDeparture: { task: string; text: string } | null;
  review: ReviewEntryView;
  pick: Pick | null;
  sessions: ShownSession[];
  /** The sessions of the pick as tabs, newest first; a live run kept mounted for another pick has none. */
  sessionTabs: ShownSession[];
  sessionNote: string | null;
  /** Each repository that stopped and why, for the activity area. */
  stops: { repo: string; reason: string }[];
  /** The findings area. */
  findingsArea: FindingsAreaShown;
  /** The panel for a build that waits for another change's repositories; null when it does not. */
  held: HeldView | null;
  /** The finding last picked, for the changed files to show. */
  findingPlace: FindingPlace | null;
  waiting: WaitingItem[];
  announcement: string;
  /** Which of the optional areas have something to show; the tasks area always does. */
  areas: { activity: boolean; files: boolean };
  /** The counts the area tabs show: changed files and findings. */
  counts: { files: number; findings: number };
};

/** The two views of a running build: what the agents say and do, and what they changed. */
export type BuildTab = 'activity' | 'changes';

/** What the Changes view looks at. */
export type BuildChanges = { ref: ChangeRef; masterRepo: string };

/** What starting a build came to, as the page needs to tell it. */
export type StartKind = StartOutcome['kind'];

/** Why a start did not go on: the reason and, one line each, what the plugin found. */
export type StartRefusal = { reason: string; problems: string[] };

/**
 * A run the page follows: which row it belongs to, when the page first saw it, and the change it is a run of, with that change's master
 * and repositories as the page knew them then. A run stays the run of its own change when the page moves to another one.
 */
type Entry = { id: string; key: string; at: number; ctx: BuildContext; repos: string[] };

/** Whether two contexts name the same change. */
const sameCtx = (a: BuildContext, b: BuildContext): boolean => a.folder === b.folder && a.system === b.system && a.change === b.change;
/** Seconds of a run's work (waiting for the engineer excluded), of all its waiting, and of the wait it is in now. */
type Clock = { work: number; paused: number; current: number };
/** A review of the whole change: one section of its review document, or the closing text of its run. */
type Review = { at: number | null; label: string | null; number: number | null; repos: string[]; findings: Finding[] };

/** Why a start that was refused, failed or could not run did not go on, as the page says it; null for any other outcome. */
function refusalOf(outcome: StartOutcome): StartRefusal | null {
  switch (outcome.kind) {
    case 'refused':
      return { reason: 'The plugin refused to start the build', problems: outcome.problems };
    case 'failed':
      return {
        reason: outcome.hook === null ? "The plugin's build start failed" : `The team's hook ${outcome.hook.id} failed`,
        problems: [...outcome.problems, ...(outcome.hook === null || outcome.hook.output.trim() === '' ? [] : [outcome.hook.output.trim()])],
      };
    case 'couldNotRun':
      return { reason: outcome.repo === null ? "This machine could not run the plugin's step" : `This machine could not run the plugin's step in ${outcome.repo}`, problems: [outcome.output] };
    default:
      return null;
  }
}

/** How a stopped preparation is worded: which repositories were prepared when it stopped, if any. */
function stoppedMessage(prepared: string[]): string {
  return prepared.length === 0 ? 'Preparation stopped' : `Preparation stopped. Prepared: ${prepared.join(', ')}`;
}

const REVIEW = 'review';
const NOT_STARTED: TaskState = { kind: 'not-started' };
const RUNNING: readonly RunState[] = ['running', 'awaiting'];
/** The time limit of a review started by hand. */
const REVIEW_TIMEOUT_SECS = 2 * 60 * 60;
/** The actions of the plugin's answer that belong to the build's bar. */
const BUILD_ACTIONS: readonly StageAction[] = ['start-build', 'continue-build', 'another-round', 'run-review', 'declare-done'];

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

/** A finding of the backend's rows as the page's finding type has it. */
function findingOf(f: ReviewRows['groups'][number]['rows'][number]['finding']): Finding {
  return {
    severity: f.severity,
    text: f.text,
    ...(f.id === undefined ? {} : { id: f.id }),
    ...(f.file === undefined ? {} : { file: f.file }),
    ...(f.line === undefined ? {} : { line: f.line }),
    ...(f.repo === undefined ? {} : { repo: f.repo }),
    ...(f.concern === undefined ? {} : { concern: f.concern }),
    ...(f.rule === undefined ? {} : { rule: f.rule }),
  };
}

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return null;
}

/**
 * The build page's state, which lives as long as the change page that provides it. The backend hosts the build; this reads what the
 * host announces (the phase, which repositories go, which stopped and why, which runs are live) and shows it, and starts, continues,
 * cancels, reviews and rounds through the host's commands. Rows come from the build log through the transport's `sdlcBuildStatus`;
 * nothing here decides what the build does next, which round is offered or in what order the findings are listed.
 */
@Injectable()
export class BuildPageViewModel {
  private readonly transport = inject(KataTransport);
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);
  private readonly progress = inject(ProgressStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly drafts = inject(ChangeDraftStore);
  private readonly landing = inject(RunLandingStore);
  /** The preview Continue and the build's dialogs open; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);

  private readonly ctxSig = signal<BuildContext | null>(null);
  private get ctx(): BuildContext | null {
    return this.ctxSig();
  }
  private set ctx(value: BuildContext | null) {
    this.ctxSig.set(value);
  }
  /** What the change page read about the change on its latest load; the page follows it. The host sets it, and `load` reads everything it names. */
  readonly loaded = signal<BuildPageInput | null>(null);
  /** The input `load` last took, so the effect that follows `loaded` does not read the same input twice. */
  private taken: BuildPageInput | null = null;
  /** The review document as last read, null when the change has none. */
  private readonly reviewDoc = signal<ReviewRecord | null>(null);
  private readonly runLinks = signal<RunLink[]>([]);
  private readonly taskLinks = signal<TaskLink[]>([]);
  private readonly records = signal<RunRecord[]>([]);
  /** Where each repository of the change stands now, for judging whether the review is stale. */
  private readonly heads = signal<Record<string, string>>({});
  /** Whether the latest review covers the current work, as the backend decided from the inputs above; null until it is read. */
  private readonly standing = signal<ReviewStanding | null>(null);
  /** The tasks area as the backend decided it from the build log's status and the host's live runs and stops. */
  private readonly board = signal<RepoBoard[]>([]);
  private boardSeq = 0;
  /** The final state of each earlier run whose transcript was read, by run id; 'unreadable' when it could not be. */
  private readonly details = signal<Readonly<Record<string, RunSnapshot | 'unreadable'>>>({});
  private readonly readingDetail = new Set<string>();

  // --- what the backend says about the build
  /** The build as the host last announced it; null when this session hosts no build of the change. */
  private readonly buildState = signal<BuildState | null>(null);
  /** The runs of the build that are live, each with its id. */
  private readonly runRefs = signal<BuildRunRef[]>([]);
  /** The repositories other changes hold that keep the review from starting. */
  private readonly reviewHeld = signal<HeldRepo[]>([]);
  /** The repositories that held the last start, until the engineer starts again. */
  private readonly startHeld = signal<HeldRepo[]>([]);
  /** The form of the last start, so Start build again starts it as a fresh start. */
  private lastForm: StartForm | null = null;
  /** The change whose build the page listens to. */
  private attached: string | null = null;
  private unlisten: (() => void) | null = null;

  private readonly status = signal<BuildStatus | null>(null);
  /** Whether any repository the page lists has changed files, as the Changes view lists them. */
  private readonly changedFiles = signal(false);
  /** How many files the repositories list as changed, for the area tabs. */
  private readonly changedFileTotal = signal(0);
  /** Every run the page has followed, of whichever change. */
  private readonly followed = signal<Entry[]>([]);
  /** The runs of the change on show; a run of another change never shows here. */
  private readonly log = computed<Entry[]>(() => {
    const ctx = this.ctxSig();
    return ctx === null ? [] : this.followed().filter((e) => sameCtx(e.ctx, ctx));
  });
  private readonly clocks = signal<Readonly<Record<string, Clock>>>({});
  private readonly reviews = signal<Review[]>([]);
  /** True when the findings come from a review run's closing words because the change has no review document. */
  private readonly fromWords = signal(false);
  /** What the one owner of the notice table says about the review document; null when it needs none. */
  private readonly reviewDocNotice = signal<DocNotice | null>(null);
  /** The Review group's rows, as the backend lists them for the latest review. */
  private readonly reviewListing = signal<ReviewRows | null>(null);
  /** What the engineer picked, or went to, with the stage it was made at; `activityFor` decides what it means. */
  private readonly chosen = signal<Chosen | null>(null);
  /** The build log as it stood when each run of a repository was first seen, by run id: what tells the tasks a run recorded. */
  private readonly bases = signal<Readonly<Record<string, BuildStatus>>>({});
  /** The transcripts already linked to the change, so a run is linked once. */
  private readonly linkedTranscripts = new Set<string>();
  /** The session the engineer picked in each repository, by repository; a repository with none follows its newest session. */
  private readonly pickedSession = signal<Readonly<Record<string, string>>>({});
  /** True from the moment the review's run leaves the build until its result is read. */
  private readonly readingNow = signal(false);
  private readonly changes = signal<BuildChanges | null>(null);
  /** How many events of each run the engineer had seen when its Activity was last on show, by run id. */
  private readonly seen = signal<Readonly<Record<string, number>>>({});
  /** Where the events the engineer missed begin in each run of the pane they just came back to, by run id. */
  private readonly marks = signal<Readonly<Record<string, number>>>({});
  private lastOnShow: string | null = null;
  private announced = new Set<string>();
  private focusCount = 0;
  private pickCount = 0;
  /** The seconds the page has watched a build or a run go, for the clocks. */
  private readonly clockSecs = signal(0);
  private lastTick = 0;
  /** When each open question or approval first showed, in clock seconds, keyed by run and pause id. */
  private readonly pendingSince = signal<Readonly<Record<string, number>>>({});

  /** Why a start did not go on, with what the plugin found; the refusal dialog is open exactly while this is set. */
  readonly refusal = signal<StartRefusal | null>(null);
  /** How a stopped preparation is worded on the page; null while there is none. */
  readonly stoppedNote = signal<string | null>(null);
  /** Whether this change's preparation is running now. */
  readonly preparing = signal(false);

  /** Stop the running preparation of this change. */
  async stopPreparing(): Promise<void> {
    const ref = this.ref();
    if (ref === null) return;
    try {
      await this.transport.stopStep(ref);
    } catch (e) {
      this.toasts.error(`Could not stop the preparation: ${message(e)}`);
    }
  }

  /** The build dialog on show beside the preview: which one, what a round may fix and how the findings group. */
  readonly dialogMode = signal<BuildDialogMode | null>(null);
  readonly roundOffer = signal<RoundOffer | null>(null);
  /** The groups of the open round dialog, in the Review group's order. */
  readonly roundGroups = signal<RoundGroup[]>([]);

  readonly tab = signal<BuildTab>('activity');
  readonly announcement = signal('');
  /** A request to bring a repository's open question into view and focus it; the view carries it out. */
  readonly focusRequest = computed(() => this.activity().focus);

  /** What the backend says the build is doing; none when this session hosts no build of the change. */
  readonly phase = computed<BuildPhase | 'none'>(() => this.buildState()?.phase ?? 'none');
  /** True once the backend hosts a build of the change in this session; it stays true after the build ended. */
  readonly started = computed(() => this.buildState() !== null);
  readonly active = computed(() => this.phase() === 'building' || this.phase() === 'reviewing');
  readonly report = computed(() => this.buildState()?.report ?? null);
  /** The repositories (and `review`) that have a run going, as the backend says. */
  private readonly going = computed<ReadonlySet<string>>(() => new Set(this.buildState()?.going ?? []));
  /** Each repository (or the review) that stopped and why, as the backend says. */
  private readonly stopped = computed<ReadonlyMap<string, Stop>>(() => new Map(Object.entries(this.buildState()?.stopped ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const]))));

  readonly tasksLabel = computed(() => {
    const tasks = this.status()?.tasks ?? [];
    return `${tasks.filter((t) => t.row !== null).length}/${tasks.length} tasks`;
  });

  /** What the engineer picked, else the first repository, or the review once the build is reviewed. Null before the status is read. */
  readonly pick = computed<Pick | null>(() => this.activity().pick);

  /** The transcript id of each run the page follows, to the id the run shows live under. */
  private readonly followedTranscripts = computed(() => new Map(this.log().flatMap((e) => { const t = transcriptRunId(this.snapOf(e.id).events); return t === null ? [] : [[t, e.id] as const]; })));

  /** The repositories whose run is live, each with the run and the build log from before it started. */
  private readonly liveRuns = computed<LiveRun[]>(() => {
    const bases = this.bases();
    return this.runRefs().flatMap((r) => {
      const before = bases[r.run];
      return r.key === REVIEW || before === undefined ? [] : [{ runId: r.run, repo: r.key, before }];
    });
  });

  /** What the pick is and what the activity area shows for it: the one owner of the default pick, Go to and the live task links. */
  private readonly activity = computed(() => {
    const ctx = this.ctx;
    return activityFor({
      stage: this.stage(),
      chosen: this.chosen(),
      firstRepo: this.groupKeys()[0] ?? null,
      status: this.status(),
      live: this.liveRuns(),
      taskLinks: linksOfFollowedRuns(this.taskLinks(), this.followedTranscripts()),
      scope: ctx === null ? null : { workspaceId: ctx.workspaceId, system: ctx.system, change: ctx.change },
    });
  });

  /** The row on show: the repository (or the review) the pick belongs to. */
  readonly selected = computed(() => {
    const pick = this.pick();
    if (pick === null) return null;
    if (pick.kind === 'review') return REVIEW;
    if (pick.kind === 'repo') return pick.repo;
    return this.status()?.tasks.find((t) => t.id === pick.task)?.repo ?? null;
  });

  /** Every run of the build, grouped by the repository (or the review) it belongs to. All stay mounted; only the selected group shows. */
  readonly groups = computed<{ key: string; runs: ShownRun[] }[]>(() => {
    const marks = this.marks();
    const out = new Map<string, ShownRun[]>();
    for (const e of this.log()) {
      const snap = this.snapOf(e.id);
      const run: ShownRun = {
        id: e.id,
        startedAt: timeOf(e.at),
        spec: null,
        state: snap.state,
        events: snap.events,
        summary: snap.summary,
        asks: snap.asks,
        permissions: snap.permissions,
        given: snap.given,
        messages: snap.messages,
        refusal: snap.refusal,
        unseenFrom: marks[e.id] ?? null,
        latest: false,
        outcome: outcomeOf(snap.state, snap.summary),
      };
      out.set(e.key, [...(out.get(e.key) ?? []), run]);
    }
    return [...out].map(([key, runs]) => ({ key, runs: runs.map((r, i) => (i === runs.length - 1 ? { ...r, latest: true } : r)) }));
  });

  /** What the Changes view reads, once the page is loaded. */
  readonly changesContext = this.changes.asReadonly();
  /** Turns taken by every run of the build, so the Changes view reads again as the agents work. */
  readonly turns = computed(() => this.log().reduce((n, e) => n + this.snapOf(e.id).events.filter((ev) => ev.type === 'turn').length, 0));
  /** Bash calls finished by every run of the build; each one may have committed a build log row. */
  private readonly bashDone = computed(() =>
    this.log().reduce((n, e) => n + this.snapOf(e.id).events.filter((ev) => ev.type === 'tool.result' && ev.name === 'Bash').length, 0),
  );

  /** The pauses open right now: which run waits, in which repository, on what. */
  private readonly pauses = computed(() => {
    const out: { runId: string; repo: string; id: string; kind: 'answer' | 'approval' }[] = [];
    for (const e of this.log()) {
      const snap = this.snapOf(e.id);
      if (snap.state !== 'awaiting') continue;
      const ask = lastWhere(snap.asks, (a) => a.answers === null);
      const permission = ask === null ? lastWhere(snap.permissions, (p) => p.decided === null) : null;
      if (ask !== null) out.push({ runId: e.id, repo: e.key, id: ask.id, kind: 'answer' });
      else if (permission !== null) out.push({ runId: e.id, repo: e.key, id: permission.id, kind: 'approval' });
    }
    return out;
  });

  /** The runs waiting on the engineer, whichever view is on show. */
  readonly waitingNotices = computed<WaitingItem[]>(() => {
    const now = this.clockSecs();
    const since = this.pendingSince();
    return this.pauses().map((p) => ({ repo: p.repo, kind: p.kind, countdown: null, waited: ms(now - (since[`${p.runId}:${p.id}`] ?? now)) }));
  });

  /** The build log's rows, which say which task made which commit. */
  readonly buildRows = computed<BuildRow[]>(() => (this.status()?.tasks ?? []).flatMap((t) => (t.row === null ? [] : [t.row])));
  /** The task the engineer picked, with its repository; null when the pick is a repository or the review. */
  readonly pickedTask = computed<{ id: string; repo: string; pick: number } | null>(
    () => {
      const pick = this.pick();
      if (pick === null || pick.kind !== 'task') return null;
      const repo = this.status()?.tasks.find((t) => t.id === pick.task)?.repo;
      return repo === undefined ? null : { id: pick.task, repo, pick: this.activity().seq };
    },
    // A status read must not look like a new pick, and picking the same task again must: the Changes view starts over on a new object.
    { equal: (a, b) => a === b || (a !== null && b !== null && a.id === b.id && a.repo === b.repo && a.pick === b.pick) },
  );
  /** The repositories whose run stopped, whose uncommitted files were left by it. */
  readonly stoppedRepos = computed<string[]>(() => this.taskAreas().flatMap((g) => (g.situation.kind === 'stopped' ? [g.repo] : [])));

  /** The notice above the findings: the review document's problems or its older layout; null when it needs none. */
  readonly reviewNotice = computed(() => this.reviewDocNotice());
  /** The latest review's findings, most serious first. */
  readonly findings = computed<Finding[]>(() => this.reviews().at(-1)?.findings ?? []);
  /** The latest review's findings grouped by repository, the way the findings list shows them. */
  readonly findingGroups = computed<FindingGroup[]>(() => {
    const latest = this.reviews().at(-1);
    return groupFindings(latest?.findings ?? [], latest?.repos ?? []);
  });
  /** The latest review as the tasks area reads it; null before any review has findings or words to read. */
  readonly latestReview = computed<{ number: number | null; findings: Finding[]; stale: boolean } | null>(() => {
    const latest = this.reviews().at(-1);
    return latest === undefined ? null : { number: latest.number, findings: this.findings(), stale: this.reviewEntry() === 'stale' };
  });
  /** Earlier reviews, each with the time of the review that replaced it (or its own number and date, from the document), newest first. */
  readonly replaced = computed<ReplacedFindings[]>(() => {
    const all = this.reviews();
    return all
      .slice(0, -1)
      .map((r, i) => ({ at: all[i + 1].at === null ? '' : timeOf(all[i + 1].at!), groups: groupFindings(r.findings, r.repos), ...(r.label === null ? {} : { label: r.label }) }))
      .reverse();
  });
  /** True when the findings are read from the review run's words, the layout before the review document. */
  readonly older = computed(() => this.fromWords() && this.reviews().length > 0);
  /** What the findings list says when the latest review found nothing. */
  readonly emptyText = computed(() => (this.older() ? 'The review found nothing.' : 'Reviewed, nothing found.'));

  /** Whether the review is being read: from the moment the review's run leaves the build until its result is read. */
  private readonly reading = computed(() => this.readingNow());

  constructor() {
    // What the engineer picks and writes in the round dialog is kept while it is open, so leaving the page does not lose it.
    effect(() => {
      const form = this.preview.buildForm();
      const picks = this.dialogMode() === 'round' && form !== null ? picksOf(form.model()) : null;
      const ref = this.ref();
      if (picks !== null && ref !== null) untracked(() => this.drafts.setRound(ref, picks));
    });
    // Whatever the host sets in `loaded` is read at once.
    effect(() => {
      const input = this.loaded();
      if (input !== null) untracked(() => void this.load(input));
    });
    // The rows follow the build log: read it again whenever the backend says the build moved, and whenever a run finishes a Bash call,
    // since an agent logs each task by committing it.
    effect(() => {
      this.buildState();
      this.runRefs();
      this.bashDone();
      untracked(() => void this.refresh());
    });
    // The tasks area follows the build log's status, the repositories listed and the host's live runs and stops: the backend decides it.
    effect(() => {
      const status = this.status();
      const repos = this.groupKeys();
      const state = this.buildState();
      if (status !== null) untracked(() => void this.readBoard(repos, status, state));
    });
    // A run's transcript is linked to its own change as soon as its id shows up in the run's events, whichever change is on show.
    effect(() => {
      const pending = this.followed().flatMap((e) => {
        const transcript = transcriptRunId(this.snapOf(e.id).events);
        return transcript !== null && !this.linkedTranscripts.has(transcript) ? [{ e, transcript }] : [];
      });
      untracked(() => pending.forEach(({ e, transcript }) => void this.linkTranscript(e, transcript)));
    });
    // The sessions follow the runs: read them again whenever a run starts or ends.
    effect(() => {
      this.log();
      this.runRefs();
      untracked(() => void this.readSessions());
    });
    // A picked session that left its repository's list is forgotten, so the page follows the live session again.
    effect(() => {
      const refs = this.sessionRefs();
      const picked = untracked(() => this.pickedSession());
      const gone = Object.entries(picked).filter(([repo, id]) => {
        const list = refs.get(repo);
        return list !== undefined && list.length > 0 && !list.some((r) => r.runId === id);
      });
      if (gone.length === 0) return;
      const next = { ...picked };
      for (const [repo] of gone) delete next[repo];
      untracked(() => this.pickedSession.set(next));
    });
    // An earlier session's transcript is read when it is first shown open.
    effect(() => {
      const open = this.shownSessions().filter((s) => !s.live && s.shown);
      untracked(() => open.forEach((s) => void this.readDetail(s.id)));
    });
    // The clocks run while a build or a run goes.
    effect((onCleanup) => {
      const live = this.active() || this.log().some((e) => RUNNING.includes(this.snapOf(e.id).state));
      if (!live) return;
      const timer = setInterval(() => this.clockSecs.update((n) => n + 1), 1000);
      onCleanup(() => clearInterval(timer));
    });
    // A run's work clock stops while it waits on the engineer; the wait has its own clock.
    effect(() => {
      const t = this.clockSecs();
      const waiting = new Set(this.pauses().map((p) => p.runId));
      untracked(() => this.tick(t, waiting));
    });
    // Each pause keeps the clock reading from when it first showed; a pause that closed is forgotten.
    effect(() => {
      const keys = this.pauses().map((p) => `${p.runId}:${p.id}`);
      untracked(() => {
        const known = this.pendingSince();
        const next: Record<string, number> = {};
        for (const key of keys) next[key] = known[key] ?? this.clockSecs();
        const same = keys.length === Object.keys(known).length && keys.every((k) => k in known);
        if (!same) this.pendingSince.set(next);
      });
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
    this.destroyRef.onDestroy(() => this.detach());
  }

  // --- reading the backend's build

  /** Whether the page still shows the change `ctx` names: an answer read for a change the page has moved away from is dropped. */
  private shows(ctx: BuildContext | null): boolean {
    const now = this.ctx;
    return ctx !== null && now !== null && sameCtx(ctx, now);
  }

  /** The change this page is about, as the backend names it. */
  private ref(): ChangeRef | null {
    const ctx = this.ctx;
    return ctx === null ? null : { workspace: ctx.folder, system: ctx.system, change: ctx.change };
  }

  /** Listen to the build of the page's change and read where it stands now. */
  private async attach(ref: ChangeRef): Promise<void> {
    const id = this.attachId(ref);
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    const ctx = this.ctx!;
    const key = await this.transport.sdlcChangeKey(ref);
    if (this.attached !== id) return;
    const unlisten = await this.transport.onBuildState((event) => {
      if (sameChange(event.change, key) && this.attached === id) this.apply(ctx, event.state, event.reviewWaiting, event.runs);
    });
    if (this.attached !== id) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;
    await this.readHost(ref);
  }

  /** The id the page attaches to a change under. */
  private attachId(ref: ChangeRef): string {
    return `${ref.workspace}|${ref.system}|${ref.change}`;
  }

  private detach(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.attached = null;
  }

  /** Read the host's answer for the change: its build state, the review's wait and the live runs. */
  private async readHost(ref: ChangeRef): Promise<void> {
    try {
      const ctx = this.ctx;
      const [state, waiting, runs] = await Promise.all([this.transport.sdlcBuildState(ref), this.transport.sdlcReviewWaiting(ref), this.transport.sdlcBuildRuns(ref)]);
      // An answer about a change the page has moved away from is not this page's.
      if (ctx === null || this.attached !== this.attachId(ref)) return;
      this.apply(ctx, state, waiting, runs);
    } catch (e) {
      this.toasts.error(`Could not read the build: ${message(e)}`);
    }
  }

  /** Take what the host announced. A review leaving the build starts being read in the same step, so nothing sees a finished build with no review. */
  private apply(ctx: BuildContext, state: BuildState | null, waiting: HeldRepo[], runs: BuildRunRef[]): void {
    const now = this.ctx;
    if (now === null || !sameCtx(ctx, now)) return;
    // A run the backend started is followed from its first event, as a run of this change.
    this.followRuns(ctx, runs);
    const was = this.buildState()?.going.includes(REVIEW) ?? false;
    const is = state?.going.includes(REVIEW) ?? false;
    if (was && !is) this.readingNow.set(true);
    this.buildState.set(state);
    this.reviewHeld.set(waiting);
    this.runRefs.set(runs);
    if (was && !is) void this.reloadReview();
    void this.readChecks();
  }

  /** Every repository's checks as the plugin recorded them: read when the page opens and again whenever the host announces the build moved. */
  private readonly checkViews = signal<RepoCheckView[]>([]);
  private checksReading = false;
  private checksAgain = false;

  /** Reads the checks. A read asked for while one is going runs once more after it, so the page ends on the latest ledger. */
  private async readChecks(): Promise<void> {
    const ref = this.ref();
    if (ref === null) return;
    if (this.checksReading) {
      this.checksAgain = true;
      return;
    }
    this.checksReading = true;
    try {
      do {
        this.checksAgain = false;
        const ctx = this.ctx;
        try {
          const views = await this.transport.sdlcChecksView(this.ref()!);
          if (this.shows(ctx)) this.checkViews.set(views);
        } catch (e) {
          this.toasts.error(`Could not read the checks: ${message(e)}`);
        }
      } while (this.checksAgain);
    } finally {
      this.checksReading = false;
    }
  }

  /**
   * Everything the page shows about a change, given on every load of the change: a page opened on a change with nothing
   * running shows the same sessions, tasks and findings as one that just ran.
   */
  async load(input: BuildPageInput): Promise<void> {
    if (this.taken === input) return;
    this.taken = input;
    const before = this.ctx;
    if (before !== null && !sameCtx(before, input.ctx)) this.forgetChange();
    this.loaded.set(input);
    this.ctx = input.ctx;
    this.status.set(input.status);
    this.reviewDoc.set(input.review);
    this.restorePick();
    this.changes.set({ ref: this.refOf(input.ctx), masterRepo: input.masterRepo });
    await Promise.all([this.readSessions(), this.readChanges(), this.attach(this.ref()!), this.readChecks()]);
    if (!this.shows(input.ctx)) return;
    if (input.status !== null) await this.readBoard(this.groupKeys(), input.status, this.buildState());
    if (!this.shows(input.ctx)) return;
    this.sessionsReadFor.set(input);
    // The findings come from the review document, or from the latest review run's words.
    await this.noteReviewNotice(input.review);
    if (!this.shows(input.ctx)) return;
    if (input.review !== null) this.showReviews(shownReview(input.review, null), null);
    else await this.reviewFromWords(input.ctx);
    await this.readReviewRows();
  }

  /**
   * The page moved to another change: everything it showed about the change before goes. The runs it followed stay followed, each
   * as a run of its own change, so a transcript that shows up later is still linked to that change.
   */
  private forgetChange(): void {
    this.detach();
    if (this.dialogMode() !== null) this.cancelPreview();
    else this.previewSeq++;
    this.chosen.set(null);
    this.startHeld.set([]);
    this.lastForm = null;
    this.refusal.set(null);
    this.buildState.set(null);
    this.reviewHeld.set([]);
    this.runRefs.set([]);
    this.checkViews.set([]);
    this.changedFiles.set(false);
    this.changedFileTotal.set(0);
    this.reviews.set([]);
    this.fromWords.set(false);
    this.reviewDocNotice.set(null);
    this.reviewListing.set(null);
    this.heads.set({});
    this.standing.set(null);
    this.boardSeq++;
    this.board.set([]);
    this.findingPlace.set(null);
    this.readingNow.set(false);
    this.heldStage = null;
    this.sessionsReadFor.set(null);
    this.taskFilter.set('all');
    this.openFolds.set(new Set());
    this.openLow.set(new Set());
    this.marks.set({});
    this.lastOnShow = null;
    this.announced = new Set();
    this.announcement.set('');
  }

  /** Show a repository, a task or the review. */
  choose(pick: Pick): void {
    this.chosen.set({ pick, stage: this.stage(), seq: ++this.pickCount, goTo: null });
    const ref = this.ref();
    if (ref !== null) this.drafts.setPick(ref, pick);
  }

  /**
   * Show again what the engineer had picked when they left the page. A run picked from the running changes (its request still
   * waiting, or already taken and chosen) wins over it, because the engineer asked for that run just now.
   */
  private restorePick(): void {
    const ref = this.ref();
    if (ref === null || this.chosen() !== null) return;
    const asked = this.landing.pending();
    if (asked !== null && asked.system === ref.system && asked.change === ref.change) return;
    const pick = this.drafts.pick(ref);
    if (pick !== null) this.chosen.set({ pick, stage: this.stage(), seq: ++this.pickCount, goTo: null });
  }

  /** The messages typed for the build's runs and not sent, by run id. */
  readonly messageDrafts = computed<Readonly<Record<string, string>>>(() => {
    const ref = this.ref();
    return ref === null ? {} : this.drafts.messages(ref);
  });

  setMessageDraft(runId: string, text: string): void {
    const ref = this.ref();
    if (ref !== null) this.drafts.setMessage(ref, runId, text);
  }

  /** The repositories of the tasks area, in order: the plan's, then the master once it has tasks or runs. */
  private readonly groupKeys = computed<string[]>(() => {
    const status = this.status();
    const master = this.masterName();
    if (status === null) return [];
    return taskGroups(status, master ?? '', master !== null && this.sessionRefs().has(master));
  });

  /** The change's stage as the change page last read it; a page that was never loaded counts as ready to build. */
  private readonly changeStage = computed<'build-ready' | 'build-stopped' | 'build-finished'>(() => {
    const loaded = this.loaded();
    const stage = loaded === null ? null : stageName(loaded.change.offer.stage);
    return stage === 'build-stopped' || stage === 'build-finished' ? stage : 'build-ready';
  });

  /** Which stage the build page is at. */
  readonly stage = computed<BuildStage>(() => {
    const done = (this.loaded()?.done ?? false) && this.changeStage() === 'build-finished';
    const phase = done || !this.started() ? 'none' : this.phase();
    return buildStage({ done, phase, anyStopped: this.stopped().size > 0, stage: this.changeStage() });
  });

  /** The actions the page offers: Cancel build while the backend's build goes, else the build actions the plugin's answer offers. A done change has none. */
  readonly actions = computed<StageAction[]>(() => {
    if (this.stage() === 'done') return [];
    if (this.active()) return ['cancel-build'];
    const offered = this.loaded()?.change.offer.actions ?? [];
    return offered.map((a) => a.action).filter((a) => BUILD_ACTIONS.includes(a));
  });

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
    // A link to the transcript of a run the page follows is that run, which shows live under its own id.
    const followed = new Set(this.log().flatMap((e) => transcriptRunId(this.snapOf(e.id).events) ?? []));
    for (const [key, links] of repoSessions(this.runLinks(), { workspaceId: ctx.workspaceId, system: ctx.system, change: ctx.change })) {
      out.set(key, links.filter((l) => !followed.has(l.run_id)).map((l) => ({ runId: l.run_id, startedAt: l.started_at })));
    }
    for (const e of this.log()) {
      const list = out.get(e.key) ?? [];
      if (!list.some((r) => r.runId === e.id)) out.set(e.key, [...list, { runId: e.id, startedAt: Math.floor(e.at / 1000) }].sort((a, b) => a.startedAt - b.startedAt));
    }
    return out;
  });

  /** Every session by run id: the live ones from the run store, the earlier ones from their transcripts. */
  private readonly sessionById = computed<Map<string, ShownSession>>(() => {
    const live = new Map(this.groups().flatMap((g) => g.runs.map((r) => [r.id, r] as const)));
    const details = this.details();
    const records = this.records();
    const out = new Map<string, ShownSession>();
    for (const refs of this.sessionRefs().values()) {
      for (const ref of refs) {
        const run = live.get(ref.runId);
        if (run !== undefined) {
          const waiting = pendingKind(run.asks, run.permissions) !== 'none';
          // The record of a followed run is filed under its transcript's id.
          const transcript = transcriptRunId(run.events);
          const record = records.find((r) => r.id === ref.runId || r.id === transcript);
          out.set(ref.runId, { ...run, live: true, note: null, shown: false, waiting, tab: tabOf({ live: true, state: run.state, waiting, outcome: run.outcome }, record?.ending ?? null) });
          continue;
        }
        const detail = details[ref.runId];
        const snap = detail === undefined || detail === 'unreadable' ? IDLE : detail;
        const record = records.find((r) => r.id === ref.runId) ?? null;
        const outcome = recordOutcome(record);
        const waiting = pendingKind(snap.asks, snap.permissions) !== 'none';
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
          messages: snap.messages,
          refusal: snap.refusal,
          unseenFrom: null,
          latest: false,
          outcome,
          live: false,
          note: detail === 'unreadable' ? 'Transcript not available' : null,
          shown: false,
          waiting,
          tab: tabOf({ live: false, state: snap.state, waiting, outcome }, record?.ending ?? null),
        });
      }
    }
    return out;
  });

  private readonly sessionPick = computed(() => {
    const pick = this.pick();
    return pick === null ? { sessions: [] as SessionRef[], unknown: false } : sessionsFor(pick, this.status()?.tasks ?? [], this.sessionRefs(), this.activity().taskLinks);
  });

  /** The sessions of the pick, oldest first: the one the engineer picked, else the newest, is in view; every other one waits to be picked. */
  readonly shownSessions = computed<ShownSession[]>(() => {
    const refs = this.sessionPick().sessions;
    const byId = this.sessionById();
    const inView = this.shownFor(this.selected() ?? '', refs.map((r) => ({ id: r.runId })));
    return refs.flatMap((ref, i) => {
      const session = byId.get(ref.runId);
      return session === undefined ? [] : [{ ...session, latest: i === refs.length - 1, shown: ref.runId === inView }];
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
      if (on !== undefined) out.push(on);
      else if (session.live) out.push({ ...session, latest: true, shown: false, offPick: true });
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

  /** The tasks area: a heading per repository from where it stands, and its tasks with what each shows. */
  readonly taskAreas = computed<TaskArea[]>(() => {
    const status = this.status();
    if (status === null) return [];
    return this.groupKeys().map((repo) => {
      // The plugin's report of this repository: the commits that name each task and the ones that name none.
      const reported = this.loaded()?.change.state.tasks?.[repo];
      const going = this.going().has(repo);
      const entry = this.latest(repo);
      // Where the repository stands and what each task shows are the backend's answer; until it is in, nothing is under way.
      const board = this.board().find((r) => r.repo === repo);
      const situation: Situation = board?.situation ?? { kind: 'idle' };
      const heading = situationView(situation, {
        workSecs: entry === null ? null : (this.clocks()[entry.id]?.work ?? 0),
        limitSecs: this.lastForm?.timeoutSecs ?? DEFAULT_BUILD_SECS,
        waitSecs: entry !== null && going && this.isWaiting(entry.id) ? (this.clocks()[entry.id]?.current ?? 0) : null,
        unseen: this.unseenOf(repo),
      });
      return {
        repo,
        situation,
        heading,
        action: going ? 'cancel' : this.stopped().has(repo) ? 'continue' : null,
        tasks: status.tasks.filter((t) => t.repo === repo).map((t) => ({ id: t.id, name: t.name, state: board?.tasks.find((b) => b.id === t.id)?.state ?? NOT_STARTED, commits: reported?.commits?.[t.id] ?? [] })),
        untasked: reported?.untasked ?? [],
      };
    });
  });

  /**
   * What the review counts as, for the tasks area, the findings area and the layout stage: the one place that decides whether the review is in.
   * A review the build just finished and read counts as finished even before the run links catch up with it.
   */
  readonly reviewEntry = computed<ReviewEntry>(() => {
    if (this.started() && this.phase() === 'reviewing') return 'running';
    const ctx = this.ctx;
    if (ctx === null) return 'not run';
    const state = this.standing();
    if (state?.kind === 'current-run' || state?.kind === 'current-document') return 'finished';
    if (state?.kind === 'stale') return 'stale';
    const stage = this.stage();
    const justRead = (stage === 'review-finished' || stage === 'done') && this.reviews().length > 0;
    return justRead ? 'finished' : 'not run';
  });

  /** The change page input whose sessions have been read; the layout stage is settled once it is the loaded one. */
  private readonly sessionsReadFor = signal<BuildPageInput | null>(null);

  /**
   * Where the build stands for the layout, held at its last value while the review is being read. Null while the stage is not settled:
   * the page was loaded but its sessions (run links, records, heads) have not been read yet, so the review cannot be judged.
   */
  readonly layoutStage = computed<LayoutStage | null>(() => {
    const loaded = this.loaded();
    if (loaded !== null && this.sessionsReadFor() !== loaded) return null;
    // A build that finishes must not pass through "stopped" while its review is read, so the last value holds until the read ends.
    if (this.reading() && this.heldStage !== null) return this.heldStage;
    const next = layoutStageOf({ stage: this.stage(), recorded: this.buildRows().length > 0, review: this.reviewEntry() });
    this.heldStage = next;
    return next;
  });
  private heldStage: LayoutStage | null = null;

  /** The task filter on show; it starts at All and is kept for the page visit only. */
  readonly taskFilter = signal<TaskFilter>('all');
  /** The repositories whose fold the engineer opened. */
  readonly openFolds = signal<ReadonlySet<string>>(new Set());

  /** The repositories whose folded low findings the engineer opened. */
  readonly openLow = signal<ReadonlySet<string>>(new Set());

  /** Open a repository's folded low findings, or close them. */
  toggleLow(repo: string): void {
    this.openLow.update((open) => {
      const next = new Set(open);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });
  }

  setTaskFilter(filter: TaskFilter): void {
    this.taskFilter.set(filter);
  }

  /** Open a repository's fold of finished tasks, or close it. */
  toggleFold(repo: string): void {
    this.openFolds.update((open) => {
      const next = new Set(open);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });
  }

  /** Say something through the page's one assertive live region. */
  say(text: string): void {
    this.announcement.set(text);
  }

  /** The panel for repositories other changes hold: who holds each, with a route that opens it. */
  private heldView(title: string, held: HeldRepo[], action: string): HeldView | null {
    if (held.length === 0) return null;
    return { title, action, repos: held.map((h) => ({ repo: h.repo, holder: h.holder.change, link: ['/sdlc', h.holder.system, h.holder.change] })) };
  }

  /** Everything the build page shows, from the members above; the page itself decides nothing. */
  readonly view = computed<BuildPageView>(() => {
    const pick = this.pick();
    const stage = this.stage();
    const areas = this.taskAreas();
    const entry = this.reviewEntry();
    const pickedRepo = pick?.kind === 'repo' ? pick.repo : pick?.kind === 'task' ? this.status()?.tasks.find((t) => t.id === pick.task)?.repo : undefined;
    const hasSessions = [...this.sessionRefs().values()].some((refs) => refs.length > 0);
    const hasChanges = this.changedFiles();
    const findingsArea = this.findingsAreaView();
    const filter = this.taskFilter();
    const checkViews = this.checkViews();
    const openFolds = this.openFolds();
    const pickedTask = pick?.kind === 'task' ? pick.task : null;
    const linesOf = (g: TaskArea): TaskLine[] =>
      g.tasks.map((t) => ({ id: t.id, name: t.name, status: taskStatus(t.state), finished: t.state.kind === 'done', departure: t.state.kind === 'done' ? t.state.departure : null, commits: t.commits }));
    const counts = filterCounts(areas.flatMap(linesOf));
    const pickedDeparture = areas
      .flatMap((g) => g.tasks)
      .flatMap((t) => (t.id === pickedTask && t.state.kind === 'done' && t.state.departure !== null ? [{ task: t.id, text: t.state.departure }] : []))[0] ?? null;
    return {
      stage,
      stageMessage: this.stageMessage(),
      facts: { tasks: this.tasksLabel(), elapsed: this.active() ? hms(this.clockSecs()) : null },
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
        progress: { done: linesOf(g).filter((t) => t.finished).length, total: g.tasks.length },
        list: taskList(linesOf(g), filter, openFolds.has(g.repo), pickedTask),
        checks: checkViews.find((v) => v.repo === g.repo) ?? null,
        tasks: g.tasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: taskStatus(t.state),
          departure: t.state.kind === 'done' ? t.state.departure : null,
          picked: pick?.kind === 'task' && pick.task === t.id,
          commits: t.commits,
        })),
      })),
      filter: { value: filter, counts },
      noDepartures: filter === 'departed' && counts.departed === 0,
      pickedDeparture,
      review: { status: reviewStatus(entry), action: this.reviewAction(), picked: pick?.kind === 'review', ...this.reviewList(entry) },
      pick,
      sessions: this.mountedSessions(),
      sessionTabs: this.shownSessions().slice().reverse(),
      sessionNote: this.sessionNote(),
      stops: areas.flatMap((g) => (g.heading.stopLine === null ? [] : [{ repo: g.repo, reason: g.heading.stopLine }])),
      findingsArea,
      held: this.heldView('This build waits for other changes', this.startHeld(), 'Start build again'),
      findingPlace: this.findingPlace(),
      waiting: this.waitingNotices(),
      announcement: this.announcement(),
      areas: shownAreas({ stage, hasSessions, hasChanges }),
      counts: { files: this.changedFileTotal(), findings: findingsArea.review === null ? 0 : findingsArea.review.findings.length },
    };
  });

  /** What the review's entry offers: stop it while it goes, run it again after it stopped. */
  private reviewAction(): 'cancel' | 'continue' | null {
    if (this.going().has(REVIEW)) return 'cancel';
    return this.stopped().has(REVIEW) ? 'continue' : null;
  }

  /** What the Review group lists: the backend's rows once the review is finished or out of date, with the notice for an out-of-date one. */
  private reviewList(entry: ReviewEntry): Omit<ReviewEntryView, 'status' | 'action' | 'picked'> {
    const listed = this.latestReview() !== null && (entry === 'finished' || entry === 'stale');
    const backend = this.reviewListing();
    const rows: ReviewRowsShown | null =
      !listed || backend === null
        ? null
        : {
            counts: backend.counts,
            total: backend.total,
            groups: backend.groups.map((g) => ({
              repo: g.repo,
              rows: g.rows.map((r) => ({ key: r.key, finding: findingOf(r.finding), summary: r.summary })),
              low: g.low.map((r) => ({ key: r.key, finding: findingOf(r.finding), summary: r.summary })),
            })),
          };
    return { rows, stale: listed && entry === 'stale' ? REVIEW_MISSING_TEXT.stale : null, nothingFound: rows !== null && rows.total === 0, openLow: this.openLow() };
  }

  /** The findings area for the page, from what the review knows. */
  private findingsAreaView(): FindingsAreaShown {
    const review: FindingsView = { notice: this.reviewNotice(), groups: this.findingGroups(), findings: this.findings(), replaced: this.replaced(), older: this.older(), emptyText: this.emptyText() };
    // A commit the plugin finds that names no task is a departure from the plan, listed after its repository's tasks.
    const departures = this.taskAreas().flatMap((g): Departure[] => [
      ...g.tasks.flatMap((t) => (t.state.kind === 'done' && t.state.departure !== null ? [{ repo: g.repo, task: t.id, text: t.state.departure }] : [])),
      ...g.untasked.map((sha) => ({ repo: g.repo, task: null, text: `Commit ${sha.slice(0, 7)} names no task.` })),
    ]);
    const shown = findingsAreaOf({ reading: this.reading(), entry: this.reviewEntry(), review, departures });
    return { ...shown, waiting: this.heldView('The review waits for other changes', this.reviewHeld(), 'Start review again') };
  }

  /** The finding the engineer picked last, for the changed files to show. */
  readonly findingPlace = signal<FindingPlace | null>(null);
  private placeCount = 0;

  /** Ask the changed files to show where a finding is. A finding that names no file shows nothing. */
  showFinding(f: Finding): void {
    if (f.file === undefined) return;
    this.findingPlace.set({ file: f.file, line: f.line ?? null, text: f.text, n: ++this.placeCount, ...(f.repo === undefined ? {} : { repo: f.repo }) });
  }

  /** The change's reference: the backend resolves where it lives, so no path is computed here. */
  private refOf(ctx: BuildContext): ChangeRef {
    return { workspace: ctx.folder, system: ctx.system, change: ctx.change };
  }

  /** The master repository's name as the change page loaded it; null before a load. */
  private masterName(): string | null {
    return this.loaded()?.masterRepo ?? null;
  }

  /** Read the change's run links, task links and run records, and where each repository stands. */
  private async readSessions(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || this.masterName() === null) return;
    try {
      const [links, tasks, records] = await Promise.all([this.transport.sdlcRunLinks(), this.transport.sdlcTaskLinks(), this.transport.listRuns()]);
      this.runLinks.set(links);
      this.taskLinks.set(tasks);
      this.records.set(records);
    } catch (e) {
      this.toasts.error(`Could not read the earlier sessions: ${message(e)}`);
    }
    try {
      const heads = await this.readHeads();
      if (this.shows(ctx)) this.heads.set(heads);
    } catch {
      if (this.shows(ctx)) this.heads.set({});
    }
    await this.readStanding();
  }

  /** Ask the backend whether the latest review covers the current work, from what the page read. A failed ask leaves it unknown. */
  private async readStanding(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || !this.shows(ctx)) return;
    try {
      const standing = await this.transport.sdlcReviewStanding({
        links: this.runLinks(),
        records: this.records(),
        heads: this.heads(),
        scope: { workspaceId: ctx.workspaceId, system: ctx.system, change: ctx.change },
        document: this.reviewDoc(),
        master: this.masterName(),
      });
      if (this.shows(ctx)) this.standing.set(standing);
    } catch {
      if (this.shows(ctx)) this.standing.set(null);
    }
  }

  /** Ask the backend for the tasks area of the repositories the page lists. A newer ask supersedes it. */
  private async readBoard(repos: string[], status: BuildStatus, state: BuildState | null): Promise<void> {
    const ctx = this.ctx;
    const seq = ++this.boardSeq;
    try {
      const board = await this.transport.sdlcBuildBoard(repos, status, state?.going ?? [], state?.stopped ?? {});
      if (seq === this.boardSeq && ctx !== null && this.shows(ctx)) this.board.set(board);
    } catch (e) {
      if (seq === this.boardSeq) this.toasts.error(`Could not read where the build stands: ${message(e)}`);
    }
  }

  /** Where each repository of the change stands now. */
  private readHeads(): Promise<Record<string, string>> {
    const ctx = this.ctx!;
    const repos = [...new Set([this.masterName()!, ...(this.status()?.repos.map((r) => r.repo) ?? [])])];
    return this.transport.sdlcBuildHeads(this.refOf(ctx), repos);
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

  /** The id of the session in view among a repository's sessions, oldest first: the one the engineer picked while it is still listed, else the newest; null with none. */
  private shownFor(repo: string, sessions: readonly { id: string }[]): string | null {
    const picked = this.pickedSession()[repo];
    if (picked !== undefined && sessions.some((s) => s.id === picked)) return picked;
    return sessions.at(-1)?.id ?? null;
  }

  /** The engineer picks a session of a repository to read; picking the newest one goes back to following the live session. */
  pickSession(repo: string, runId: string): void {
    const sessions = repo === this.selected() ? this.sessionPick().sessions : (this.sessionRefs().get(repo) ?? []);
    const next = { ...this.pickedSession() };
    if (sessions.at(-1)?.runId === runId) delete next[repo];
    else next[repo] = runId;
    this.pickedSession.set(next);
  }

  select(name: string): void {
    this.choose(this.pickOf(name));
  }

  private pickOf(name: string): Pick {
    return name === REVIEW ? { kind: 'review' } : { kind: 'repo', repo: name };
  }

  /** A heading of the build page asked to cancel or continue its repository (or the review). */
  repoAction(e: { repo: string; action: 'cancel' | 'continue' }): void {
    this.select(e.repo);
    if (e.action === 'cancel') this.cancelRun();
    else void this.continueRun();
  }

  /** Go to a waiting repository: its Activity, with its open question brought into view and focused. */
  goTo(repo: string): void {
    this.chosen.set({ pick: this.pickOf(repo), stage: this.stage(), seq: ++this.pickCount, goTo: { repo, n: ++this.focusCount } });
    this.tab.set('activity');
  }

  // --- starting, stopping and continuing: the host's commands

  /** Stop every run of the build. */
  cancelBuild(): void {
    const ref = this.ref();
    if (ref !== null) void this.transport.sdlcBuildCancel(ref, null).catch((e: unknown) => this.toasts.error(`Could not cancel the build: ${message(e)}`));
  }

  /** Stop the run of the selected repository (or the review). */
  cancelRun(): void {
    const ref = this.ref();
    const key = this.selected();
    if (ref !== null && key !== null) void this.transport.sdlcBuildCancel(ref, key).catch((e: unknown) => this.toasts.error(`Could not cancel the run: ${message(e)}`));
  }

  /** Start the build the form describes through the backend; what it came to. */
  async startBuild(form: StartForm): Promise<StartKind> {
    const ref = this.ref();
    if (ref === null) return 'couldNotRun';
    this.lastForm = form;
    return this.begin('checking-base', progressLabels.checkingBase(), () => this.transport.sdlcBuildStart(ref, this.withOff(form, this.buildOff())));
  }

  /** Start the held build again, as a fresh start of the same form. */
  async startAgain(): Promise<void> {
    if (this.lastForm !== null) await this.startBuild(this.lastForm);
  }

  /** Start the review that waited for other changes again. */
  async startReviewAgain(): Promise<void> {
    const ref = this.ref();
    if (ref !== null) await this.begin('preparing-build', progressLabels.preparingReview(), () => this.transport.sdlcReviewStart(ref, this.buildOff()));
  }

  /**
   * Run one of the host's slow starts under the page's progress line and tell what it came to: the plugin checks every repository
   * (and prepares each) before anything starts, which takes seconds.
   */
  private async begin(step: ProgressStepId, label: string, call: () => Promise<StartOutcome>): Promise<StartKind> {
    this.progress.begin(step, label, 'build');
    this.preparing.set(true);
    this.stoppedNote.set(null);
    const ctx = this.ctx;
    const unlisten = await this.listenToSteps(ctx);
    let outcome: StartOutcome;
    try {
      outcome = await call();
    } catch (e) {
      this.progress.fail('build');
      this.refuse(ctx, { reason: message(e), problems: [] });
      return 'couldNotRun';
    } finally {
      unlisten();
      this.preparing.set(false);
    }
    if (outcome.kind === 'refused' || outcome.kind === 'failed' || outcome.kind === 'couldNotRun' || outcome.kind === 'stopped') this.progress.fail('build');
    else this.progress.end('build');
    if (this.shows(ctx)) return this.settle(outcome);
    // The page moved to another change while the start ran: what it came to is not shown on that change, it is said once.
    const held = outcome.kind === 'held' ? { reason: 'The build waits for other changes', problems: outcome.held.map((h) => `${h.repo}: ${h.holder.change}`) } : null;
    const refusal = held ?? refusalOf(outcome);
    if (refusal !== null) this.refuse(ctx, refusal);
    if (outcome.kind === 'stopped') this.toasts.info(`${ctx?.change ?? 'The build'}: ${stoppedMessage(outcome.prepared)}`);
    return outcome.kind;
  }

  /** Feed the progress line the label of each step the backend reports for this change's preparation; the returned function stops listening. */
  private async listenToSteps(ctx: BuildContext | null): Promise<() => void> {
    if (ctx === null) return () => undefined;
    try {
      return await this.transport.onStep((event) => {
        if (sameStepChange(event.change, ctx) && (event.kind === 'preparingBuild' || event.kind === 'preparingReview')) this.progress.update(event.progress.label, 'build');
      });
    } catch {
      return () => undefined;
    }
  }

  /** Show why a start did not go on, on the change it was for; a start of a change the page moved away from says it in a toast. */
  private refuse(ctx: BuildContext | null, refusal: StartRefusal): void {
    if (this.shows(ctx)) this.refusal.set(refusal);
    else this.toasts.error([`${ctx?.change ?? 'The build'}: ${refusal.reason}`, ...refusal.problems].join('\n'));
  }

  private settle(outcome: StartOutcome): StartKind {
    switch (outcome.kind) {
      case 'started': {
        this.startHeld.set([]);
        this.refusal.set(null);
        const lines = Object.entries(outcome.uncommitted).flatMap(([repo, files]) => (files ?? []).map((f) => `${repo}: ${f}`));
        if (lines.length > 0) this.toasts.info(`The build goes on over uncommitted files · ${lines.join(' · ')}`);
        const ref = this.ref();
        if (ref !== null) void this.readHost(ref);
        break;
      }
      case 'alreadyRunning':
        this.toasts.error('A build of this change is already running.');
        break;
      case 'held':
        this.startHeld.set(outcome.held);
        break;
      case 'refused':
      case 'failed':
      case 'couldNotRun':
        this.refusal.set(refusalOf(outcome));
        break;
      case 'stopped':
        this.stoppedNote.set(stoppedMessage(outcome.prepared));
        break;
    }
    return outcome.kind;
  }

  closeRefusal(): void {
    this.refusal.set(null);
  }

  /** Which preview is the latest; a preview that another has superseded neither opens nor changes the page. */
  private previewSeq = 0;

  /** The key the build's choices are kept under. */
  private buildKey(): string {
    const ctx = this.ctx!;
    return `${ctx.system}/${ctx.change}`;
  }

  /** The given items the build has switched off, as the host takes them. */
  private buildOff(): string[] {
    return [...(this.givens.build(this.buildKey())?.off ?? [])];
  }

  /** The form with the given items switched off; a form of a build that switched none off is sent as it is. */
  private withOff(form: StartForm, off: readonly string[]): StartForm {
    return off.length === 0 ? form : { ...form, off: [...off] };
  }

  /** What the preview starts from: the session's choices, and the build's. */
  private previewFrom() {
    return { session: this.givens.session(), job: null, build: this.givens.build(this.buildKey())?.off ?? null };
  }

  /** The run-spec of each folder the preview lists, as the backend composes them. */
  private async sections(which: BuildPreviewKind, repo: string | null, form: StartForm): Promise<BuildSectionRequest[]> {
    const from = this.previewFrom();
    const off = [...new Set([...from.session, ...(from.build ?? [])])];
    const sections = await this.transport.sdlcPreviewBuild(this.ref()!, which, repo, this.withOff(form, off));
    return sections.map((s) => ({ title: s.title, repo: s.repo, spec: s.spec, workdir: s.spec.workdir }));
  }

  /**
   * Open the preview of one of the build's starts and, once the engineer confirms, start it through the host. True when the build started.
   * What they confirm is the build's from then on, except for a review started by hand, whose choices are that review's alone.
   */
  async openPreview(which: 'start' | 'continue' | 'review'): Promise<boolean> {
    const ref = this.ref();
    if (ref === null) return false;
    const limit = which === 'review' ? REVIEW_TIMEOUT_SECS : DEFAULT_BUILD_SECS;
    const form: StartForm = { timeoutSecs: this.lastForm?.timeoutSecs ?? limit };
    const kind = { start: 'start', continue: 'continue-all', review: 'manual-review' } as const;
    const title = { start: 'Start build', continue: 'Continue build', review: 'Run review' } as const;
    const seq = ++this.previewSeq;
    this.dialogMode.set(which === 'review' ? null : which);
    let result;
    try {
      const sections = await this.sections(kind[which], null, form);
      if (seq !== this.previewSeq) return false;
      result = await this.preview.openBuild({ title: title[which], kind: kind[which], sections, from: this.previewFrom(), limitSecs: limit });
    } catch (e) {
      if (seq === this.previewSeq) {
        this.toasts.error(`Could not preview the build: ${message(e)}`);
        this.dialogMode.set(null);
      }
      return false;
    }
    if (seq !== this.previewSeq) return false;
    this.dialogMode.set(null);
    if (result === null) return false;
    if (which !== 'review') this.givens.setBuild(this.buildKey(), { off: result.off });
    if (which === 'review') return (await this.begin('preparing-build', progressLabels.preparingReview(), () => this.transport.sdlcReviewStart(ref, [...result.off]))) === 'started';
    return (await this.startBuild({ ...form, timeoutSecs: result.request?.timeoutSecs ?? limit })) === 'started';
  }

  /** Open the round dialog from the backend's offer and, once the engineer confirms the plan it shows, start the round. True when it started. */
  async openRound(): Promise<boolean> {
    const ref = this.ref();
    if (ref === null) return false;
    const seq = ++this.previewSeq;
    let result;
    try {
      const [[offer, backendPicks], view] = await Promise.all([this.transport.sdlcRoundOffer(ref), this.transport.sdlcReviewView(ref)]);
      const picks = this.leftPicks(ref, offer) ?? backendPicks;
      this.roundOffer.set(offer);
      this.roundGroups.set(view.groups);
      this.dialogMode.set('round');
      // The sections list every repository a round may go to; the dialog keeps those the plan starts an agent in.
      const form: StartForm = { timeoutSecs: this.lastForm?.timeoutSecs ?? DEFAULT_BUILD_SECS, rounds: offer.repos.map((repo) => ({ repo, instructions: '', summary: '' })) };
      const sections = await this.sections('round', null, form);
      if (seq !== this.previewSeq) return false;
      result = await this.preview.openBuild({
        title: 'Start round',
        kind: 'round',
        sections,
        from: this.previewFrom(),
        limitSecs: DEFAULT_BUILD_SECS,
        offer,
        picks,
        plan: (p) => this.transport.sdlcRoundPlan(ref, p),
      });
    } catch (e) {
      if (seq === this.previewSeq) {
        this.toasts.error(`Could not preview the round: ${message(e)}`);
        this.closeRound();
      }
      return false;
    }
    if (seq !== this.previewSeq) return false;
    this.closeRound();
    if (result === null || result.plan === null || result.plan.blocked !== null) return false;
    this.givens.setBuild(this.buildKey(), { off: result.off });
    // The round starts exactly the requests the dialog showed, under the limit the engineer set there.
    return (await this.startBuild({ timeoutSecs: result.request?.timeoutSecs ?? DEFAULT_BUILD_SECS, rounds: result.plan.requests })) === 'started';
  }

  /** What the engineer left in the round dialog, kept to what the offer still lists; null when nothing was left. */
  private leftPicks(ref: ChangeRef, offer: RoundOffer): RoundPicks | null {
    const left = this.drafts.round(ref);
    if (left === null) return null;
    const keys = new Set(offer.findings.map((f) => f.key));
    const repos = new Set(offer.repos);
    return {
      picked: left.picked.filter((k) => keys.has(k)),
      assigned: Object.fromEntries(Object.entries(left.assigned).filter(([k, repo]) => keys.has(k) && repo !== undefined && repos.has(repo))),
      notes: Object.fromEntries(Object.entries(left.notes).filter(([repo]) => repos.has(repo))),
    };
  }

  private closeRound(): void {
    const ref = this.ref();
    if (ref !== null) this.drafts.setRound(ref, null);
    this.dialogMode.set(null);
    this.roundOffer.set(null);
    this.roundGroups.set([]);
  }

  /** The preview was cancelled from outside: close whichever build dialog is open. */
  cancelPreview(): void {
    this.previewSeq++;
    this.preview.cancel();
    this.closeRound();
  }

  /**
   * Run the selected, stopped row again, after the engineer sees its preview, pre-set to the build's choices. What the engineer
   * confirms becomes the build's: it is kept for every run after.
   */
  async continueRun(): Promise<void> {
    const ref = this.ref();
    const key = this.selected();
    if (ref === null || key === null) return;
    const form: StartForm = this.lastForm ?? { timeoutSecs: DEFAULT_BUILD_SECS };
    let result;
    try {
      const sections = await this.sections('continue-one', key, form);
      result = await this.preview.openBuild({
        title: key === REVIEW ? 'Continue review' : `Continue ${key}`,
        kind: 'continue-one',
        sections,
        from: this.previewFrom(),
        limitSecs: form.timeoutSecs,
      });
    } catch (e) {
      this.toasts.error(`Could not preview the run: ${message(e)}`);
      return;
    }
    if (result === null) return;
    const choices: BuildChoices = { off: result.off };
    this.givens.setBuild(this.buildKey(), choices);
    await this.begin('preparing-build', key === REVIEW ? progressLabels.preparingReview() : progressLabels.preparingBuild(), () =>
      key === REVIEW ? this.transport.sdlcReviewStart(ref, [...choices.off]) : this.transport.sdlcBuildContinue(ref, key, [...choices.off]),
    );
  }

  answer(runId: string, e: { id: string; answers: string[][] }): void {
    void this.runs.submitAnswer(runId, e.id, e.answers);
  }

  /** Message the agent of one build run. Not `say`, which is the page's live-region announcer. */
  sendMessage(runId: string, text: string): void {
    this.setMessageDraft(runId, '');
    void this.runs.sendMessage(runId, text);
  }

  decide(runId: string, e: { id: string; allow: boolean; message: string | null }): void {
    void this.runs.submitDecision(runId, e.id, e.allow, e.message);
  }

  // --- the runs the backend started

  /** Follow every run the backend names that the page has not seen, and finish with the ones that left the build. */
  private followRuns(ctx: BuildContext, refs: BuildRunRef[]): void {
    const master = this.masterName();
    if (master === null) return;
    const known = new Set(this.followed().map((e) => e.id));
    const repos = [...new Set([master, ...(this.status()?.repos.map((r) => r.repo) ?? [])])];
    for (const ref of refs) {
      if (known.has(ref.run)) continue;
      this.followed.update((l) => [...l, { id: ref.run, key: ref.key, at: Date.now(), ctx, repos }]);
      this.clocks.update((c) => ({ ...c, [ref.run]: { work: 0, paused: 0, current: 0 } }));
      const before = this.status();
      if (before !== null && ref.key !== REVIEW) this.bases.update((b) => ({ ...b, [ref.run]: before }));
      void this.runs.open(ref.run);
    }
  }

  /** Link a run's transcript to the change; a review's link records where each repository stood, which tells whether the review is current. */
  private async linkTranscript(entry: Entry, transcript: string): Promise<void> {
    // The run's own change, never the one on show: the page may have moved since the run started.
    const ctx = entry.ctx;
    if (this.linkedTranscripts.has(transcript)) return;
    this.linkedTranscripts.add(transcript);
    if (this.runLinks().some((l) => l.run_id === transcript)) return;
    let heads: Record<string, string> | undefined;
    if (entry.key === REVIEW) {
      try {
        heads = await this.transport.sdlcBuildHeads(this.refOf(ctx), entry.repos);
      } catch (e) {
        this.toasts.error(`Could not record where each repository stood: ${message(e)}`);
      }
    }
    const link: RunLink = {
      workspace_id: ctx.workspaceId,
      system: ctx.system,
      change: ctx.change,
      stage: entry.key === REVIEW ? REVIEW : `build:${entry.key}`,
      run_id: transcript,
      started_at: Math.floor(entry.at / 1000),
      ...(heads ? { heads } : {}),
    };
    try {
      await this.transport.sdlcLinkRun(link);
      this.runLinks.update((all) => [...all, link]);
    } catch (e) {
      this.toasts.error(`Could not link the run to the change: ${message(e)}`);
    }
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

  private latest(key: string): Entry | null {
    const entries = this.log().filter((e) => e.key === key);
    return entries.at(-1) ?? null;
  }

  private isWaiting(runId: string): boolean {
    return this.pauses().some((p) => p.runId === runId);
  }

  private tick(t: number, waiting: ReadonlySet<string>): void {
    const dt = t - this.lastTick;
    this.lastTick = t;
    if (dt <= 0) return;
    const next: Record<string, Clock> = { ...this.clocks() };
    for (const e of this.followed()) {
      if (!RUNNING.includes(this.snapOf(e.id).state)) continue;
      const c = next[e.id] ?? { work: 0, paused: 0, current: 0 };
      next[e.id] = waiting.has(e.id)
        ? { work: c.work, paused: c.paused + dt, current: c.current + dt }
        : { work: c.work + dt, paused: c.paused, current: 0 };
    }
    this.clocks.set(next);
  }

  /** A run's state, from the run store. */
  private snapOf(id: string): RunSnapshot {
    return this.runs.snapshot(id)();
  }

  private async readStatus(): Promise<BuildStatus> {
    const ctx = this.ctx!;
    return this.transport.sdlcBuildStatus(this.refOf(ctx));
  }

  /** Read whether any repository has changed files, the way the Changes view lists them; a failed read counts as none. */
  private async readChanges(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null || this.masterName() === null) return;
    try {
      const repos = await this.transport.sdlcChangeRepos(this.refOf(ctx));
      const counts = await Promise.all(repos.map((r) => this.transport.sdlcDiffFiles(r.path, 'whole').then((l) => l.files.length, () => 0)));
      if (!this.shows(ctx)) return;
      this.changedFileTotal.set(counts.reduce((sum, n) => sum + n, 0));
      this.changedFiles.set(counts.some((n) => n > 0));
    } catch {
      if (!this.shows(ctx)) return;
      this.changedFileTotal.set(0);
      this.changedFiles.set(false);
    }
  }

  private async refresh(): Promise<void> {
    // A change with no plan has no build log to read.
    if (this.masterName() === null || this.ctx === null || this.loaded()?.status === null) return;
    void this.readChanges();
    const ctx = this.ctx;
    try {
      const status = await this.readStatus();
      if (!this.shows(ctx)) return;
      this.status.set(status);
      await this.readBoard(this.groupKeys(), status, this.buildState());
    } catch (e) {
      this.toasts.error(`Could not read the build log: ${message(e)}`);
    }
  }

  // --- the review

  /** The review the build just finished: read its document, the notice for it and the backend's rows. */
  private async reloadReview(): Promise<void> {
    const ctx = this.ctx;
    if (ctx === null) return;
    try {
      const document = await this.readDocument();
      if (!this.shows(ctx)) return;
      if (document !== undefined) {
        this.reviewDoc.set(document);
        await this.noteReviewNotice(document);
        if (document !== null) this.showReviews(shownReview(document, null), null);
        else await this.reviewFromWords(ctx);
        await this.readReviewRows();
      }
      await this.readSessions();
    } finally {
      this.readingNow.set(false);
    }
  }

  /** The review document of the change, null when it has none, undefined when it cannot be read (reported). */
  private async readDocument(): Promise<ReviewRecord | null | undefined> {
    const ctx = this.ctx;
    if (this.masterName() === null || ctx === null) return undefined;
    try {
      return await this.transport.sdlcReviewRecord(this.refOf(ctx));
    } catch (e) {
      this.toasts.error(`Could not read the review document: ${message(e)}`);
      return undefined;
    }
  }

  /** The Review group's rows, as the backend lists them for the latest review. */
  private async readReviewRows(): Promise<void> {
    const ref = this.ref();
    if (ref === null) return;
    const ctx = this.ctx;
    try {
      const rows = (await this.transport.sdlcReviewView(ref)).rows;
      if (this.shows(ctx)) this.reviewListing.set(rows);
    } catch {
      if (this.shows(ctx)) this.reviewListing.set(null);
    }
  }

  /** Sets the reviews on show from what `shownReview` decided; false when there is no review to show. */
  private showReviews(shown: ReviewShown, at: number | null): boolean {
    if (shown.kind === 'none') return false;
    if (shown.kind === 'words') {
      this.fromWords.set(true);
      this.reviews.update((r) => [...r, { at, label: null, number: null, repos: [], findings: shown.findings }]);
      return true;
    }
    this.fromWords.set(false);
    const labeled = (r: { number: number; reviewedAt: string; repos: string[]; findings: Finding[] }): Review => ({
      at: null,
      label: `Review ${r.number} of ${r.reviewedAt}`,
      number: r.number,
      repos: r.repos,
      findings: r.findings,
    });
    this.reviews.set([...shown.earlier].reverse().map(labeled).concat({ at: null, label: null, number: shown.latest.number, repos: shown.latest.repos, findings: shown.latest.findings }));
    return true;
  }

  /** The notice for the review document, from the one owner of the table; a plugin that cannot be asked about counts as missing. */
  private async noteReviewNotice(document: ReviewRecord | null): Promise<void> {
    if (document === null) {
      this.reviewDocNotice.set(null);
      return;
    }
    const ctx = this.ctx;
    let readiness: Readiness;
    try {
      readiness = await this.transport.sdlcPluginReadiness(ctx!.folder);
    } catch {
      readiness = { kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' };
    }
    if (!this.shows(ctx)) return;
    this.reviewDocNotice.set(shownPart({ layout: document.layout, problems: document.problems }, readiness).notice);
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
      if (!this.shows(ctx)) return;
      this.reviews.set([]);
      this.showReviews(shownReview(null, words), last.started_at * 1000);
    } catch {
      // The earlier review's transcript may be gone; the new review is then simply the only one.
    }
  }
}
