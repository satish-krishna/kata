import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildStart } from '@bindings/BuildStart';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { Decision } from '@bindings/Decision';
import type { RepoFiles } from '@bindings/RepoFiles';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { Offender } from '@bindings/Offender';
import type { PrResult } from '@bindings/PrResult';
import type { PrState } from '@bindings/PrState';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { BuildTile } from '../../ui/stage-stepper';
import type { ChangesContext } from '../changes/changes-view.view-model';
import type { BuildContext } from '../build/build-view.view-model';
import type { BuildDialogMode, BuildStartRequest } from '../../ui/build-dialog';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import {
  actionLabel,
  actionsForChange,
  primaryAction,
  reviewFindings,
  revisits,
  runCounts,
  specFor,
  splitFrontMatter,
  stageLabel,
  type DocsPresent,
  type StageAction,
  type StepCounts,
} from '../../lib/sdlc';
import { REVIEW_MISSING_TEXT, canConfirm, checkLabel, reviewState, type DoneReport, type DoneReview } from '../../lib/sdlc-done';
import { inTauri } from '../../lib/mock';
import { masterPath, masterRepo, productRepos } from '../../lib/sdlc-workspace';

export type ChangeState = 'loading' | 'ready' | 'not-found';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSecs = (): number => Math.floor(Date.now() / 1000);
const BUSY = 'Another task is already running.';
/** The stage steps that mean the plan is accepted. */
const ACCEPTED: ReadonlySet<string> = new Set(['build', 'done']);
const NO_COUNTS: StepCounts = { intent: 0, spec: 0, plan: 0, build: 0, review: 0 };

/** The run actions: which skill each starts, what the lock panel calls it, and what the toast calls the result. */
const RUNS: Partial<Record<StageAction, { kind: 'intent' | 'spec' | 'plan'; title: string; label: string }>> = {
  'continue-intent': { kind: 'intent', title: 'Continuing intent', label: 'Intent' },
  'reopen-intent': { kind: 'intent', title: 'Reopening intent', label: 'Intent' },
  'start-spec': { kind: 'spec', title: 'Starting spec', label: 'Spec' },
  'continue-spec': { kind: 'spec', title: 'Continuing spec', label: 'Spec' },
  'reopen-spec': { kind: 'spec', title: 'Reopening spec', label: 'Spec' },
  'start-plan': { kind: 'plan', title: 'Starting plan', label: 'Plan' },
  'rerun-plan': { kind: 'plan', title: 'Re-running plan', label: 'Plan' },
};

const FILE: Record<Decision, 'intent.md' | 'spec.md' | 'plan.md'> = {
  'accept-intent': 'intent.md',
  'reject-intent': 'intent.md',
  'accept-spec': 'spec.md',
  'accept-plan': 'plan.md',
};
const DONE: Record<Decision, string> = {
  'accept-intent': 'Accepted intent',
  'reject-intent': 'Rejected intent',
  'accept-spec': 'Accepted spec',
  'accept-plan': 'Accepted plan',
};

/** The decision that commits a document already accepted in the working tree, by the stage that says so. */
const ACCEPTED_UNCOMMITTED: Partial<Record<string, Decision>> = {
  'intent-accepted-uncommitted': 'accept-intent',
  'spec-accepted-uncommitted': 'accept-spec',
  'plan-accepted-uncommitted': 'accept-plan',
};

/** Why the plan cannot be built, in the words the plan tab shows. */
const OUT_OF_DATE_BANNER: Record<NonNullable<ChangeInfo['out_of_date']>, string> = {
  'intent-reopened': 'The intent was reopened.',
  'spec-reopened': 'The spec was reopened.',
  'spec-pin': 'This spec was not written from the intent accepted now. Rewrite the spec, then the plan.',
  'plan-pin': 'This plan was not written from the spec accepted now. Rewrite the plan before building.',
  'no-tasks': 'This plan has no tasks. Rewrite the plan before building.',
};
/** The time limit of a review started from the done dialog: the build dialog's default. */
const REVIEW_TIMEOUT_SECS = 2 * 60 * 60;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SUPERSEDED_BANNER = 'The intent was reopened after this plan was written. Rewrite the plan before building.';

