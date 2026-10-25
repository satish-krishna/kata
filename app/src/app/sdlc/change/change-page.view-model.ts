import { Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildStart } from '@bindings/BuildStart';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { BuildRow } from '@bindings/BuildRow';
import type { ParsedRequirement } from '@bindings/ParsedRequirement';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';
import type { ReviewRecord } from '@bindings/ReviewRecord';
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
import type { BuildAction } from '@bindings/BuildAction';
import type { Problem } from '@bindings/Problem';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ChangesContext } from '../changes/changes-view.view-model';
import { BuildPageViewModel, type BuildContext } from '../build/build-page.view-model';
import type { BuildDialogMode, BuildStartRequest } from '../../ui/build-dialog';
import type { RunSpec } from '@bindings/RunSpec';
import { GivenStore, type BuildChoices } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import {
  DEFAULT_BUILD_SECS,
  actionLabel,
  actionLabelAt,
  actionsForChange,
  restrictedFor,
  primaryAction,
  reviewFindings,
  parseFrontMatter,
  revisits,
  specFor,
  stageLabel,
  stagePills,
  stageRuns,
  type BuildRun,
  type DocsPresent,
  type StageAction,
  type StagePill,
} from '../../lib/sdlc';
import { shownBuild, shownDocument, type DocNotice, type ReadError, type Shown } from '../../lib/doc-notice';
import { docStatus, recentRuns, usedBy, type DocStatus, type RunRow, type UsedBy } from '../../lib/doc-rail';
import { prNumber } from '../../lib/pull-request';
import { REVIEW_MISSING_TEXT, canConfirm, checkLabel, reviewState, type DoneReport, type DoneReview } from '../../lib/sdlc-done';
import { section } from '../../lib/doc';
import { fullPipelineIdea } from '../../lib/sdlc-fix';
import { inTauri } from '../../lib/mock';
import { taskRecord, withRows, type TaskView } from '../../lib/task-view';
import { shownSection } from '../../lib/sdlc-review';
import { masterPath, masterRepo, productRepos } from '../../lib/sdlc-workspace';

export type ChangeState = 'loading' | 'ready' | 'not-found';

/** The spec and plan tabs' views: the list (requirements, tasks), the one `##` section (Design, Approach), the whole text. */
export type DocView = 'list' | 'section' | 'whole';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSecs = (): number => Math.floor(Date.now() / 1000);
const BUSY = 'Another task is already running.';
/** The stage steps that mean the plan is accepted. */

/** The actions `act` handles itself; every other action starts a stage run. */
type HandledAction =
  | 'accept-intent'
  | 'reject-intent'
  | 'accept-spec'
  | 'accept-plan'
  | 'commit-acceptance'
  | 'start-build'
  | 'continue-build'
  | 'another-round'
  | 'declare-done'
  | 'run-review'
  | 'cancel-build'
  | 'full-pipeline-instead';
/** What recording a decision came to; the full-pipeline hand-over goes on only after 'committed'. */
/** A change by system and folder name. */
type ChangeRef = { system: string; change: string };
/** The toast for a drafted fix that stays open after the new change that replaces it started. */
const fixStays = (fix: ChangeRef, why: string): string => `The new change started, but the fix ${fix.change} could not be closed: ${why}. It stays open.`;
type DecisionOutcome ='committed' | 'needsConfirm' | 'gitFailed' | 'error';
type StageRun = { kind: 'intent' | 'spec' | 'plan' | 'fix'; title: string; label: string };

/** The run actions: which skill each starts, what the lock panel calls it, and what the toast calls the result.
 * Typed over every action `act` does not handle, so a new action with neither a case nor a run does not compile. */
const RUNS: Record<Exclude<StageAction, HandledAction>, StageRun> = {
  'continue-intent': { kind: 'intent', title: 'Continuing intent', label: 'Intent' },
  'reopen-intent': { kind: 'intent', title: 'Reopening intent', label: 'Intent' },
  'start-spec': { kind: 'spec', title: 'Starting spec', label: 'Spec' },
  'continue-spec': { kind: 'spec', title: 'Continuing spec', label: 'Spec' },
  'reopen-spec': { kind: 'spec', title: 'Reopening spec', label: 'Spec' },
  'start-plan': { kind: 'plan', title: 'Starting plan', label: 'Plan' },
  'rerun-plan': { kind: 'plan', title: 'Re-running plan', label: 'Plan' },
  'finish-fix-draft': { kind: 'fix', title: 'Finishing the fix', label: 'Fix' },
  'change-fix': { kind: 'fix', title: 'Changing the fix', label: 'Fix' },
  'reopen-fix': { kind: 'fix', title: 'Reopening the fix', label: 'Fix' },
  'accept-fix': { kind: 'fix', title: 'Accepting the fix', label: 'Fix' },
};
/** The fix runs, which need a plugin that has the light track. */
const FIX_RUNS: readonly StageAction[] = ['finish-fix-draft', 'change-fix', 'reopen-fix', 'accept-fix'];
const NEEDS_LIGHT_TRACK = 'Needs ai-sdlc 0.13.0 or later.';

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
/** A task is built once the build log has a row for it; the record is the one reader of that. */
const isBuilt = (t: { row: BuildRow | null }): boolean => taskRecord(t).kind !== 'unbuilt';
const SUPERSEDED_BANNER = 'The intent was reopened after this plan was written. Rewrite the plan before building.';

