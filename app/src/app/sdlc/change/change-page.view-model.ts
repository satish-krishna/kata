import { Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { OpenRun } from '@bindings/OpenRun';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { BuildRow } from '@bindings/BuildRow';
import type { ParsedRequirement } from '@bindings/ParsedRequirement';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangeView } from '@bindings/ChangeView';
import type { OfferedAction } from '@bindings/OfferedAction';
import type { OutOfDateCause } from '@bindings/OutOfDateCause';
import type { StateDocument } from '@bindings/StateDocument';
import type { AcceptOutcome } from '@bindings/AcceptOutcome';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RejectOutcome } from '@bindings/RejectOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { DeclareView } from '@bindings/DeclareView';
import type { PullRequestLink } from '@bindings/PullRequestLink';
import type { PullRequestsView } from '@bindings/PullRequestsView';
import type { LeftBehind } from '../../ui/pr-list-dialog';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ChangesContext } from '../changes/changes-view.view-model';
import { BuildPageViewModel, type BuildContext } from '../build/build-page.view-model';
import type { RunSpec } from '@bindings/RunSpec';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { ChangeRef as ChangeWithWorkspace } from '@bindings/ChangeRef';
import { ChangeRunStore, changeRunKey } from '../../core/run/change-run.store';
import { RunLandingStore } from '../../core/run/run-landing.store';
import { BuildLayoutViewModel } from '../build/build-layout.view-model';
import { ChangeDraftStore } from '../../core/sdlc/change-draft.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice } from '../../core/sdlc/sdlc-runner';
import { ProgressStore } from '../../core/progress/progress.store';
import { ToastStore } from '../../core/toast/toast.store';
import { documentForm } from '../../lib/build-host';
import { progressLabels } from '../../lib/progress-steps';
import { KataTransport, type NamingState } from '../../core/transport/kata-transport';
import {
  actionLabel,
  actionLabelAt,
  restrictedFor,
  primaryAction,
  parseFrontMatter,
  specFor,
  outOfDateCause,
  stageName,
  stagePills,
  stageRuns,
  type DocsPresent,
  type StageAction,
  type StagePill,
} from '../../lib/sdlc';
import { shownBuild, shownDocument, type DocNotice, type ReadError, type Shown } from '../../lib/doc-notice';
import { docStatus, recentRuns, usedBy, type DocStatus, type RunRow, type UsedBy } from '../../lib/doc-rail';
import { prNumber } from '../../lib/pull-request';
import { DONE_STEP_LINE, type DoneReport } from '../../lib/sdlc-done';
import { section } from '../../lib/doc';
import { fullPipelineIdea } from '../../lib/sdlc-fix';
import { inTauri } from '../../lib/mock';
import { taskRecord, withRows, type TaskView } from '../../lib/task-view';
import { masterPath, masterRepo, productRepos } from '../../lib/sdlc-workspace';
import { namingRefusal } from '../../lib/sdlc-naming';

export type ChangeState = 'loading' | 'ready' | 'not-found';

/** The spec and plan tabs' views: the list (requirements, tasks), the one `##` section (Design, Approach), the whole text. */
export type DocView = 'list' | 'section' | 'whole';

/** The one run a change's page has a message box for: its own document session. */
const SESSION_RUN = 'document';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSecs = (): number => Math.floor(Date.now() / 1000);
const BUSY = 'Another task is already running.';
/** The stage steps that mean the plan is accepted. */

/** The actions `act` handles itself; every other action starts a stage run. */
type HandledAction =
  | 'rename'
  | 'accept-intent'
  | 'reject-intent'
  | 'reject-fix'
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
/** The toast for a drafted fix that stays open after the new change that replaces it started. */
const fixStays = (fix: ChangeRef, why: string): string => `The new change started, but the fix ${fix.change} could not be closed: ${why}. It stays open.`;
/** What the engineer is told once a change is rejected: the record stays on the master's branch. */
const rejectedSaid = (branch: string): string => `Rejected. Its record stays on branch \`${branch}\`.`;
/** The last lines of a hook's output, which is what says why it failed. */
const outputTail = (output: string): string => output.trim().split('\n').slice(-12).join('\n');
/** A change by system and folder name, with the workspace it belongs to. */
type ChangeRef = ChangeWithWorkspace;
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
const NEEDS_LIGHT_TRACK = 'Needs ai-sdlc 1.1.0 or later.';

/** The document each accepting action records. */
const ACCEPTS: Partial<Record<StageAction, ChangeDocument>> = {
  'accept-intent': 'intent',
  'accept-spec': 'spec',
  'accept-plan': 'plan',
};

/** The document whose acceptance is in the working tree but not committed, by the stage that says so. */
const ACCEPTED_UNCOMMITTED: Partial<Record<string, ChangeDocument>> = {
  'intent-accepted-uncommitted': 'intent',
  'spec-accepted-uncommitted': 'spec',
  'plan-accepted-uncommitted': 'plan',
};