/** What the build view starts from: the prepared branches, the time limit, the round if one was asked for, and Kata's checks folder. */
export type BuildHandoff = {
  start: BuildStart;
  timeoutSecs: number;
  round: { instructions: string; repo: string } | null;
  checksDir: string;
  /** True when the engineer confirmed continuing on top of leftovers, so the run is told not to ask again. */
  continueOnLeftovers?: boolean;
};

type DocStem = 'intent' | 'spec' | 'plan';
/** What the stage tiles select: a document, or what the build changed. */
type Tab = DocStem | 'build';

/**
 * The document the page shows for a change: the current stage's, falling back to the last one that exists.
 * A stem, because that is what the backend's `read_doc` accepts; the page shows it as `<stem>.md`.
 */
const isDocStem = (s: string): s is DocStem => s === 'intent' || s === 'spec' || s === 'plan';

function docFor(c: ChangeInfo): DocStem {
  const step = stageLabel(c.stage).step;
  if (step === 'plan' || step === 'build' || step === 'done') return c.plan.exists ? 'plan' : c.spec.exists ? 'spec' : 'intent';
  if (step === 'spec') return c.spec.exists ? 'spec' : 'intent';
  return 'intent';
}

/**
 * One change: its stage, its current document, and every action that moves it on. Runs go through
 * `SdlcRunner`; decisions go straight to the engine. Both end by reading the change again from disk.
 */