/** What the build view starts from: the prepared branches, the time limit, the round if one was asked for, and Kata's checks folder. */
export type BuildHandoff = {
  start: BuildStart;
  timeoutSecs: number;
  round: { instructions: string; repo: string } | null;
  checksDir: string;
  /** The build's choices: the keys switched off, for every run the build starts. */
  choices?: BuildChoices;
  /** The repositories whose leftovers the engineer confirmed continuing on top of: only their first run is told not to ask again. */
  continueOnLeftovers?: string[];
};

type DocStem = 'intent' | 'spec' | 'plan';
/** What the stage tiles select: a document, or what the build changed. */
type Tab = DocStem | 'build';

/**
 * The document the page shows for a change: the current stage's, falling back to the last one that exists.
 * A stem, because that is what the backend's `read_doc` accepts; the page shows it as `<stem>.md`.
 */
const isDocStem = (s: string): s is DocStem => s === 'intent' || s === 'spec' || s === 'plan';

function stemFor(c: ChangeInfo): DocStem {
  const step = stageLabel(c.stage).step;
  if (step === 'plan' || step === 'build' || step === 'done') return c.plan.exists ? 'plan' : c.spec.exists ? 'spec' : 'intent';
  if (step === 'spec') return c.spec.exists ? 'spec' : 'intent';
  return 'intent';
}

/** What the change opens on: its Build tab once the plan is accepted, else the current stage's document. */
function docFor(c: ChangeInfo): Tab {
  const step = stageLabel(c.stage).step;
  return step === 'build' || step === 'done' ? 'build' : stemFor(c);
}

/**
 * One change: its stage, its current document, and every action that moves it on. Runs go through
 * `SdlcRunner`; decisions go straight to the engine. Both end by reading the change again from disk.
 */