/** Why the plan cannot be built, in the words the plan tab shows. */
const INTENT_REOPENED = 'The intent was reopened.';
const SPEC_REOPENED = 'The spec was reopened.';
const OUT_OF_DATE_BANNER: Record<OutOfDateCause, string> = {
  'spec-pin': 'This spec was not written from the intent accepted now. Rewrite the spec, then the plan.',
  'plan-pin': 'This plan was not written from the spec accepted now. Rewrite the plan before building.',
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A task is built once the build log has a row for it; the record is the one reader of that. */
const isBuilt = (t: { row: BuildRow | null }): boolean => taskRecord(t).kind !== 'unbuilt';
const SUPERSEDED_BANNER = 'The intent was reopened after this plan was written. Rewrite the plan before building.';

type DocStem = 'intent' | 'spec' | 'plan';
/** What the stage tiles select: a document, or what the build changed. */
type Tab = DocStem | 'build';

/** A change's stage by name; empty before the change is read. */
const stageNameOf = (c: ChangeView | null): string => (c === null ? '' : stageName(c.offer.stage));

/**
 * The document the page shows for a change: the current stage's, falling back to the last one that exists.
 * A stem, because that is what the backend's `read_doc` accepts; the page shows it as `<stem>.md`.
 */
const isDocStem = (s: string): s is DocStem => s === 'intent' || s === 'spec' || s === 'plan';

function stemFor(c: ChangeView): DocStem {
  const step = c.offer.label.step;
  const { spec, plan } = c.state.documents;
  if (step === 'plan' || step === 'build' || step === 'done') return plan.exists ? 'plan' : spec.exists ? 'spec' : 'intent';
  if (step === 'spec') return spec.exists ? 'spec' : 'intent';
  return 'intent';
}

/** What the change opens on: its Build tab once the plan is accepted, else the current stage's document. */
function docFor(c: ChangeView): Tab {
  const step = c.offer.label.step;
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
  private readonly changeRuns = inject(ChangeRunStore);
  private readonly landing = inject(RunLandingStore);
  private readonly drafts = inject(ChangeDraftStore);
  private readonly layout = inject(BuildLayoutViewModel, { optional: true });
  /** The preview every document run goes through; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  /** The build, which lives as long as this page: it starts here and the page shows it. */
  private readonly build = inject(BuildPageViewModel);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly progress = inject(ProgressStore);
  /** Reading the change, reading a picked document, preparing a build, and the lock's long step: one progress entry for each place on the page. */
  readonly readingChange = this.progress.view('page');
  readonly readingDoc = this.progress.view('doc');
  readonly preparingBuild = this.progress.view('build');
  readonly lockProgress = this.progress.view('lock');
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
  readonly change = signal<ChangeView | null>(null);
  /** The pull request links the backend gave, from the plugin's record or an earlier declaration; the page never decides what they mean. */
  readonly pullRequests = signal<PullRequestLink[]>([]);
  /** The recorded pull requests could not be read, so the finished label stays. */
  readonly prCheckFailed = signal(false);
  /** The backend says the change is done: it has no actions left. */
  readonly done = signal(false);

  // --- the change's own copy: where it is, whether it may be removed, and what removing it came to

  /** The branch the copy holds, asked for in the background once the page shows; null until it answers. */
  private readonly copyBranchName = signal<string | null>(null);
  /** The backend's answer about removing the copy, asked for in the background once the page shows; nothing is offered until it arrives. */
  private readonly removal = signal<CopyRemoval>({ outcome: 'notOffered' });
  /** What the last removal or check came to, for the change it belongs to; the page reads the change again after a removal, so it is kept apart from the load. */
  private readonly copyResult = signal<{ key: string; note: DocNotice } | null>(null);
  private readonly changeKey = computed(() => `${this.system()}/${this.changeName()}`);

  /** Where the change's copy is and the branch it holds; null when the change is not in a copy. */
  readonly copy = computed<{ folder: string; branch: string | null } | null>(() => {
    const state = this.change()?.state;
    return state?.inCopy ? { folder: state.master, branch: this.copyBranchName() } : null;
  });
  /** The backend offered to remove the copy. Never true before the backend answered. */
  readonly removalOffered = computed(() => this.copy() !== null && this.removal().outcome === 'offer');
  /** The uncommitted files that keep the copy, as the backend named them; none when it names none. */
  readonly keepFiles = computed<string[]>(() => {
    const removal = this.removal();
    return this.copy() !== null && removal.outcome === 'keep' ? removal.uncommitted : [];
  });
  /** The removal confirmation is on show. */
  readonly removeAsked = signal(false);
  /** What the last removal or check came to, for the page to show; null when there is nothing to say. */
  readonly copyNote = computed<DocNotice | null>(() => {
    const result = this.copyResult();
    return result !== null && result.key === this.changeKey() ? result.note : null;
  });
  private setCopyNote(note: DocNotice | null): void {
    this.copyResult.set(note === null ? null : { key: this.changeKey(), note });
  }
  private copyRef(): ChangeRef | null {
    const workspace = this.current();
    return workspace === null ? null : { workspace: workspace.folder, system: this.system(), change: this.changeName() };
  }

  /** Ask for the copy's branch and the removal offer without holding the page: GitHub is asked for the pull request states. */
  private readCopy(seq: number, ref: ChangeRef): void {
    this.copyBranchName.set(null);
    this.removal.set({ outcome: 'notOffered' });
    this.transport.sdlcCopyBranch(ref).then(
      (branch) => seq === this.loadSeq && this.copyBranchName.set(branch),
      () => undefined,
    );
    this.transport.sdlcCopyRemoval(ref).then(
      (answer) => seq === this.loadSeq && this.removal.set(answer),
      (e) => {
        if (seq === this.loadSeq) this.setCopyNote({ tone: 'warning', text: `Could not check whether this copy can be removed: ${message(e)}`, lines: [] });
      },
    );
  }
  /** The engineer asked to remove the copy: only an offered removal is asked about. */
  askRemoveCopy(): void {
    if (this.removalOffered()) this.removeAsked.set(true);
  }
  declineRemoveCopy(): void {
    this.removeAsked.set(false);
  }
  /** The engineer confirmed. Every outcome has a visible result: the copy goes, or it stays and the note says why. */
  async confirmRemoveCopy(): Promise<void> {
    this.removeAsked.set(false);
    const ref = this.copyRef();
    if (ref === null) return;
    let out: RemoveOutcome;
    try {
      out = await this.transport.sdlcRemoveCopy(ref);
    } catch (e) {
      this.setCopyNote({ tone: 'warning', text: `The copy was not removed: ${message(e)}`, lines: [] });
      return;
    }
    switch (out.outcome) {
      case 'removed':
        this.removal.set({ outcome: 'notOffered' });
        this.setCopyNote({ tone: 'idle', text: 'The copy is removed. The change branch and its commits stay in the master repository.', lines: out.kept });
        // The plugin reports the master repository now, not the folder of the copy that is gone.
        await this.load();
        return;
      case 'keep':
        this.removal.set({ outcome: 'keep', uncommitted: out.uncommitted });
        this.setCopyNote({ tone: 'warning', text: 'The copy holds uncommitted files, so it is kept.', lines: out.uncommitted });
        return;
      case 'refused':
        this.setCopyNote({ tone: 'warning', text: 'The plugin did not remove the copy.', lines: out.problems });
        return;
      case 'couldNotRun':
        this.setCopyNote({ tone: 'warning', text: `The copy was not removed: the plugin could not run: ${out.message}`, lines: [] });
        return;
    }
  }
  async openCopyFolder(): Promise<void> {
    const ref = this.copyRef();
    if (ref === null) return;
    try {
      await this.transport.sdlcOpenCopyFolder(ref);
    } catch (e) {
      this.toasts.error(`Could not open the copy folder: ${message(e)}`);
    }
  }
  /** The key of the change the backend was last told is open; the page tells it once per change, however often it reads the change. */
  private openedKey = '';
  private readonly linksFrom = signal<PullRequestsView['source']>(null);
  /** The shown document, raw as it is on disk, or null when the file is missing. */
  readonly doc = signal<string | null>(null);
  /** The shown spec or plan as the format program read it; null for the other documents, or when the program could not run. */
  private readonly read = signal<ReadResult | ReadError | null>(null);
  /** Whether the ai-sdlc plugin can be used; null until the first load has asked. */
  private readonly readiness = signal<Readiness | null>(null);
  /** The review document as the format program reads it; null when the change has none or it could not be read. */
  private readonly reviewRecord = signal<ReviewRecord | null>(null);
  /** The notice above the open spec or plan; null when it needs none. */
  readonly docNotice = computed<DocNotice | null>(() => this.unsettledNotice() ?? this.shown()?.notice ?? this.refusalNotice());
  /** A fix whose documents carry statuses the workflow never leaves on a fix: the page lists them, on every tab. */
  private readonly unsettledNotice = computed<DocNotice | null>(() => {
    const c = this.change();
    if (c === null || stageName(c.offer.stage) !== 'fix-unsettled') return null;
    const text = 'The workflow does not leave a fix in these statuses, so nothing can be run on it.';
    // When the plugin could not say where the fix stands, no status was read, so the headline about statuses would be false.
    if (c.state.fix === null) return { tone: 'warning', text: 'Kata could not read where this fix stands.', lines: [] };
    // Each document shows the status HEAD holds, whether or not the working file exists: a deleted document is
    // "missing (HEAD: draft)", and one not in HEAD says so.
    const status = (d: StateDocument) => {
      if (d.workingStatus === null) return d.headStatus === null ? 'missing' : `missing (HEAD: ${d.headStatus})`;
      return `${d.workingStatus} (HEAD: ${d.headStatus ?? 'not committed'})`;
    };
    const { intent, spec, plan } = c.state.documents;
    const lines = [`intent: ${status(intent)} · spec: ${status(spec)} · plan: ${status(plan)}`];
    return { tone: 'warning', text, lines };
  });
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
    ).notice ?? this.refusalNotice();
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
  /** The branch name confirmation on show. */
  readonly nameRequest = this.runner.nameRequest;
  readonly crumbs = computed(() => (this.changeName() === '' ? [] : [this.changeName()]));

  readonly shownDoc = computed<Tab>(() => {
    const c = this.change();
    return this.picked() ?? (c ? docFor(c) : 'intent');
  });
  readonly docs = computed<DocsPresent>(() => {
    const c = this.change();
    const d = c?.state.documents;
    return { intent: d?.intent.exists ?? false, spec: d?.spec.exists ?? false, plan: d?.plan.exists ?? false };
  });
  /** A build or a skill run holds the page: its view stands in for the change's tabs, so nothing here may be clicked. */
  private readonly held = computed(() => this.session() !== null);
  /**
   * The four stage pills for the toolbar; none until the change is read, nor while a build or a skill run holds the
   * page (the build view or the session view stands in for the tabs then).
   */
  readonly pills = computed<StagePill[]>(() => {
    const c = this.change();
    return c === null || this.held() ? [] : stagePills(c.offer.label, this.done(), this.docs());
  });
  /** The pull requests that have an address, for the toolbar's links; none while a build or a skill run holds the page. */
  readonly pullLinks = computed(() =>
    this.held()
      ? []
      : this.pullRequests().flatMap((p) => {
          if (p.url === null) return [];
          const number = prNumber(p.url);
          return [{ repo: p.repo, url: p.url, number, label: number === null ? p.repo : `${p.repo} #${number}`, state: this.stateLabel(p), seen: this.seenLabel(p) }];
        }),
  );
  /** Where the links come from when that is not this page's own declaration: "from the earlier declaration", else null. */
  readonly linksNote = computed<string | null>(() => (this.linksFrom() === 'legacy' && this.pullRequests().length > 0 ? 'from the earlier declaration' : null));
  /** The state a link shows: what GitHub said, else "checking" until the plugin has read it, else that it could not. */
  private stateLabel(p: PullRequestLink): string {
    return p.state ?? (p.lastSeen ? 'not read' : 'checking');
  }
  /** "last seen <time>" for a state that is not from the last read; null for a state the plugin just read and while it is still reading. */
  private seenLabel(p: PullRequestLink): string | null {
    if (!p.lastSeen) return null;
    return p.seenAt === null ? 'last seen' : `last seen ${new Date(p.seenAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  /** The master repository's branch the change records, as the backend resolves it; null until read or when it cannot be. */
  private readonly recordedBranch = signal<string | null>(null);
  /** The branch the change lives on: the recorded one, else change/<change>. */
  readonly expectedBranch = computed(() => this.recordedBranch() ?? `change/${this.changeName()}`);
  /** The master repository's branch, unless it is the change's own branch, which the pills already imply. */
  readonly branchChip = computed(() => {
    const branch = this.masterBranch();
    return branch === this.expectedBranch() ? null : branch;
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
    if (c.offer.label.step !== 'build') return this.offeredActions();
    return [...this.build.actions(), ...this.barExtras().map((e) => e.action)];
  });
  /** The actions the plugin's answer offers that the page has a control for, in the answer's order. */
  private readonly offeredActions = computed<StageAction[]>(() => (this.change()?.offer.actions ?? []).map((a) => a.action));
  /** What the answer says about an action: may it be used now, and if not why. Null for an action the answer does not list. */
  private offered(action: StageAction): OfferedAction | null {
    return this.change()?.offer.actions.find((a) => a.action === action) ?? null;
  }
  /** The plugin's message for an action it refuses; null when the action is not refused. */
  private refusedWith(action: StageAction): string | null {
    const o = this.offered(action);
    return o !== null && !o.enabled ? o.reason : null;
  }
  /** The messages of the refused actions on show, as the plugin worded them: the first as the text, the rest as lines. */
  private readonly refusalNotice = computed<DocNotice | null>(() => {
    const reasons = [...new Set(this.actions().flatMap((a) => this.refusedWith(a) ?? []))];
    return reasons.length === 0 ? null : { tone: 'warning', text: reasons[0], lines: reasons.slice(1) };
  });
  /**
   * The actions the build page's bar adds after its own: the build page has no way back to the documents, so the bar adds it
   * for both tracks. A fix's list contributes the one that reopens it; a full-pipeline change's contributes Reopen intent and
   * Reopen spec, except any the build page already lists. Each carries whether its button is off and why.
   */
  readonly barExtras = computed(() => {
    const c = this.change();
    if (c === null || this.done() || c.offer.label.step !== 'build') return [];
    const own = this.build.actions();
    return this.offeredActions()
      .filter((a) => a === 'rename' || (c.state.track === 'fix' ? a === 'reopen-fix' : (a === 'reopen-intent' || a === 'reopen-spec') && !own.includes(a)))
      .map((action) => ({ action, disabled: this.disabledFor(action), title: this.titleFor(action) }));
  });
  /** What blocks the build, shown above the plan; null when nothing does or another document is shown. */
  readonly planBanner = computed(() => {
    const c = this.change();
    if (c === null) return null;
    // A reopened intent or spec keeps its own stage once a plan exists (R1.5); name it on whichever tab is shown.
    // A superseded plan must also be rewritten once the document is accepted again (R1.3), so say so now.
    const stage = stageName(c.offer.stage);
    const plan = c.state.documents.plan;
    if (plan.exists) {
      const rewrite = plan.workingStatus === 'superseded' ? ' The plan must be rewritten first.' : '';
      if (stage === 'intent-awaiting' || stage === 'intent-in-progress') return INTENT_REOPENED + rewrite;
      if (stage === 'spec-awaiting') return SPEC_REOPENED + rewrite;
    }
    if (this.shownDoc() !== 'plan') return null;
    if (stage === 'plan-superseded') return SUPERSEDED_BANNER;
    const cause = outOfDateCause(c.offer.stage);
    return cause === null ? null : OUT_OF_DATE_BANNER[cause];
  });
  readonly primary = computed(() => primaryAction(this.actions()));
  /** An action's label at the change's stage: accepting a fix whose acceptance stopped reads differently. */
  labelOf(action: StageAction): string {
    const c = this.change();
    return c === null ? actionLabel(action) : actionLabelAt(action, stageName(c.offer.stage));
  }
  /** Whether an action's button is off: the lock holds it, or it is a fix run the plugin on this machine cannot do. */
  disabledFor(action: StageAction): boolean {
    return this.locked() || this.needsLightTrack(action) || this.refusedWith(action) !== null;
  }
  /** Why a fix run is unavailable; null for any other action and while it is available. */
  titleFor(action: StageAction): string | null {
    if (this.needsLightTrack(action)) return NEEDS_LIGHT_TRACK;
    return this.refusedWith(action);
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
    if (c === null || stem === 'build') return null;
    const { spec, plan } = c.state.documents;
    return usedBy(stem, { spec: { exists: spec.exists, status: spec.workingStatus }, plan: { exists: plan.exists, status: plan.workingStatus } });
  });
  /** The latest runs of the open document's stage for the rail, and how many the stage has had. */
  readonly railRuns = computed<{ rows: RunRow[]; total: number }>(() => {
    const w = this.current();
    const stem = this.shownDoc();
    if (w === null || stem === 'build') return { rows: [], total: 0 };
    const runs = stageRuns(this.links(), this.records(), w.id, this.system(), this.changeName(), stem);
    return recentRuns(runs, stem.charAt(0).toUpperCase() + stem.slice(1));
  });

  // --- the feedback box: a revisit asks what should change before it runs
  private readonly pendingRevisit = signal<StageAction | null>(null);
  /** The label of the action waiting on the feedback box, or null while the box is closed. */
  readonly feedbackFor = computed(() => {
    const a = this.pendingRevisit();
    return a === null ? null : this.labelOf(a);
  });

  /** The waiting action cannot run with an empty box. */
  readonly feedbackRequired = computed(() => {
    const a = this.pendingRevisit();
    return a !== null && (this.offered(a)?.feedbackRequired ?? false);
  });

  // --- the build: its dialog, the leftovers confirm, the refusal, and what is handed to the build view
  private readonly status = signal<BuildStatus | null>(null);
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
  /**
   * Pick a new name for the change's branch, from a refusal or from the done dialog. The rename covers every repository that has the
   * branch; the build can be started again after it, and the page reads the change again. Null when the dialog was closed.
   */
  async renameBranch(branch: string | null): Promise<string | null> {
    const w = this.current();
    if (w === null || branch === null) return null;
    const named = await this.runner.requestRename({ folder: w.folder, workspaceId: w.id, system: this.system(), change: this.changeName(), current: branch });
    if (named === null) return null;
    // The pull requests opened from the old name stay open on GitHub: list them to close by hand.
    if (named.oldPullRequests.length > 0) {
      this.prLeftBehind.set(named.oldPullRequests.map((p) => ({ repo: p.repo, url: p.url, branch: named.from })));
    }
    return named.branch;
  }

  // --- declaring done: the confirmation, then the plugin's step
  /** What the done dialog shows; the dialog is open exactly while this is set. */
  readonly doneReport = signal<DoneReport | null>(null);
  /** What the plugin answered to declaring done; the result dialog is open while this is set. */
  readonly declareView = signal<DeclareView | null>(null);
  /** The pull requests an earlier branch name left open on GitHub, shown with the result. */
  readonly prLeftBehind = signal<LeftBehind[]>([]);

  /** The engineer confirmed: the plugin verifies the change, pushes and opens the pull requests. */
  async confirmDone(): Promise<void> {
    if (this.doneReport() === null) return;
    this.doneReport.set(null);
    await this.declare();
  }

  /** Ask the plugin again after it stopped part way; it carries on from there. */
  async declareAgain(): Promise<void> {
    this.declareView.set(null);
    await this.declare();
  }

  closeDeclareView(): void {
    this.declareView.set(null);
    this.prLeftBehind.set([]);
  }

  /** Run the plugin's `change.done`, showing the step it reports as the lock's progress line. */
  private async declare(): Promise<void> {
    const w = this.current();
    if (!w) return;
    const ref = { workspace: w.folder, system: this.system(), change: this.changeName() };
    let view: DeclareView | null = null;
    const unlisten = await this.transport.onDoneStep((step) => this.progress.begin(DONE_STEP_LINE[step.kind], step.label, 'lock'));
    let out: Awaited<ReturnType<LockStore['runSteps']>>;
    try {
      out = await this.lock.runSteps('Opening pull requests', [
        {
          label: 'Declare done',
          run: async () => {
            try {
              view = await this.transport.sdlcDeclareDone(ref);
            } catch (e) {
              this.progress.fail('lock');
              throw e;
            }
            this.progress.end('lock');
            return null;
          },
        },
      ]);
    } finally {
      unlisten();
      this.progress.end('lock');
    }
    if (out === 'done') this.declareView.set(view);
    await this.load();
  }

  /** Ask for another round instead of opening the pull requests. */
  doneRound(): void {
    this.doneReport.set(null);
    this.closeDeclareView();
    void this.startBuild(this.build.openRound());
  }

  /** Open the review's preview; Start run hands the build view a review only: every task has a row, so nothing else runs. */
  async doneRunReview(): Promise<void> {
    this.doneReport.set(null);
    this.closeDeclareView();
    void this.startBuild(this.build.openPreview('review'));
  }

  /** Show the Build tab once the build the engineer asked for has started. */
  private async startBuild(started: Promise<boolean>): Promise<void> {
    if (await started) this.picked.set('build');
  }

  cancelDone(): void {
    this.doneReport.set(null);
  }

  // --- the lock: Kata's own checks in the overlay; an agent run as the session view
  /** The session of this change's own document run, which no other page shows and which does not lock any other change. */
  private readonly runKey = computed(() => {
    const w = this.current();
    return w ? changeRunKey({ workspace: w.folder, system: this.system(), change: this.changeName() }) : null;
  });
  private readonly ownRun = computed(() => {
    const key = this.runKey();
    return key === null ? null : this.changeRuns.session(key);
  });
  /** What holds this page: Kata's own checks, a run that took the screen, or this change's own live document run. */
  readonly locked = computed(() => this.lock.active() !== null || this.ownRun() !== null);
  readonly lockView = computed(() => {
    const v = this.lock.active();
    return v?.kind === 'steps' ? v : null;
  });
  /** The agent run the page shows, live or finished: this change's own, else a run that took the screen; or null. */
  readonly session = computed(() => {
    const own = this.ownRun();
    if (own) return { kind: 'run' as const, title: own.title, finished: own.finished, spec: own.spec };
    const v = this.lock.active();
    const spec = this.lock.spec();
    return v?.kind === 'run' && spec ? { ...v, spec } : null;
  });
  private readonly ownSnap = computed(() => {
    const key = this.runKey();
    return this.ownRun() !== null && key !== null ? this.changeRuns.snapshot(key) : null;
  });
  readonly lockElapsed = (): number => {
    const key = this.runKey();
    return this.ownRun() !== null && key !== null ? this.changeRuns.elapsedSecs(key) : this.lock.elapsedSecs();
  };
  readonly lockDeadline = (): number | null => {
    const key = this.runKey();
    return this.ownRun() !== null && key !== null ? this.changeRuns.deadlineSecs(key) : this.lock.deadlineSecs();
  };
  readonly runState = computed(() => this.ownSnap()?.state ?? this.runs.state());
  readonly events = computed(() => this.ownSnap()?.events ?? this.runs.events());
  readonly summary = computed(() => this.ownSnap()?.summary ?? this.runs.summary());
  readonly asks = computed(() => this.ownSnap()?.asks ?? this.runs.asks());
  readonly messages = computed(() => this.ownSnap()?.messages ?? this.runs.messages());
  readonly messageRefusal = computed(() => this.ownSnap()?.refusal ?? this.runs.refusal());
  readonly permissions = computed(() => this.ownSnap()?.permissions ?? this.runs.permissions());
  readonly given = computed(() => this.ownSnap() === null ? this.runs.given() : this.ownSnap()!.given);
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
    // A run picked from the running changes is shown once the change it belongs to is on the page.
    effect(() => {
      const asked = this.landing.pending();
      const ready = this.state() === 'ready';
      const system = this.system();
      const change = this.changeName();
      untracked(() => {
        if (asked === null || !ready || asked.system !== system || asked.change !== change) return;
        this.landing.clear();
        this.land(asked.run);
      });
    });
    // A confirmation names the branch, whoever opened it (this page, or the start of the change): read the change again.
    effect(() => {
      const named = this.runner.named();
      untracked(() => {
        if (named === this.seenNamed) return;
        this.seenNamed = named;
        void this.load();
      });
    });
    // The change is read again when the backend's build ends or stops, so its stage, pill and actions follow it.
    effect(() => {
      const building = this.build.active();
      untracked(() => {
        const ended = this.wasBuilding && !building;
        this.wasBuilding = building;
        if (ended) void this.load();
      });
    });
  }

  /** The branches named so far, as this page last saw them: the page reads the change again when a confirmation names one. */
  private seenNamed = this.runner.named();

  /** Whether the backend's build was going the last time it changed. */
  private wasBuilding = false;

  /** `?demo=sdlc` starts the scripted spec run once the change has loaded. Browser only, never under Tauri. */
  async startDemo(demo: string | null): Promise<void> {
    if (inTauri() || demo !== 'sdlc') return;
    await this.load();
    if (this.state() === 'ready') await this.runStage('continue-spec');
  }

  // --- renaming

  acceptName(name: string): void {
    void this.runner.confirmName(name);
  }

  closeName(): void {
    this.runner.closeName();
  }

  // --- actions

  async act(action: StageAction): Promise<void> {
    // The build is hosted by the backend and holds no lock here; stopping it is allowed whatever else is going.
    if (action !== 'cancel-build' && this.refuseWhileLocked()) return;
    if (this.needsLightTrack(action)) {
      this.toasts.error(NEEDS_LIGHT_TRACK);
      return;
    }
    switch (action) {
      case 'accept-intent':
      case 'accept-spec':
      case 'accept-plan':
        await this.acceptDocument(ACCEPTS[action] ?? 'spec');
        return;
      case 'commit-acceptance':
        await this.acceptDocument(ACCEPTED_UNCOMMITTED[stageNameOf(this.change())] ?? 'spec');
        return;
      case 'reject-intent':
      case 'reject-fix':
        await this.rejectChange();
        return;
      case 'start-build':
        void this.startBuild(this.build.openPreview('start'));
        return;
      case 'continue-build':
        void this.startBuild(this.build.openPreview('continue'));
        return;
      case 'another-round':
        void this.startBuild(this.build.openRound());
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
      case 'rename':
        await this.renameBranch(this.expectedBranch());
        return;
      case 'full-pipeline-instead':
        await this.openFullPipeline();
        return;
      default:
        // Regenerating an existing document first asks what should change; a first draft just runs.
        if (this.offered(action)?.revisits === true) this.pendingRevisit.set(action);
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

  // --- taking the full pipeline instead of a drafted fix

  readonly pipelineOpen = signal(false);
  readonly pipelineIdea = signal('');
  readonly pipelineNote = computed(() => `This closes the drafted fix ${this.changeName()}.`);
  readonly pipelineSystems = computed(() => [this.system()]);
  /** Whether the plugin on this machine can triage a change. */
  readonly lightTrack = computed(() => {
    const r = this.readiness();
    return r !== null && r.kind === 'ready';
  });
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
   *
   * The sequence: start the new change, then ask the plugin to reject the fix (its own copy holds the fix's documents,
   * so no branch is switched). See `closeFix`.
   */
  async startPipeline(system: string, idea: string): Promise<void> {
    this.pipelineOpen.set(false);
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    // Captured before the await: newChange navigates to the new change, and this page and ViewModel are reused.
    const fixRef: ChangeRef = { workspace: workspace.folder, system: this.system(), change: this.changeName() };
    let outcome;
    try {
      const branches = await this.transport.sdlcBranches(master);
      // A setting that cannot be used stops the start, as on the workspace home; there is no fall back to `change/` naming (R3.2).
      const repo = masterRepo(scan);
      let naming: NamingState = { kind: 'none' };
      try {
        if (repo) naming = await this.transport.sdlcNaming(workspace.folder, repo, system);
      } catch (e) {
        naming = { kind: 'error', reason: 'unreadable', message: message(e) };
      }
      if (naming.kind === 'error') {
        this.toasts.error(namingRefusal(system, branches.default_base, naming.message));
        return;
      }
      outcome = await this.runner.newChange({ workspace, master, productRepos: productRepos(scan) }, system, idea, 'full', (spec) => this.confirmRun(spec));
    } catch (e) {
      this.toasts.error(`Could not start the change: ${message(e)}`);
      return;
    }
    if (outcome.kind !== 'opened') return;
    await this.closeFix(fixRef);
  }

  /**
   * Close the fix after its replacement opened: the plugin commits the rejection in the fix's copy and removes the copy,
   * keeping its record on the master's branch. Every refusal is said in a toast and leaves the fix open.
   */
  private async closeFix(fix: ChangeRef): Promise<void> {
    let out: RejectOutcome;
    try {
      out = await this.transport.sdlcReject(fix);
    } catch (e) {
      this.toasts.error(fixStays(fix, message(e)));
      await this.load();
      return;
    }
    switch (out.outcome) {
      case 'rejected':
        this.toasts.success(rejectedSaid(out.recordBranch));
        break;
      case 'rejectedNotRemoved':
        this.toasts.error(`The new change started and the fix ${fix.change} is rejected, but its copy was not removed: ${out.problems.join('\n')}`);
        break;
      case 'refused':
        this.toasts.error(fixStays(fix, out.message));
        break;
      case 'notCommitted':
        this.toasts.error(fixStays(fix, out.problems.join('\n')));
        break;
      case 'couldNotRun':
        this.toasts.error(fixStays(fix, out.message));
        break;
    }
    await this.load();
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
      this.progress.end('doc');
      if (this.shownDoc() !== 'build' && this.change() !== null) {
        this.picked.set('build');
        this.rememberTab();
      }
      return;
    }
    if (!isDocStem(stem) || !this.docs()[stem]) return;
    // The last click wins: a click back on the tab already shown also ends a read still pending for another tab.
    const seq = ++this.pickSeq;
    if (stem === this.shownDoc()) {
      this.pendingDoc.set(null);
      this.progress.end('doc');
      return;
    }
    const master = this.masterDir();
    if (!master) {
      this.pendingDoc.set(null);
      this.progress.end('doc');
      return;
    }
    // The spartan tabs move their own selection on a click, so the pill the operator clicked is held here until the text is read or the read fails; the tabs follow it.
    this.pendingDoc.set(stem);
    this.progress.begin('reading-change', progressLabels.readingDoc(stem), 'doc');
    try {
      const text = await this.transport.sdlcReadDoc(master, this.system(), this.changeName(), stem);
      const read = await this.readParsed(master, this.system(), this.changeName(), stem);
      // The tab and its text change together, once the text is here, so no tab ever shows another document's text.
      if (seq !== this.pickSeq) return;
      this.doc.set(text);
      this.read.set(read);
      this.picked.set(stem);
      this.rememberTab();
      this.pendingDoc.set(null);
      this.progress.end('doc');
    } catch (e) {
      if (seq !== this.pickSeq) return;
      this.pendingDoc.set(null);
      this.progress.fail('doc');
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
    const key = this.runKey();
    if (this.ownRun() !== null && key !== null) this.changeRuns.cancel(key);
    else this.lock.cancel();
  }

  closeSession(): void {
    const key = this.runKey();
    this.setMessageDraft('');
    if (this.ownRun() !== null && key !== null) this.changeRuns.close(key);
    else this.lock.close();
  }

  answer(e: { id: string; answers: string[][] }): void {
    const key = this.runKey();
    if (this.ownRun() !== null && key !== null) this.changeRuns.answer(key, e.id, e.answers);
    else this.lock.answer(e.id, e.answers);
  }

  /** The change as the draft store names it; null until a workspace is open. */
  private readonly draftRef = computed<ChangeWithWorkspace | null>(() => {
    const w = this.current();
    return w ? { workspace: w.folder, system: this.system(), change: this.changeName() } : null;
  });

  /** The message typed for this change's session and not sent, which survives leaving the page. */
  readonly messageDraft = computed(() => {
    const ref = this.draftRef();
    return ref === null ? '' : this.drafts.message(ref, SESSION_RUN);
  });

  setMessageDraft(text: string): void {
    const ref = this.draftRef();
    if (ref !== null) this.drafts.setMessage(ref, SESSION_RUN, text);
  }

  say(text: string): void {
    this.setMessageDraft('');
    const key = this.runKey();
    if (this.ownRun() !== null && key !== null) this.changeRuns.say(key, text);
    else this.lock.say(text);
  }

  decide(e: { id: string; allow: boolean; message: string | null }): void {
    const key = this.runKey();
    if (this.ownRun() !== null && key !== null) this.changeRuns.decide(key, e.id, e.allow, e.message);
    else this.lock.decide(e.id, e.allow, e.message);
  }

  async discardLeftovers(choices: DiscardChoice[]): Promise<void> {
    await this.runner.discardAll(choices);
    await this.load();
  }

  /** Open a pull request's address in the default browser. */
  async openPr(url: string): Promise<void> {
    try {
      await this.transport.openUrl(url);
    } catch (e) {
      this.toasts.error(`Could not open ${url}: ${message(e)}`);
    }
  }

  closeLeftovers(): void {
    this.runner.closeLeftovers();
  }

  // --- internals

  private refuseWhileLocked(): boolean {
    if (!this.locked()) return false;
    this.toasts.error(BUSY);
    return true;
  }

  private readonly scanMaster = computed(() => {
    const scan = this.scan();
    return scan ? masterRepo(scan) : null;
  });

  /**
   * Read the repositories, their branch and what the plugin recorded for their checks, then show the confirmation. Nothing is checked here:
   * the plugin verifies the change when it is asked. Nothing throws.
   */
  private async declareDone(): Promise<void> {
    const w = this.current();
    const master = this.scanMaster();
    if (stageNameOf(this.change()) !== 'build-finished' || !w || master === null) return;
    const folder = w.folder;
    const system = this.system();
    const change = this.changeName();
    let repos: ChangeRepo[] = [];
    let views: RepoCheckView[] = [];
    const out = await this.lock.runSteps('Declaring done', [
      {
        label: 'Repositories of the change',
        run: async () => {
          repos = await this.transport.sdlcChangeRepos(folder, master, system, change);
          return plural(repos.length, 'repository', 'repositories');
        },
      },
      {
        label: 'Checks the plugin recorded',
        run: async () => {
          views = await this.transport.sdlcChecksView({ workspace: folder, system, change });
          return plural(views.length, 'repository', 'repositories');
        },
      },
    ]);
    if (out !== 'done') return;
    this.doneReport.set({
      // The branch the change really has: it may carry a team name, not change/<change>.
      branch: repos.find((r) => r.repo === master)?.branch ?? null,
      repos: repos.map((r) => ({ repo: r.repo, base: r.base.base, view: views.find((v) => v.repo === r.repo) ?? null })),
      departures: this.status()?.departures ?? [],
    });
  }

  private masterDir(): string | null {
    const w = this.current();
    const scan = this.scan();
    const repo = scan ? masterRepo(scan) : null;
    return w && repo ? masterPath(w.folder, repo) : null;
  }

  /** Accept a document of the change the page shows: the plugin commits it and runs the team's accepting hooks. */
  private async acceptDocument(doc: ChangeDocument): Promise<void> {
    const ref = this.draftRef();
    if (ref === null) return;
    let out: AcceptOutcome;
    try {
      out = await this.transport.sdlcAccept(ref, doc);
    } catch (e) {
      this.toasts.error(`Could not accept the ${doc}: ${message(e)}`);
      return;
    }
    switch (out.outcome) {
      case 'accepted':
        if (out.warnings.length === 0) this.toasts.success(`Accepted ${doc} · committed`);
        else this.toasts.info([`Accepted ${doc} · committed, with warnings from the plugin.`, ...out.warnings].join('\n'));
        break;
      case 'acceptedHookFailed':
        this.toasts.error(`Accepted ${doc} and committed it, but ${out.hook === null ? 'a hook on accepting' : `the hook ${out.hook}`} failed.\n${[...out.problems, outputTail(out.output)].filter((s) => s !== '').join('\n')}`);
        break;
      case 'acceptedHookCouldNotRun':
        this.toasts.error(`Accepted ${doc} and committed it, but this machine could not run the hooks on accepting.\n${outputTail(out.output)}`);
        break;
      case 'notCommitted':
        this.toasts.error(`The ${doc} was not committed.\n${out.problems.join('\n')}`);
        break;
      case 'couldNotRun':
        this.toasts.error(`Could not accept the ${doc}: ${out.message}`);
        break;
    }
    await this.load();
  }

  /** Reject the change the page shows through the plugin; once it is gone the page goes back to the workspace. */
  private async rejectChange(): Promise<void> {
    const ref = this.draftRef();
    if (ref === null) return;
    let out: RejectOutcome;
    try {
      out = await this.transport.sdlcReject(ref);
    } catch (e) {
      this.toasts.error(`Could not reject the change: ${message(e)}`);
      return;
    }
    switch (out.outcome) {
      case 'rejected':
        this.toasts.success(rejectedSaid(out.recordBranch));
        await this.toHome();
        return;
      case 'rejectedNotRemoved':
        this.toasts.error(`Rejected and committed, but the change's copy was not removed.\n${out.problems.join('\n')}`);
        break;
      case 'refused':
        this.toasts.error(out.message);
        break;
      case 'notCommitted':
        this.toasts.error(`The rejection was not committed.\n${out.problems.join('\n')}`);
        break;
      case 'couldNotRun':
        this.toasts.error(`Could not reject the change: ${out.message}`);
        break;
    }
    await this.load();
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
        built = specFor(run.kind, action, ctx, settings, this.catalog(), restrictedFor(workspace.folder, scan));
      } else {
        built = specFor(run.kind, action, ctx, settings, this.catalog());
      }
    } catch (e) {
      this.toasts.error(`Could not prepare the run: ${message(e)}`);
      return;
    }
    let spec: RunSpec | null;
    const ref = { workspace: workspace.folder, system: this.system(), change: this.changeName() };
    try {
      // The preview shows the run-spec the backend composes for this form, the one `sdlcRunChange` launches.
      const shown = await this.transport.sdlcPreviewChangeRun(ref, run.kind, documentForm(built));
      spec = await this.preview.open({ spec: shown, mode: 'sdlc', workdir: shown.workdir, from: { session: this.givens.session(), job: null, build: null } });
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
    }, { ref, kind: run.kind });
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
      return { kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' };
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

  /** Whether the change is done and with which links, from the plugin's record at once, without asking GitHub. A failed read is not an error, it just leaves the change unfinished. */
  private async readPullRequests(folder: string, workspaceId: string, system: string, name: string, buildFinished: boolean): Promise<{ view: PullRequestsView; failed: boolean }> {
    try {
      return { view: await this.transport.sdlcPullRequestsView(folder, workspaceId, system, name, false), failed: false };
    } catch {
      return { view: { done: false, source: null, links: [], declareOffered: buildFinished }, failed: buildFinished };
    }
  }

  private applyPullRequests(view: PullRequestsView, failed: boolean): void {
    this.done.set(view.done);
    this.pullRequests.set(view.links);
    this.prCheckFailed.set(failed);
    this.linksFrom.set(view.source);
  }

  /** Ask the plugin for the links' states without holding the page: the links stay as they are until it answers. A link it could not read keeps the state last seen, and all of them do when it cannot answer. */
  private async refreshLinks(seq: number, folder: string, workspaceId: string, system: string, name: string): Promise<void> {
    let view: PullRequestsView | null;
    try {
      view = await this.transport.sdlcPullRequestsView(folder, workspaceId, system, name, true);
    } catch {
      view = null;
    }
    if (seq !== this.loadSeq) return;
    const before = this.pullRequests();
    const kept = (l: PullRequestLink): PullRequestLink => {
      const earlier = before.find((b) => b.url === l.url);
      return { ...l, state: earlier?.state ?? null, lastSeen: true, seenAt: earlier?.seenAt ?? null };
    };
    const links = view === null ? before.map((l) => (l.state === null ? kept(l) : l)) : view.links.map((l) => (l.state === null ? kept(l) : l));
    this.pullRequests.set(links);
  }

  /** Read this one change; a change the workspace does not have is none, any other failure is raised. */
  private async readOwnChange(folder: string, system: string, name: string): Promise<{ info: ChangeView | null }> {
    try {
      return { info: await this.transport.sdlcChangeState(folder, system, name) };
    } catch (e) {
      if (/there is no change|no change folder/.test(message(e))) return { info: null };
      throw e;
    }
  }

  /** The branch the master repository records for the change; null when it cannot be read, which leaves change/<change>. */
  private async readRecordedBranch(folder: string, master: string, system: string, name: string): Promise<string | null> {
    try {
      return (await this.transport.sdlcChangeRepos(folder, master, system, name)).find((r) => r.repo === master)?.branch ?? null;
    } catch {
      return null;
    }
  }

  /** Read the change from disk. A newer call supersedes an older one still in flight. */
  /** A run picked from the running changes may belong to another workspace than the open one: make that workspace the open one, as picking it in the switcher does, before the page reads the change. */
  private async openAskedWorkspace(workspaces: WorkspaceEntry[], system: string, change: string): Promise<void> {
    const asked = this.landing.pending();
    if (asked === null || asked.system !== system || asked.change !== change) return;
    const target = workspaces.find((w) => w.id === asked.workspaceId);
    if (target === undefined || target.id === this.current()?.id) return;
    const next = workspaces.map((w) => (w.id === target.id ? { ...w, last_opened: nowSecs() } : w));
    this.workspaces.set(next);
    try {
      await this.transport.sdlcSaveWorkspaces(next);
    } catch (e) {
      this.toasts.error(`Could not save the workspace list: ${message(e)}`);
    }
  }

  /** Show the run the engineer picked from the running changes: a build or review run on the Build tab with its repository (or the review) picked, where its question waits; a document run is this change's own session, already on show. */
  private land(run: OpenRun): void {
    if (run.kind === 'review') this.build.choose({ kind: 'review' });
    else if (run.kind === 'build' && run.repo !== null) this.build.choose({ kind: 'repo', repo: run.repo });
    else return;
    // The run the engineer asked for wins over the mode they left: the stage's own mode shows it.
    const ref = this.draftRef();
    if (ref !== null) this.drafts.setMode(ref, null);
    this.layout?.showSuited();
    this.picked.set('build');
    this.rememberTab();
  }

  private rememberTab(): void {
    const ref = this.draftRef();
    if (ref !== null) this.drafts.setTab(ref, this.picked());
  }

  /** The change the page last opened on the tab the engineer left it on, so a reload of the same change starts over as before. */
  private restoredFor: string | null = null;

  /**
   * Open the tab the engineer left this change on. A run picked from the running changes wins over it: the engineer asked for that
   * run just now, and its request is still waiting, so the remembered tab is left as it is for the run to replace.
   */
  private restoreTab(): void {
    const ref = this.draftRef();
    if (ref === null) return;
    const key = changeRunKey(ref);
    if (this.restoredFor !== key) {
      this.restoredFor = key;
      const asked = this.landing.pending();
      const tab = this.drafts.tab(ref);
      if (asked !== null && asked.system === ref.system && asked.change === ref.change) return;
      if (tab !== null && tab !== this.shownDoc()) void this.showDoc(tab);
    } else {
      this.drafts.setTab(ref, null);
    }
  }

  /** The change leaves the running changes once nothing of it needs them: best effort, a failure changes nothing on the page. */
  private tellOpened(workspace: string, system: string, change: string): void {
    const key = `${workspace}|${system}/${change}`;
    if (key === this.openedKey) return;
    this.openedKey = key;
    this.transport.sdlcMarkOpened({ workspace, system, change }).catch(() => undefined);
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const system = this.system();
    const name = this.changeName();
    this.progress.begin('reading-change', progressLabels.readingChange(), 'page');
    // A failed read clears its progress line before the error toast shows.
    const failRead = () => {
      if (seq === this.loadSeq) this.progress.fail('page');
    };
    const finish = (state: ChangeState, change: ChangeView | null, doc: string | null, read: ReadResult | ReadError | null = null) => {
      if (seq !== this.loadSeq) return;
      this.progress.end('page');
      this.progress.end('doc');
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
      failRead();
      this.toasts.error(`Could not read the workspace list: ${message(e)}`);
      finish('not-found', null, null);
      return;
    }
    if (seq !== this.loadSeq) return;
    this.workspaces.set(workspaces);
    await this.openAskedWorkspace(workspaces, system, name);
    if (seq !== this.loadSeq) return;
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
      const [branches, own, links, records, catalog, recorded] = await Promise.all([
        this.transport.sdlcBranches(master),
        this.readOwnChange(w.folder, system, name),
        this.transport.sdlcRunLinks(),
        this.transport.listRuns(),
        this.transport.catalog(w.folder),
        this.readRecordedBranch(w.folder, repo, system, name),
      ]);
      const found = own.info;
      const doc = found ? await this.transport.sdlcReadDoc(master, system, name, stemFor(found)) : null;
      const read = found ? await this.readParsed(master, system, name, stemFor(found)) : null;
      const status = found?.state.documents.plan.exists ? await this.readStatus(master, system, name) : null;
      const readiness = await this.readReadiness(w.folder);
      const review = found?.state.documents.plan.exists ? await this.readReviewRecord(master, system, name) : null;
      const buildFinished = stageNameOf(found ?? null) === 'build-finished';
      const pulls = found?.state.documents.plan.exists
        ? await this.readPullRequests(w.folder, w.id, system, name, buildFinished)
        : { view: { done: false, source: null, links: [], declareOffered: false } satisfies PullRequestsView, failed: false };
      if (seq !== this.loadSeq) return;
      this.applyPullRequests(pulls.view, pulls.failed);
      this.status.set(status);
      this.readiness.set(readiness);
      this.reviewRecord.set(review);
      this.scan.set(scan);
      this.branches.set(branches);
      this.recordedBranch.set(recorded);
      this.links.set(links);
      this.records.set(records);
      this.catalog.set(catalog);
      finish(found ? 'ready' : 'not-found', found, doc, read);
      if (found) this.restoreTab();
      if (found) this.tellOpened(w.folder, system, name);
      // The copy line shows at once; what the slow backend answers about it arrives later and is shown only when it does.
      if (found?.state.inCopy) this.readCopy(seq, { workspace: w.folder, system, change: name });
      else {
        this.copyBranchName.set(null);
        this.removal.set({ outcome: 'notOffered' });
      }
      // The build page shows the change's tasks, sessions and findings whether or not a build ran on this page.
      const context = this.buildContext();
      if (found && context !== null) this.build.loaded.set({ ctx: context, master: { repo, path: master }, change: found, status, done: this.done(), review });
      // The recorded links show first; the plugin reads their states from GitHub in the background. Pull requests an earlier version of Kata saved are not read: the plugin does not know them.
      if (found && pulls.view.source === 'plugin' && pulls.view.links.length > 0) void this.refreshLinks(seq, w.folder, w.id, system, name);
    } catch (e) {
      failRead();
      this.toasts.error(`Could not read the change: ${message(e)}`);
      finish('not-found', null, null);
    }
  }
}