@Injectable()
export class ChangePageViewModel {
  private readonly transport = inject(KataTransport);
  private readonly lock = inject(LockStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly system = computed(() => this.params().get('system') ?? '');
  readonly changeName = computed(() => this.params().get('change') ?? '');

  readonly state = signal<ChangeState>('loading');
  readonly workspaces = signal<WorkspaceEntry[]>([]);
  readonly current = computed(() => [...this.workspaces()].sort((a, b) => b.last_opened - a.last_opened)[0] ?? null);
  private readonly scan = signal<WorkspaceScan | null>(null);
  private readonly branches = signal<BranchInfo | null>(null);
  private readonly catalog = signal<CatalogEntry[]>([]);
  private readonly links = signal<RunLink[]>([]);
  private readonly records = signal<RunRecord[]>([]);
  private readonly changeTotal = signal<number | null>(null);
  /** Some repository has the change's branch with something changed, so there is something to look at. */
  private readonly hasBranch = signal(false);
  readonly change = signal<ChangeInfo | null>(null);
  /** The pull request of each touched repository, read at build-finished; empty at any other stage or when GitHub could not be asked. */
  readonly pullRequests = signal<PrState[]>([]);
  /** GitHub could not be asked about the pull requests, so the finished label stays. */
  readonly prCheckFailed = signal(false);
  /** Every touched repository has a pull request: the change is done and has no actions left. */
  readonly done = computed(() => {
    const prs = this.pullRequests();
    return this.change()?.stage === 'build-finished' && prs.length > 0 && prs.every((p) => p.url !== null);
  });
  /** The shown document, raw as it is on disk, or null when the file is missing. */
  readonly doc = signal<string | null>(null);
  /** The document the operator picked from the tiles; null shows the current stage's. Every load clears it. */
  private readonly picked = signal<Tab | null>(null);
  private loadSeq = 0;
  /** Picks have their own sequence, so a pick never cancels a load; a finished load cancels any pick still reading. */
  private pickSeq = 0;

  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly crumbs = computed(() => (this.changeName() === '' ? [] : [this.changeName()]));
  readonly counts = computed(() => {
    const w = this.current();
    const n = this.changeTotal();
    return w && n !== null ? { [w.id]: n } : {};
  });

  readonly shownDoc = computed<Tab>(() => {
    const c = this.change();
    return this.picked() ?? (c ? docFor(c) : 'intent');
  });
  readonly docs = computed<DocsPresent>(() => {
    const c = this.change();
    return { intent: c?.intent.exists ?? false, spec: c?.spec.exists ?? false, plan: c?.plan.exists ?? false };
  });
  /** The Build tile's facts beyond the stage: whether a repository has the change's branch, and the tasks and repositories. */
  readonly buildTile = computed<BuildTile>(() => {
    const repos = this.status()?.repos ?? [];
    return {
      hasBranch: this.hasBranch(),
      done: repos.reduce((n, r) => n + r.finished, 0),
      total: repos.reduce((n, r) => n + r.tasks, 0),
      repos: repos.length,
    };
  });
  /** What the Changes view in the build panel looks at; null until the workspace and master repository are known. */
  readonly changesContext = computed<ChangesContext | null>(() => {
    const w = this.current();
    const master = this.scanMaster();
    return w && master !== null ? { folder: w.folder, masterRepo: master, system: this.system(), change: this.changeName() } : null;
  });
  readonly docName = computed(() => `${this.shownDoc()}.md`);
  readonly stems: readonly DocStem[] = ['intent', 'spec', 'plan'];
  readonly docParts = computed(() => splitFrontMatter(this.doc() ?? ''));
  readonly actions = computed(() => {
    const c = this.change();
    return c && !this.done() ? actionsForChange(c) : [];
  });
  /** What blocks the build, shown above the plan; null when nothing does or another document is shown. */
  readonly planBanner = computed(() => {
    const c = this.change();
    if (c === null) return null;
    // A reopened intent or spec keeps its own stage once a plan exists (R1.5); name it on whichever tab is shown.
    if (c.plan.exists) {
      if (c.stage === 'intent-awaiting' || c.stage === 'intent-in-progress') return OUT_OF_DATE_BANNER['intent-reopened'];
      if (c.stage === 'spec-awaiting') return OUT_OF_DATE_BANNER['spec-reopened'];
    }
    if (this.shownDoc() !== 'plan') return null;
    if (c.stage === 'plan-superseded') return SUPERSEDED_BANNER;
    return c.stage === 'plan-out-of-date' && c.out_of_date !== null ? OUT_OF_DATE_BANNER[c.out_of_date] : null;
  });
  readonly primary = computed(() => primaryAction(this.actions()));
  readonly labelOf = actionLabel;
  readonly runCounts = computed<StepCounts>(() => {
    const w = this.current();
    return w ? runCounts(this.links(), this.records(), w.id, this.system(), this.changeName()) : NO_COUNTS;
  });

  // --- the acceptance confirm
  private readonly pendingDecision = signal<Decision | null>(null);
  readonly confirmPrompt = computed(() => {
    const d = this.pendingDecision();
    if (d === null) return null;
    return `${FILE[d]} has other uncommitted edits; ${d === 'reject-intent' ? 'rejecting' : 'accepting'} commits them too.`;
  });

  // --- the feedback box: a revisit asks what should change before it runs
  private readonly pendingRevisit = signal<StageAction | null>(null);
  /** The label of the action waiting on the feedback box, or null while the box is closed. */
  readonly feedbackFor = computed(() => {
    const a = this.pendingRevisit();
    return a === null ? null : actionLabel(a);
  });

  // --- the build: its dialog, the leftovers confirm, the refusal, and what is handed to the build view
  private readonly status = signal<BuildStatus | null>(null);
  private readonly checksDir = signal<string | null>(null);
  /** The mode of the open build dialog, or null while it is closed. */
  readonly buildMode = signal<BuildDialogMode | null>(null);
  /** The master repository first, then every repository the plan names. */
  readonly buildRepos = computed<string[]>(() => {
    const master = this.scanMaster();
    const planned = (this.status()?.repos ?? []).map((r) => r.repo);
    return [...new Set([...(master === null ? [] : [master]), ...planned])];
  });
  /** The plan's tasks with their build rows, shown under the plan document; empty when there is no plan. */
  readonly buildTasks = computed<TaskStatus[]>(() => this.status()?.tasks ?? []);
  /** Why the build did not start, or null. */
  readonly refusal = signal<string | null>(null);
  private readonly pendingLeftovers = signal<RepoFiles[] | null>(null);
  /** The confirm for continuing on top of the build's own leftovers: one line per repository and file; null while closed. */
  readonly leftoverPrompt = computed(() => {
    const left = this.pendingLeftovers();
    return left === null ? null : { lines: left.flatMap((r) => r.files.map((f) => `${r.repo}: ${f}`)) };
  });
  /** What the build view (T45) starts from; set when a build is prepared and ready. */
  readonly handoff = signal<BuildHandoff | null>(null);
  /** What the build view runs against: the workspace, the system and the change; null until the workspace is known. */
  readonly buildContext = computed<BuildContext | null>(() => {
    const w = this.current();
    return w ? { workspaceId: w.id, folder: w.folder, system: this.system(), change: this.changeName() } : null;
  });
  /** The build view was closed: forget the handoff and read the change again. */
  async closeBuild(): Promise<void> {
    this.handoff.set(null);
    await this.load();
  }
  /** What the dialog asked for, kept so confirming the leftovers prepares the same build again. */
  private asked: BuildStartRequest | null = null;

  /** The operator filled the dialog: prepare the build, never continuing on top of leftovers yet. */
  async submitBuild(req: BuildStartRequest): Promise<void> {
    this.buildMode.set(null);
    this.asked = req;
    await this.prepare(false);
  }

  cancelBuild(): void {
    this.buildMode.set(null);
  }

  /** The operator accepted the leftovers: prepare the same build again, this time continuing on top of them. */
  async confirmLeftovers(): Promise<void> {
    this.pendingLeftovers.set(null);
    if (this.asked !== null) await this.prepare(true);
  }

  cancelLeftovers(): void {
    this.pendingLeftovers.set(null);
    this.asked = null;
  }

  closeRefusal(): void {
    this.refusal.set(null);
  }

  // --- declaring done: Kata's own checks first, then the confirmation
  /** What the done dialog shows; the dialog is open exactly while this is set. */
  readonly doneReport = signal<DoneReport | null>(null);
  private doneRepos: PublishRepo[] = [];
  /** The results of opening the pull requests, shown in a dialog that is open exactly while this is set. */
  readonly prList = signal<PrResult[] | null>(null);

  /** The operator confirmed: open the pull requests. */
  async confirmDone(): Promise<void> {
    const report = this.doneReport();
    if (report === null || !canConfirm(report)) return;
    this.doneReport.set(null);
    await this.publish();
  }

  /** Open the pull requests again after some failed; the ones already open are reused. */
  async retryPublish(): Promise<void> {
    this.prList.set(null);
    await this.publish();
  }

  closePrList(): void {
    this.prList.set(null);
  }

  private async publish(): Promise<void> {
    const w = this.current();
    const master = this.scanMaster();
    if (!w || master === null) return;
    let results: PrResult[] = [];
    const out = await this.lock.runSteps('Opening pull requests', [
      {
        label: 'Open pull requests',
        run: async () => {
          results = await this.transport.sdlcPublish(w.folder, master, this.system(), this.changeName(), this.doneRepos);
          return plural(results.length, 'repository', 'repositories');
        },
      },
    ]);
    if (out === 'done') this.prList.set(results);
    await this.load();
  }

  /** Ask for another round instead of opening the pull requests. */
  doneRound(): void {
    this.doneReport.set(null);
    this.buildMode.set('round');
  }

  /** Start the build view with a review only: every task has a row, so nothing else runs. */
  async doneRunReview(): Promise<void> {
    this.doneReport.set(null);
    this.asked = { timeoutSecs: REVIEW_TIMEOUT_SECS, instructions: null, repo: null };
    await this.prepare(false);
  }

  cancelDone(): void {
    this.doneReport.set(null);
  }

  // --- the lock: Kata's own checks in the overlay, an agent run as the session view
  readonly locked = computed(() => this.lock.active() !== null);
  readonly lockView = computed(() => {
    const v = this.lock.active();
    return v?.kind === 'steps' ? v : null;
  });
  readonly lockElapsed = this.lock.elapsedSecs;
  readonly lockDeadline = this.lock.deadlineSecs;
  /** The agent run that holds the page, live or finished, or null. */
  readonly session = computed(() => {
    const v = this.lock.active();
    const spec = this.lock.spec();
    return v?.kind === 'run' && spec ? { ...v, spec } : null;
  });
  readonly runState = this.runs.state;
  readonly events = this.runs.events;
  readonly summary = this.runs.summary;
  readonly asks = this.runs.asks;
  readonly permissions = this.runs.permissions;
  readonly leftovers = this.runner.leftovers;
  /** The session view's Close waits for the run's after-run work and for any leftover decision. */
  readonly closeBlocked = computed(() => this.runner.settling() || this.runner.leftovers() !== null);

  constructor() {
    // The router reuses this screen when only the change param moves, so the load follows the params, not a snapshot.
    effect(() => {
      this.system();
      this.changeName();
      untracked(() => void this.load());
    });
  }

  /** `?demo=sdlc` starts the scripted spec run once the change has loaded. Browser only, never under Tauri. */
  async startDemo(demo: string | null): Promise<void> {
    if (inTauri() || demo !== 'sdlc') return;
    await this.load();
    if (this.state() === 'ready') await this.runStage('continue-spec');
  }

  // --- actions

  async act(action: StageAction): Promise<void> {
    if (this.refuseWhileLocked()) return;
    switch (action) {
      case 'accept-intent':
      case 'reject-intent':
      case 'accept-spec':
      case 'accept-plan':
        await this.commitDecision(action, false);
        return;
      case 'commit-acceptance':
        await this.commitDecision(ACCEPTED_UNCOMMITTED[this.change()?.stage ?? ''] ?? 'accept-spec', false);
        return;
      case 'start-build':
        this.buildMode.set('start');
        return;
      case 'continue-build':
        this.buildMode.set('continue');
        return;
      case 'another-round':
        this.buildMode.set('round');
        return;
      case 'declare-done':
        await this.declareDone();
        return;
      default:
        // Regenerating an existing document first asks what should change; a first draft just runs.
        if (revisits(action)) this.pendingRevisit.set(action);
        else await this.runStage(action);
    }
  }

  /** The operator confirmed the revisit, with their corrections (blank for none). */
  async runWithFeedback(feedback: string): Promise<void> {
    const action = this.pendingRevisit();
    this.pendingRevisit.set(null);
    if (action === null || this.refuseWhileLocked()) return;
    await this.runStage(action, feedback);
  }

  cancelFeedback(): void {
    this.pendingRevisit.set(null);
  }

  /** The operator confirmed that the file has other edits and the commit should take them too. */
  async confirmDecision(): Promise<void> {
    const d = this.pendingDecision();
    this.pendingDecision.set(null);
    if (d !== null) await this.commitDecision(d, true);
  }

  cancelConfirm(): void {
    this.pendingDecision.set(null);
  }

  /** Show another of the change's documents. A newer pick, or a load that finishes, supersedes one still reading. */
  async showDoc(stem: string): Promise<void> {
    if (stem === 'build') {
      if (this.shownDoc() !== 'build' && this.change() !== null && this.hasBranch()) {
        this.pickSeq++;
        this.picked.set('build');
      }
      return;
    }
    if (!isDocStem(stem) || stem === this.shownDoc() || !this.docs()[stem]) return;
    const master = this.masterDir();
    if (!master) return;
    const seq = ++this.pickSeq;
    const before = this.picked();
    this.picked.set(stem);
    try {
      const text = await this.transport.sdlcReadDoc(master, this.system(), this.changeName(), stem);
      if (seq === this.pickSeq) this.doc.set(text);
    } catch (e) {
      if (seq !== this.pickSeq) return;
      // The doc text is still the one shown before; put the selection back with it, never a name over another's text.
      this.picked.set(before);
      this.toasts.error(`Could not read ${stem}.md: ${message(e)}`);
    }
  }

  // --- navigation and toolbar

  toHome(): Promise<boolean> {
    return this.router.navigate(['/sdlc']);
  }

  /** Switching workspace leaves the change: it belongs to the workspace that was open. */
  async selectWorkspace(id: string): Promise<void> {
    const next = this.workspaces().map((w) => (w.id === id ? { ...w, last_opened: nowSecs() } : w));
    this.workspaces.set(next);
    try {
      await this.transport.sdlcSaveWorkspaces(next);
    } catch (e) {
      this.toasts.error(`Could not save the workspace list: ${message(e)}`);
    }
    await this.toHome();
  }

  switchMode(): Promise<void> {
    return this.modes.switchTo('workbench');
  }

  // --- the lock overlay and leftovers

  cancelLock(): void {
    this.lock.cancel();
  }

  closeSession(): void {
    this.lock.close();
  }

  answer(e: { id: string; answers: string[][] }): void {
    this.lock.answer(e.id, e.answers);
  }

  decide(e: { id: string; allow: boolean; message: string | null }): void {
    this.lock.decide(e.id, e.allow, e.message);
  }

  async discardLeftovers(choices: DiscardChoice[]): Promise<void> {
    await this.runner.discardAll(choices);
    await this.load();
  }

  closeLeftovers(): void {
    this.runner.closeLeftovers();
  }

  // --- internals

  private refuseWhileLocked(): boolean {
    if (this.lock.active() === null) return false;
    this.toasts.error(BUSY);
    return true;
  }

  private readonly scanMaster = computed(() => {
    const scan = this.scan();
    return scan ? masterRepo(scan) : null;
  });

  /**
   * Check that GitHub, the commits, the review and every repository's checks are in order, then show the dialog.
   * A step that refuses is recorded and the steps after it do not run. Nothing throws.
   */
  private async declareDone(): Promise<void> {
    const w = this.current();
    const master = this.scanMaster();
    if (this.change()?.stage !== 'build-finished' || !w || master === null) return;
    const folder = w.folder;
    const system = this.system();
    const change = this.changeName();
    let touched: PublishRepo[];
    try {
      touched = await this.transport.sdlcTouchedRepos(folder, master, system, change);
      for (const r of touched) {
        if ((await this.transport.sdlcDiffFiles(r.path, 'uncommitted')).files.length > 0) {
          this.toasts.error(`Commit or discard the uncommitted edits in ${r.repo} before declaring done.`);
          return;
        }
      }
    } catch (e) {
      this.toasts.error(`Could not read the repositories: ${message(e)}`);
      return;
    }

    const productRepos = (this.status()?.repos ?? []).map((r) => r.repo).filter((r) => r !== master);
    const got = {
      account: null as string | null,
      notReady: null as string | null,
      offenders: [] as Offender[],
      review: { missing: 'none' } as DoneReview,
      plan: null as ChecksPlan | null,
      checksError: null as string | null,
      results: new Map<string, RepoChecks>(),
    };
    const refuse = (e: unknown): never => {
      got.notReady = message(e);
      throw new Error(got.notReady);
    };
    let planLoaded = false;
    const loadPlan = async () => {
      if (planLoaded) return;
      planLoaded = true;
      try {
        got.plan = await this.transport.sdlcChecksLoad(folder, master, system);
      } catch (e) {
        got.checksError = message(e);
      }
    };

    const out = await this.lock.runSteps('Declaring done', [
      {
        label: 'Signed in to GitHub',
        run: async () => {
          try {
            got.account = await this.transport.sdlcGhSignedIn(touched);
          } catch (e) {
            refuse(e);
          }
          return got.account;
        },
      },
      {
        label: 'Origins are GitHub repositories',
        run: async () => {
          try {
            await this.transport.sdlcGhOrigins(touched);
          } catch (e) {
            refuse(e);
          }
          return plural(touched.length, 'repository', 'repositories');
        },
      },
      {
        label: 'Commit rules',
        run: async () => {
          got.offenders = await this.transport.sdlcCommitOffenders(folder, master, system, change);
          return got.offenders.length === 0 ? 'all follow the rules' : plural(got.offenders.length, 'commit breaks', 'commits break') + ' them';
        },
      },
      {
        label: 'Review covers the current work',
        run: async () => {
          const [links, records, heads] = await Promise.all([
            this.transport.sdlcRunLinks(),
            this.transport.listRuns(),
            this.transport.sdlcBuildHeads(folder, productRepos, change),
          ]);
          const state = reviewState(links, records, heads, { workspaceId: w.id, system, change });
          if (state.kind !== 'current') {
            got.review = { missing: state.kind };
            return REVIEW_MISSING_TEXT[state.kind];
          }
          const findings = reviewFindings(await this.transport.loadRun(state.link.run_id));
          got.review = { at: state.link.started_at * 1000, findings };
          return plural(findings.length, 'finding', 'findings');
        },
      },
      ...touched.map((r) => ({
        label: `Checks · ${r.repo}`,
        run: async () => {
          await loadPlan();
          if (got.checksError !== null) return 'not run';
          const result = await this.transport.sdlcRunChecks(folder, master, system, r);
          got.results.set(r.repo, result);
          return checkLabel(result);
        },
      })),
    ]);
    if (out === 'cancelled' || (out === 'failed' && got.notReady === null)) return;

    this.doneRepos = touched;
    this.doneReport.set({
      account: got.account,
      notReady: got.notReady,
      repos: touched.map((r) => ({
        repo: r.repo,
        base: r.base,
        checks: (got.plan?.checks ?? []).filter((c) => c.repo === r.repo),
        result: got.results.get(r.repo) ?? null,
      })),
      offenders: got.offenders,
      departures: this.status()?.departures ?? [],
      review: got.review,
      checksPath: got.plan?.path ?? `${this.checksDir() ?? ''}/${system}.toml`,
      checksError: got.checksError,
    });
  }

  private async prepare(continueWithLeftovers: boolean): Promise<void> {
    const w = this.current();
    const master = this.scanMaster();
    const asked = this.asked;
    const checksDir = this.checksDir();
    if (!w || master === null || asked === null) return;
    if (checksDir === null) {
      this.toasts.error("Could not read Kata's checks folder.");
      return;
    }
    const out = await this.runner.prepareBuild({
      folder: w.folder,
      masterRepo: master,
      system: this.system(),
      change: this.changeName(),
      catalog: this.catalog(),
      continueWithLeftovers,
    });
    switch (out.kind) {
      case 'refused':
        this.asked = null;
        this.refusal.set(out.reason);
        return;
      case 'needs-confirm':
        this.pendingLeftovers.set(out.leftovers);
        return;
      case 'ready':
        this.asked = null;
        this.handoff.set({
          start: out.start,
          timeoutSecs: asked.timeoutSecs,
          round: asked.instructions !== null && asked.repo !== null ? { instructions: asked.instructions, repo: asked.repo } : null,
          checksDir,
          continueOnLeftovers: continueWithLeftovers,
        });
    }
  }

  private masterDir(): string | null {
    const w = this.current();
    const scan = this.scan();
    const repo = scan ? masterRepo(scan) : null;
    return w && repo ? masterPath(w.folder, repo) : null;
  }

  private async commitDecision(decision: Decision, confirmed: boolean): Promise<void> {
    const master = this.masterDir();
    if (master === null) return;
    let out;
    try {
      out = await this.transport.sdlcDecide(master, this.system(), this.changeName(), decision, confirmed);
    } catch (e) {
      this.toasts.error(`Could not record the decision: ${message(e)}`);
      return;
    }
    switch (out.kind) {
      case 'needsConfirm':
        this.pendingDecision.set(decision);
        return;
      case 'gitFailed':
        this.toasts.error(out.stderr.trim() === '' ? 'git refused the commit' : out.stderr);
        break;
      case 'committed':
        this.toasts.success(`${DONE[decision]} · committed`);
        break;
    }
    await this.load();
  }

  private async runStage(action: StageAction, feedback = ''): Promise<void> {
    const run = RUNS[action];
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!run || !workspace || !scan || !master) return;
    let spec;
    try {
      const settings = this.modes.settings() ?? (await this.modes.load());
      spec = specFor(run.kind, action, { folder: workspace.folder, system: this.system(), change: this.changeName(), feedback }, settings, this.catalog());
    } catch (e) {
      this.toasts.error(`Could not prepare the run: ${message(e)}`);
      return;
    }
    await this.runner.run(run.title, spec, {
      workspaceId: workspace.id,
      master,
      productRepos: productRepos(scan),
      link: { system: this.system(), change: this.changeName(), stage: run.kind },
      label: run.label,
    });
    await this.load();
  }