@Injectable()
export class ChangePageViewModel {
  private readonly transport = inject(KataTransport);
  private readonly lock = inject(LockStore);
  /** The preview every document run goes through; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  /** The build, which lives as long as this page: it starts here and the page shows it. */
  private readonly build = inject(BuildPageViewModel);
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
  /** The shown spec or plan as the format program read it; null for the other documents, or when the program could not run. */
  private readonly read = signal<ReadResult | ReadError | null>(null);
  /** Whether the ai-sdlc plugin can be used; null until the first load has asked. */
  private readonly readiness = signal<Readiness | null>(null);
  /** The review document as the format program reads it; null when the change has none or it could not be read. */
  private readonly reviewRecord = signal<ReviewRecord | null>(null);
  /** The notice above the open spec or plan; null when it needs none. */
  readonly docNotice = computed<DocNotice | null>(() => this.shown()?.notice ?? null);
  /** What the open spec or plan shows, decided by the one owner of that table; null for the other tabs and before the first load. */
  private readonly shown = computed<Shown | null>(() => {
    const readiness = this.readiness();
    const stem = this.shownDoc();
    return readiness === null || (stem !== 'spec' && stem !== 'plan') ? null : shownDocument(this.read(), readiness);
  });
  /** The notice above the Build tab, from the plan and build log problems and the review document. */
  readonly buildNotice = computed<DocNotice | null>(() => {
    const readiness = this.readiness();
    if (readiness === null || this.shownDoc() !== 'build') return null;
    const status = this.status();
    const review = this.reviewRecord();
    // Every log, the plan's and logs' problems and the review are judged together: no one's label hides another's problems.
    return shownBuild(
      [
        ...(status?.logLayouts ?? []).map((l) => ({ layout: l.layout, problems: [] })),
        { layout: null, problems: status?.problems ?? [] },
        ...(review === null ? [] : [{ layout: review.layout, problems: review.problems }]),
      ],
      readiness,
    ).notice;
  });
  /** The shown spec or plan as the format program read it, unless a notice says the document is shown as plain text. */
  private readonly parsed = computed<ReadResult | null>(() => {
    const read = this.read();
    return this.shown()?.show === 'plain' || read === null || read.kind === 'error' ? null : read;
  });
  /** The document the operator picked from the tiles; null shows the current stage's. Every load clears it. */
  private readonly picked = signal<Tab | null>(null);
  /** The document whose pill the operator just clicked while its text is still being read; null otherwise. */
  readonly pendingDoc = signal<Tab | null>(null);
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
  /** A build or a skill run holds the page: its view stands in for the change's tabs, so nothing here may be clicked. */
  private readonly held = computed(() => this.session() !== null);
  /**
   * The four stage pills for the toolbar; none until the change is read, nor while a build or a skill run holds the
   * page (the build view or the session view stands in for the tabs then).
   */
  readonly pills = computed<StagePill[]>(() => {
    const c = this.change();
    return c === null || this.held() ? [] : stagePills(c.stage, this.done(), this.docs());
  });
  /** The pull requests that have an address, for the toolbar's links; none while a build or a skill run holds the page. */
  readonly pullLinks = computed(() =>
    this.held()
      ? []
      : this.pullRequests().flatMap((p) => {
          if (p.url === null) return [];
          const number = prNumber(p.url);
          return [{ repo: p.repo, url: p.url, number, label: number === null ? p.repo : `${p.repo} #${number}` }];
        }),
  );
  /** The master repository's branch, unless it is the change's own branch, which the pills already imply. */
  readonly branchChip = computed(() => {
    const branch = this.masterBranch();
    return branch === `change/${this.changeName()}` ? null : branch;
  });
  /** What the Changes view in the build panel looks at; null until the workspace and master repository are known. */
  readonly changesContext = computed<ChangesContext | null>(() => {
    const w = this.current();
    const master = this.scanMaster();
    return w && master !== null ? { folder: w.folder, masterRepo: master, system: this.system(), change: this.changeName() } : null;
  });
  readonly docName = computed(() => `${this.shownDoc()}.md`);
  readonly stems: readonly DocStem[] = ['intent', 'spec', 'plan'];
  /** The shown document split into its front matter fields and the text under them. */
  readonly docParts = computed(() => parseFrontMatter(this.doc() ?? ''));
  /** The actions on show: the build page's for a change at the build step, whatever tab is shown, else the change's own. A done change has none. */
  readonly actions = computed(() => {
    const c = this.change();
    if (c === null || this.done()) return [];
    if (stageLabel(c.stage).step !== 'build') return actionsForChange(c);
    return [...this.build.actions(), ...this.barExtras().map((e) => e.action)];
  });
  /**
   * The actions the build page's bar adds after its own: the build page has no way back to the fix's documents, so a fix's
   * list contributes the one that reopens it. Each carries whether its button is off and why.
   */
  readonly barExtras = computed(() => {
    const c = this.change();
    if (c === null || this.done() || c.track !== 'fix' || stageLabel(c.stage).step !== 'build') return [];
    return actionsForChange(c)
      .filter((a) => a === 'reopen-fix')
      .map((action) => ({ action, disabled: this.disabledFor(action), title: this.titleFor(action) }));
  });
  /** What blocks the build, shown above the plan; null when nothing does or another document is shown. */
  readonly planBanner = computed(() => {
    const c = this.change();
    if (c === null) return null;
    // A reopened intent or spec keeps its own stage once a plan exists (R1.5); name it on whichever tab is shown.
    // A superseded plan must also be rewritten once the document is accepted again (R1.3), so say so now.
    if (c.plan.exists) {
      const rewrite = c.plan.status === 'superseded' ? ' The plan must be rewritten first.' : '';
      if (c.stage === 'intent-awaiting' || c.stage === 'intent-in-progress') return OUT_OF_DATE_BANNER['intent-reopened'] + rewrite;
      if (c.stage === 'spec-awaiting') return OUT_OF_DATE_BANNER['spec-reopened'] + rewrite;
    }
    if (this.shownDoc() !== 'plan') return null;
    if (c.stage === 'plan-superseded') return SUPERSEDED_BANNER;
    return c.stage === 'plan-out-of-date' && c.out_of_date !== null ? OUT_OF_DATE_BANNER[c.out_of_date] : null;
  });
  readonly primary = computed(() => primaryAction(this.actions()));
  /** An action's label at the change's stage: accepting a fix whose acceptance stopped reads differently. */
  labelOf(action: StageAction): string {
    const c = this.change();
    return c === null ? actionLabel(action) : actionLabelAt(action, c.stage);
  }
  /** Whether an action's button is off: the lock holds it, or it is a fix run the plugin on this machine cannot do. */
  disabledFor(action: StageAction): boolean {
    return this.locked() || this.needsLightTrack(action);
  }
  /** Why a fix run is unavailable; null for any other action and while it is available. */
  titleFor(action: StageAction): string | null {
    return this.needsLightTrack(action) ? NEEDS_LIGHT_TRACK : null;
  }
  private needsLightTrack(action: StageAction): boolean {
    return FIX_RUNS.includes(action) && !this.lightTrack();
  }
  /** The front matter fields the rail shows: all but the status, which the strip says in words. */
  readonly railFields = computed(() => this.docParts().fields.filter(([key]) => key !== 'status'));
  /**
   * What the strip says about the open document: its status. The Build tab has none: the Build pill already says where
   * the build stands, and a second wording of it beside the pill is how "Build · done" ended up next to "Done · pull
   * requests open". The strip says the build's facts there instead.
   */
  readonly stripStatus = computed<DocStatus | null>(() => {
    if (this.change() === null || this.shownDoc() === 'build') return null;
    return docStatus(this.docParts().fields.find(([key]) => key === 'status')?.[1]);
  });
  /** The page strip belongs to the document tabs; the Build tab has none, its facts and actions sit in the Changes view strip. */
  readonly stripShown = computed(() => this.shownDoc() !== 'build');
  /** The document built from the open one; none on the plan and the Build tab. */
  readonly usedBy = computed<UsedBy | null>(() => {
    const c = this.change();
    const stem = this.shownDoc();
    return c === null || stem === 'build' ? null : usedBy(stem, c);
  });
  /** The latest runs of the open document's stage for the rail, and how many the stage has had. */
  readonly railRuns = computed<{ rows: RunRow[]; total: number }>(() => {
    const w = this.current();
    const stem = this.shownDoc();
    if (w === null || stem === 'build') return { rows: [], total: 0 };
    const runs = stageRuns(this.links(), this.records(), w.id, this.system(), this.changeName(), stem);
    return recentRuns(runs, stem.charAt(0).toUpperCase() + stem.slice(1));
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
    return a === null ? null : this.labelOf(a);
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
  /** The plan's tasks with their build rows, for the plan tab's Tasks view; empty when there is no plan. */
  readonly buildTasks = computed(() => this.status()?.tasks ?? []);
  // --- the spec and plan views: which one is shown and what is picked in it; all of it starts over with the tab or the change
  private readonly view = linkedSignal<DocView | null>(() => {
    this.shownDoc();
    this.changeName();
    return null;
  });
  private readonly requirementPick = linkedSignal<string | null>(() => {
    this.shownDoc();
    this.changeName();
    return null;
  });
  private readonly taskPick = linkedSignal<string | null>(() => {
    this.shownDoc();
    this.changeName();
    return null;
  });
  /** The spec's requirements while the spec tab is open. */
  readonly requirementList = computed<ParsedRequirement[]>(() => {
    const read = this.parsed();
    return this.shownDoc() === 'spec' && read?.kind === 'spec' ? read.document.requirements : [];
  });
  /** The requirement shown on the right: the picked one, else the first. */
  readonly pickedRequirement = computed<ParsedRequirement | null>(() => {
    const all = this.requirementList();
    return all.find((r) => r.id === this.requirementPick()) ?? all[0] ?? null;
  });
  /** The plan's tasks while the plan tab is open, each with the build log row that records it. */
  readonly taskList = computed<TaskView[]>(() => {
    const read = this.parsed();
    return this.shownDoc() === 'plan' && read?.kind === 'plan' ? withRows(read.document.tasks, this.buildTasks()) : [];
  });
  /** The task shown in the middle: the picked one, else the first that is not built, else the first. */
  readonly pickedTask = computed<TaskView | null>(() => {
    const all = this.taskList();
    return all.find((t) => t.id === this.taskPick()) ?? all.find((t) => !isBuilt(t)) ?? all[0] ?? null;
  });
  /** The open tab has a list view: a spec with requirements, a plan with tasks. */
  private readonly hasList = computed(() => {
    const stem = this.shownDoc();
    return stem === 'spec' ? this.requirementList().length > 0 : stem === 'plan' && this.taskList().length > 0;
  });
  /** The strip's toggle for the open tab; none on the intent and the Build tab, nor when there is no list to show. */
  readonly viewOptions = computed<{ value: DocView; label: string }[]>(() => {
    if (!this.hasList()) return [];
    if (this.shownDoc() === 'spec') {
      return [{ value: 'list', label: `Requirements · ${this.requirementList().length}` }, { value: 'section', label: 'Design' }, { value: 'whole', label: 'Whole document' }];
    }
    const built = this.taskList().filter(isBuilt).length;
    return [{ value: 'list', label: `Tasks · ${built}/${this.taskList().length} built` }, { value: 'section', label: 'Approach' }, { value: 'whole', label: 'Whole document' }];
  });
  readonly viewLabel = computed(() => (this.shownDoc() === 'spec' ? 'Spec view' : 'Plan view'));
  readonly shownView = computed<DocView>(() => (this.hasList() ? (this.view() ?? 'list') : 'whole'));
  /** The `##` section the section view shows, or null when the document has none by that name. */
  readonly sectionText = computed(() => section(this.docParts().body, this.sectionName()));
  /** The name of that section: Design in a spec, Approach in a plan. */
  readonly sectionName = computed(() => (this.shownDoc() === 'spec' ? 'Design' : 'Approach'));
  /** What the document layout shows: the section in the section view, else the whole text; null for a missing section. */
  readonly layoutBody = computed(() => (this.shownView() === 'section' ? this.sectionText() : this.docParts().body));

  setView(view: DocView): void {
    this.view.set(view);
  }

  pickRequirement(id: string): void {
    this.requirementPick.set(id);
  }

  pickTask(id: string): void {
    this.taskPick.set(id);
  }

  /**
   * Open a requirement from a task's text on the Spec tab, in its Requirements view. `R7.7` opens R7. An id the spec
   * does not have opens the whole document instead of quietly showing some other requirement.
   */
  async openRequirement(ref: string): Promise<void> {
    await this.showDoc('spec');
    if (this.shownDoc() !== 'spec') return;
    const id = ref.split('.')[0];
    if (this.requirementList().some((r) => r.id === id)) {
      this.requirementPick.set(id);
      this.view.set('list');
    } else {
      this.view.set('whole');
    }
  }

  /** Why the build did not start, or null. */
  readonly refusal = signal<string | null>(null);
  /** What the check found in the plan or a build log, when that is why the build did not start. */
  readonly refusalProblems = signal<Problem[]>([]);
  private readonly pendingLeftovers = signal<RepoFiles[] | null>(null);
  /** The confirm for continuing on top of the build's own leftovers: one line per repository and file; null while closed. */
  readonly leftoverPrompt = computed(() => {
    const left = this.pendingLeftovers();
    return left === null ? null : { lines: left.flatMap((r) => r.files.map((f) => `${r.repo}: ${f}`)) };
  });
  /** What the build view runs against: the workspace, the system and the change; null until the workspace is known. */
  readonly buildContext = computed<BuildContext | null>(() => {
    const w = this.current();
    if (!w) return null;
    const scan = this.scan();
    const master = scan ? masterRepo(scan) : null;
    const system = this.system();
    const systemRepos = (scan?.marker?.systems[system]?.repos ?? []).filter((r) => r !== master);
    return { workspaceId: w.id, folder: w.folder, system, change: this.changeName(), systemRepos };
  });
  /** What the preview asked for, kept so confirming the leftovers prepares the same build again. */
  private asked: BuildStartRequest | null = null;
  /** The build's choices that go with `asked`. */
  private askedChoices: BuildChoices = { off: new Set() };
  /** Which build preview is the current one; a preview that is no longer current neither opens nor changes the page. */
  private buildSeq = 0;
  /** What the engineer asked for, kept with `asked`. */
  private askedAction: BuildAction = 'start';

  /** The key the build's choices are kept under. */
  private buildKey(): string {
    return `${this.system()}/${this.changeName()}`;
  }

  /** The build's request is in: prepare the build, never continuing on top of leftovers yet. */
  async submitBuild(req: BuildStartRequest, choices?: BuildChoices, action?: BuildAction): Promise<void> {
    await this.beginBuild(req, action ?? this.buildMode() ?? 'start', choices ?? { off: this.givens.build(this.buildKey())?.off ?? new Set() });
  }

  private async beginBuild(req: BuildStartRequest, action: BuildAction, choices: BuildChoices): Promise<void> {
    this.askedAction = action;
    this.buildMode.set(null);
    this.asked = req;
    this.askedChoices = choices;
    await this.prepare(false);
  }

  cancelBuild(): void {
    this.buildSeq++;
    this.buildMode.set(null);
    this.preview.cancel();
  }

  /**
   * Open the build's preview, pre-set to the build's choices (the session's when it has none yet). A preview is
   * never awaited by its caller: the engineer answers it. What they confirm is the build's from then on, except for a
   * review started by hand, whose choices are that review's alone.
   */
  private openBuildPreview(which: 'start' | 'continue' | 'round' | 'review'): void {
    this.buildMode.set(which === 'review' ? null : which);
    void this.previewBuild(which);
  }

  private async previewBuild(which: 'start' | 'continue' | 'round' | 'review'): Promise<void> {
    const seq = ++this.buildSeq;
    const w = this.current();
    const master = this.scanMaster();
    const context = this.buildContext();
    const checksDir = this.checksDir();
    const stale = () => seq !== this.buildSeq;
    const giveUp = () => {
      if (!stale()) this.cancelBuild();
    };
    if (!w || master === null || context === null) return giveUp();
    if (checksDir === null) {
      this.toasts.error("Could not read Kata's checks folder.");
      return giveUp();
    }
    const kind = { start: 'start', continue: 'continue-all', round: 'round', review: 'manual-review' } as const;
    const titles = { start: 'Start build', continue: 'Continue build', round: 'Start round', review: 'Run review' } as const;
    const actions: Record<typeof which, BuildAction> = { start: 'start', continue: 'continue', round: 'round', review: 'round' };
    const limit = which === 'review' ? REVIEW_TIMEOUT_SECS : DEFAULT_BUILD_SECS;
    let result;
    try {
      const settings = this.modes.settings() ?? (await this.modes.load());
      const sectionFor = (repo: string | null) => {
        const run: BuildRun = {
          target: repo === null ? 'review' : { repo },
          timeoutSecs: limit,
          instructions: null,
          workspaceFolder: w.folder,
          masterRepo: master,
          systemRepos: context.systemRepos,
          checksDir,
          continueOnLeftovers: false,
        };
        const spec = specFor('build', null, { folder: w.folder, system: context.system, change: context.change }, settings, [], run);
        return { title: repo ?? 'Review', repo, spec, workdir: spec.workdir };
      };
      const status = this.status()?.repos ?? [];
      const planned = status.map((r) => r.repo).filter((r) => r !== master);
      const unfinished = status.filter((r) => r.repo !== master && r.state.kind !== 'done').map((r) => r.repo);
      const repos = { start: planned, continue: unfinished.length > 0 ? unfinished : planned, round: this.buildRepos(), review: [] as string[] }[which];
      const sections = [...repos.map((r) => sectionFor(r)), ...(which === 'round' ? [] : [sectionFor(null)])];
      if (stale()) return;
      result = await this.preview.openBuild({
        title: titles[which],
        kind: kind[which],
        sections,
        from: { session: this.givens.session(), job: null, build: this.givens.build(this.buildKey())?.off ?? null },
        limitSecs: limit,
      });
    } catch (e) {
      this.toasts.error(`Could not preview the build: ${message(e)}`);
      return giveUp();
    }
    if (result === null || stale()) return giveUp();
    const choices: BuildChoices = { off: result.off };
    if (which !== 'review') this.givens.setBuild(this.buildKey(), choices);
    await this.submitBuild(result.request ?? { timeoutSecs: limit, instructions: null, repo: null }, choices, actions[which]);
  }

  /** The operator accepted the leftovers: prepare the same build again, this time continuing on top of them. */
  async confirmLeftovers(): Promise<void> {
    const confirmed = (this.pendingLeftovers() ?? []).map((r) => r.repo);
    this.pendingLeftovers.set(null);
    if (this.asked !== null) await this.prepare(true, confirmed);
  }

  cancelLeftovers(): void {
    this.pendingLeftovers.set(null);
    this.asked = null;
  }

  closeRefusal(): void {
    this.refusal.set(null);
    this.refusalProblems.set([]);
  }

  // --- declaring done: Kata's own checks first, then the confirmation
  /** What the done dialog shows; the dialog is open exactly while this is set. */
  readonly doneReport = signal<DoneReport | null>(null);
  /** The engineer's word, in the done dialog, that the pull requests open with the high-severity findings unresolved. */
  readonly doneAcknowledged = signal(false);
  private doneRepos: PublishRepo[] = [];
  /** The results of opening the pull requests, shown in a dialog that is open exactly while this is set. */
  readonly prList = signal<PrResult[] | null>(null);

  /** The operator confirmed: open the pull requests. */
  async confirmDone(): Promise<void> {
    const report = this.doneReport();
    if (report === null || !canConfirm(report, this.doneAcknowledged())) return;
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
    this.openBuildPreview('round');
  }

  /** Open the review's preview; Start run hands the build view a review only: every task has a row, so nothing else runs. */
  async doneRunReview(): Promise<void> {
    this.doneReport.set(null);
    this.openBuildPreview('review');
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
  readonly given = this.runs.given;
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
    // The build page gives the lock back when the build ends or stops; the change is read again then, so its stage, pill and actions follow it.
    effect(() => {
      const building = this.lock.active()?.kind === 'build';
      untracked(() => {
        const ended = this.wasBuilding && !building;
        this.wasBuilding = building;
        if (ended) void this.load();
      });
    });
  }

  /** Whether the lock was held for a build the last time it changed. */
  private wasBuilding = false;

  /** `?demo=sdlc` starts the scripted spec run once the change has loaded. Browser only, never under Tauri. */
  async startDemo(demo: string | null): Promise<void> {
    if (inTauri() || demo !== 'sdlc') return;
    await this.load();
    if (this.state() === 'ready') await this.runStage('continue-spec');
  }

  // --- actions

  async act(action: StageAction): Promise<void> {
    // The build holds the lock it runs under; cancelling it is the one action that is always allowed.
    if (action !== 'cancel-build' && this.refuseWhileLocked()) return;
    if (this.needsLightTrack(action)) {
      this.toasts.error(NEEDS_LIGHT_TRACK);
      return;
    }
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
        this.openBuildPreview('start');
        return;
      case 'continue-build':
        this.openBuildPreview('continue');
        return;
      case 'another-round':
        this.openBuildPreview('round');
        return;
      case 'run-review':
        await this.doneRunReview();
        return;
      case 'declare-done':
        await this.declareDone();
        return;
      case 'cancel-build':
        this.build.cancelBuild();
        return;
      case 'full-pipeline-instead':
        await this.openFullPipeline();
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
    const fix = this.pendingFix;
    this.pendingFix = null;
    if (d === null) return;
    await this.commitDecision(d, true, fix ?? undefined);
  }

  cancelConfirm(): void {
    this.pendingDecision.set(null);
    const fix = this.pendingFix;
    this.pendingFix = null;
    if (fix !== null) this.toasts.error(fixStays(fix, 'its other edits were not committed'));
  }

  // --- taking the full pipeline instead of a drafted fix

  readonly pipelineOpen = signal(false);
  readonly pipelineIdea = signal('');
  readonly pipelineNote = computed(() => `This closes the drafted fix ${this.changeName()}.`);
  readonly pipelineSystems = computed(() => [this.system()]);
  /** Whether the plugin on this machine can triage a change. */
  readonly lightTrack = computed(() => {
    const r = this.readiness();
    return r !== null && r.kind === 'ready' && r.lightTrack;
  });
  /** The fix whose rejection waits on the other-edits confirm, after its replacement opened; null when none does. */
  private pendingFix: ChangeRef | null = null;

  /** Read the fix's intent and open New change on the full pipeline with the fix as its description. */
  private async openFullPipeline(): Promise<void> {
    const master = this.masterDir();
    if (master === null) return;
    try {
      const text = await this.transport.sdlcReadDoc(master, this.system(), this.changeName(), 'intent');
      this.pipelineIdea.set(fullPipelineIdea(text ?? ''));
    } catch (e) {
      this.toasts.error(`Could not read the fix: ${message(e)}`);
      return;
    }
    this.pipelineOpen.set(true);
  }

  closePipeline(): void {
    this.pipelineOpen.set(false);
  }

  /**
   * Start the new change, and close the fix only once it opened (R7.1). Any other outcome leaves the fix as it was:
   * the runner has already said why for a refused or stopped start and for a run that made no change, so only an
   * error thrown here gets a toast. The dialog's Start is the engineer's confirmation that the fix will close.
   */
  async startPipeline(system: string, idea: string): Promise<void> {
    this.pipelineOpen.set(false);
    const fix = { system: this.system(), change: this.changeName() };
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    let outcome;
    try {
      outcome = await this.runner.newChange({ workspace, master, productRepos: productRepos(scan) }, system, idea, 'full', (spec) => this.confirmRun(spec));
    } catch (e) {
      this.toasts.error(`Could not start the change: ${message(e)}`);
      return;
    }
    if (outcome.kind !== 'opened') return;
    // The page may already show the new change, so the rejection names the fix it belongs to.
    await this.commitDecision('reject-intent', false, fix);
  }

  /** The preview a run goes through; null when it was cancelled or could not be opened. */
  private async confirmRun(spec: RunSpec): Promise<RunSpec | null> {
    try {
      return await this.preview.open({ spec, mode: 'sdlc', workdir: spec.workdir, from: { session: this.givens.session(), job: null, build: null } });
    } catch (e) {
      this.toasts.error(`Could not preview the run: ${message(e)}`);
      return null;
    }
  }

  /** Show another of the change's documents. A newer pick, or a load that finishes, supersedes one still reading. */
  async showDoc(stem: string): Promise<void> {
    if (stem === 'build') {
      // The last click wins here too: a click on Build, even when it is already shown, ends a read still pending for another tab.
      this.pickSeq++;
      this.pendingDoc.set(null);
      if (this.shownDoc() !== 'build' && this.change() !== null) this.picked.set('build');
      return;
    }
    if (!isDocStem(stem) || !this.docs()[stem]) return;
    // The last click wins: a click back on the tab already shown also ends a read still pending for another tab.
    const seq = ++this.pickSeq;
    if (stem === this.shownDoc()) {
      this.pendingDoc.set(null);
      return;
    }
    const master = this.masterDir();
    if (!master) {
      this.pendingDoc.set(null);
      return;
    }
    // The spartan tabs move their own selection on a click, so the pill the operator clicked is held here until the text is read or the read fails; the tabs follow it.
    this.pendingDoc.set(stem);
    try {
      const text = await this.transport.sdlcReadDoc(master, this.system(), this.changeName(), stem);
      const read = await this.readParsed(master, this.system(), this.changeName(), stem);
      // The tab and its text change together, once the text is here, so no tab ever shows another document's text.
      if (seq !== this.pickSeq) return;
      this.doc.set(text);
      this.read.set(read);
      this.picked.set(stem);
      this.pendingDoc.set(null);
    } catch (e) {
      if (seq !== this.pickSeq) return;
      this.pendingDoc.set(null);
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
            this.transport.sdlcBuildHeads(folder, [master, ...productRepos], change),
          ]);
          // The review document decides when the change has one; the review run's exit code and words only when it has not.
          const document = await this.transport.sdlcReviewRecord(masterPath(folder, master), system, change);
          const state = reviewState(links, records, heads, { workspaceId: w.id, system, change }, document, master);
          if (state.kind === 'current-document') {
            const latest = shownSection(state.review);
            got.review = { at: latest.reviewedAt, findings: latest.findings };
            return latest.findings.length === 0 ? 'reviewed, nothing found' : plural(latest.findings.length, 'finding', 'findings');
          }
          if (state.kind !== 'current') {
            got.review = { missing: state.kind };
            return REVIEW_MISSING_TEXT[state.kind];
          }
          const findings = reviewFindings(await this.transport.loadRun(state.link.run_id));
          got.review = { at: state.link.started_at * 1000, findings, older: true };
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
    // Each report asks afresh: an acknowledgement covers the findings it was given for, not the next review's.
    this.doneAcknowledged.set(false);
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

  private async prepare(continueWithLeftovers: boolean, confirmedRepos: string[] = []): Promise<void> {
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
      action: this.askedAction,
      continueWithLeftovers,
      pending: asked.repo,
    });
    switch (out.kind) {
      case 'refused':
        this.asked = null;
        this.refusal.set(out.reason);
        this.refusalProblems.set(out.problems ?? []);
        return;
      case 'needs-confirm':
        this.pendingLeftovers.set(out.leftovers);
        return;
      case 'ready': {
        this.asked = null;
        const context = this.buildContext();
        if (context === null) return;
        const started = await this.build.start(
          {
            start: out.start,
            timeoutSecs: asked.timeoutSecs,
            round: asked.instructions !== null && asked.repo !== null ? { instructions: asked.instructions, repo: asked.repo } : null,
            checksDir,
            choices: this.askedChoices,
            continueOnLeftovers: confirmedRepos,
          },
          context,
        );
        if (started) this.picked.set('build');
        return;
      }
    }
  }