  /** The plan's tasks and rows; a failure is reported and leaves the log empty, never the whole page. */
  private async readStatus(master: string, system: string, name: string): Promise<BuildStatus | null> {
    try {
      return await this.transport.sdlcBuildStatus(master, system, name);
    } catch (e) {
      this.toasts.error(`Could not read the build log: ${message(e)}`);
      return null;
    }
  }

  /** Whether the Changes view has any repository to list. A failed read counts as none, without a toast: the tile just stays closed. */
  private async readHasBranch(folder: string, master: string, system: string, name: string): Promise<boolean> {
    try {
      return (await this.transport.sdlcChangeRepos(folder, master, system, name)).length > 0;
    } catch {
      return false;
    }
  }

  /** The pull request of each touched repository; a failed read is not an error, it just leaves the change unfinished. */
  private async readPullRequests(folder: string, master: string, system: string, name: string): Promise<{ states: PrState[]; failed: boolean }> {
    try {
      const repos = await this.transport.sdlcTouchedRepos(folder, master, system, name);
      return { states: await this.transport.sdlcPullRequests(repos, name), failed: false };
    } catch {
      return { states: [], failed: true };
    }
  }

  private async readChecksDir(): Promise<string | null> {
    try {
      return await this.transport.sdlcChecksDir();
    } catch (e) {
      this.toasts.error(`Could not read Kata's checks folder: ${message(e)}`);
      return null;
    }
  }

  /** Read the change from disk. A newer call supersedes an older one still in flight. */
  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const system = this.system();
    const name = this.changeName();
    const finish = (state: ChangeState, change: ChangeInfo | null, doc: string | null) => {
      if (seq !== this.loadSeq) return;
      this.pickSeq++;
      this.picked.set(null);
      this.change.set(change);
      this.doc.set(doc);
      this.state.set(state);
    };
    let workspaces: WorkspaceEntry[];
    try {
      workspaces = await this.transport.sdlcWorkspaces();
    } catch (e) {
      this.toasts.error(`Could not read the workspace list: ${message(e)}`);
      finish('not-found', null, null);
      return;
    }
    if (seq !== this.loadSeq) return;
    this.workspaces.set(workspaces);
    const w = this.current();
    if (!w) {
      finish('not-found', null, null);
      return;
    }
    try {
      const scan = await this.transport.sdlcScan(w.folder);
      const repo = masterRepo(scan);
      if (repo === null) {
        finish('not-found', null, null);
        return;
      }
      const master = masterPath(w.folder, repo);
      const [branches, changes, links, records, catalog] = await Promise.all([
        this.transport.sdlcBranches(master),
        this.transport.sdlcChanges(master, system),
        this.transport.sdlcRunLinks(),
        this.transport.listRuns(),
        this.transport.catalog(w.folder),
      ]);
      const found = changes.find((c) => c.change === name) ?? null;
      const doc = found ? await this.transport.sdlcReadDoc(master, system, name, docFor(found)) : null;
      const status = found?.plan.exists ? await this.readStatus(master, system, name) : null;
      const checksDir = this.checksDir() ?? (await this.readChecksDir());
      const prs = found?.stage === 'build-finished' ? await this.readPullRequests(w.folder, repo, system, name) : { states: [], failed: false };
      const branch = found !== null && ACCEPTED.has(stageLabel(found.stage).step) && (await this.readHasBranch(w.folder, repo, system, name));
      if (seq !== this.loadSeq) return;
      this.hasBranch.set(branch);
      this.pullRequests.set(prs.states);
      this.prCheckFailed.set(prs.failed);
      this.status.set(status);
      this.checksDir.set(checksDir);
      this.scan.set(scan);
      this.branches.set(branches);
      this.links.set(links);
      this.records.set(records);
      this.catalog.set(catalog);
      this.changeTotal.set(changes.length);
      finish(found ? 'ready' : 'not-found', found, doc);
    } catch (e) {
      this.toasts.error(`Could not read the change: ${message(e)}`);
      finish('not-found', null, null);
    }
  }
}