  private masterDir(): string | null {
    const w = this.current();
    const scan = this.scan();
    const repo = scan ? masterRepo(scan) : null;
    return w && repo ? masterPath(w.folder, repo) : null;
  }

  /**
   * Record a decision on a change. `fix` names the drafted fix a decision closes after its replacement opened: the
   * decision then goes to that fix, whatever change the page shows by now, and a failure says the fix stays open.
   */
  private async commitDecision(decision: Decision, confirmed: boolean, fix?: ChangeRef): Promise<DecisionOutcome> {
    const master = this.masterDir();
    if (master === null) return 'error';
    const target = fix ?? { system: this.system(), change: this.changeName() };
    const failure = (text: string): string => (fix ? fixStays(fix, text) : text);
    let out;
    try {
      out = await this.transport.sdlcDecide(master, target.system, target.change, decision, confirmed);
    } catch (e) {
      this.toasts.error(failure(fix ? message(e) : `Could not record the decision: ${message(e)}`));
      return 'error';
    }
    switch (out.kind) {
      case 'needsConfirm':
        this.pendingDecision.set(decision);
        this.pendingFix = fix ?? null;
        return 'needsConfirm';
      case 'gitFailed':
        this.toasts.error(failure(out.stderr.trim() === '' ? 'git refused the commit' : out.stderr));
        break;
      case 'committed':
        this.toasts.success(`${DONE[decision]} · committed`);
        break;
    }
    await this.load();
    return out.kind;
  }

  private async runStage(action: StageAction, feedback = ''): Promise<void> {
    const run = (RUNS as Partial<Record<StageAction, StageRun>>)[action];
    // An action that reaches here with no run behind it is a button nobody wired up: say so instead of doing nothing.
    if (!run) {
      this.toasts.error(`Nothing runs for ${action}.`);
      return;
    }
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    let built;
    try {
      const settings = this.modes.settings() ?? (await this.modes.load());
      const ctx = { folder: workspace.folder, system: this.system(), change: this.changeName(), feedback };
      if (run.kind === 'fix') {
        const checksDir = this.checksDir() ?? (await this.readChecksDir());
        if (checksDir === null) throw new Error('the checks folder is not known');
        built = specFor(run.kind, action, ctx, settings, this.catalog(), undefined, restrictedFor(workspace.folder, scan, checksDir));
      } else {
        built = specFor(run.kind, action, ctx, settings, this.catalog());
      }
    } catch (e) {
      this.toasts.error(`Could not prepare the run: ${message(e)}`);
      return;
    }
    let spec: RunSpec | null;
    try {
      spec = await this.preview.open({ spec: built, mode: 'sdlc', workdir: built.workdir, from: { session: this.givens.session(), job: null, build: null } });
    } catch (e) {
      this.toasts.error(`Could not preview the run: ${message(e)}`);
      return;
    }
    if (!spec) return;
    await this.runner.run(run.title, spec, {
      workspaceId: workspace.id,
      master,
      productRepos: productRepos(scan),
      link: { system: this.system(), change: this.changeName(), stage: run.kind },
      label: run.label,
    });
    await this.load();
  }

  /**
   * The spec or plan as the format program reads it, for the list views. The intent has no parsed form. A program that
   * cannot read the document leaves it as plain text with the program's message above it, never a failed page.
   */
  private async readParsed(master: string, system: string, name: string, stem: string): Promise<ReadResult | ReadError | null> {
    if (stem !== 'spec' && stem !== 'plan') return null;
    try {
      return await this.transport.sdlcReadParsed(master, system, name, stem);
    } catch (e) {
      return { kind: 'error', message: message(e) };
    }
  }

  /** Whether the plugin can be used; a failed check counts as a missing plugin, which only shows the documents as plain text. */
  private async readReadiness(folder: string): Promise<Readiness> {
    try {
      return await this.transport.sdlcPluginReadiness(folder);
    } catch {
      return { kind: 'missing' };
    }
  }

  /** The review document; a failed read leaves the notice to the build logs alone. */
  private async readReviewRecord(master: string, system: string, name: string): Promise<ReviewRecord | null> {
    try {
      return await this.transport.sdlcReviewRecord(master, system, name);
    } catch {
      return null;
    }
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
    const finish = (state: ChangeState, change: ChangeInfo | null, doc: string | null, read: ReadResult | ReadError | null = null) => {
      if (seq !== this.loadSeq) return;
      this.pickSeq++;
      this.pendingDoc.set(null);
      this.picked.set(null);
      this.change.set(change);
      this.doc.set(doc);
      this.read.set(read);
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
      const doc = found ? await this.transport.sdlcReadDoc(master, system, name, stemFor(found)) : null;
      const read = found ? await this.readParsed(master, system, name, stemFor(found)) : null;
      const status = found?.plan.exists ? await this.readStatus(master, system, name) : null;
      const readiness = await this.readReadiness(w.folder);
      const review = found?.plan.exists ? await this.readReviewRecord(master, system, name) : null;
      const checksDir = this.checksDir() ?? (await this.readChecksDir());
      const prs = found?.stage === 'build-finished' ? await this.readPullRequests(w.folder, repo, system, name) : { states: [], failed: false };
      if (seq !== this.loadSeq) return;
      this.pullRequests.set(prs.states);
      this.prCheckFailed.set(prs.failed);
      this.status.set(status);
      this.readiness.set(readiness);
      this.reviewRecord.set(review);
      this.checksDir.set(checksDir);
      this.scan.set(scan);
      this.branches.set(branches);
      this.links.set(links);
      this.records.set(records);
      this.catalog.set(catalog);
      this.changeTotal.set(changes.length);
      finish(found ? 'ready' : 'not-found', found, doc, read);
      // The build page shows the change's tasks, sessions and findings whether or not a build ran on this page.
      const context = this.buildContext();
      if (found && context !== null) this.build.loaded.set({ ctx: context, master: { repo, path: master }, change: found, status, done: this.done(), review });
    } catch (e) {
      this.toasts.error(`Could not read the change: ${message(e)}`);
      finish('not-found', null, null);
    }
  }
}
