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
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
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
  revisits,
  runCounts,
  specFor,
  splitFrontMatter,
  stageLabel,
  type DocsPresent,
  type StageAction,
  type StepCounts,
} from '../../lib/sdlc';
import { inTauri } from '../../lib/mock';
import { masterPath, masterRepo, productRepos } from '../../lib/sdlc-workspace';

export type ChangeState = 'loading' | 'ready' | 'not-found';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSecs = (): number => Math.floor(Date.now() / 1000);
const BUSY = 'Another task is already running.';
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
const SUPERSEDED_BANNER = 'The intent was reopened after this plan was written. Rewrite the plan before building.';

/** What the build view starts from: the prepared branches, the time limit, the round if one was asked for, and Kata's checks folder. */
export type BuildHandoff = {
  start: BuildStart;
  timeoutSecs: number;
  round: { instructions: string; repo: string } | null;
  checksDir: string;
};

type DocStem = 'intent' | 'spec' | 'plan';

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
  readonly change = signal<ChangeInfo | null>(null);
  /** The shown document, raw as it is on disk, or null when the file is missing. */
  readonly doc = signal<string | null>(null);
  /** The document the operator picked from the tiles; null shows the current stage's. Every load clears it. */
  private readonly picked = signal<DocStem | null>(null);
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

  readonly shownDoc = computed<DocStem>(() => {
    const c = this.change();
    return this.picked() ?? (c ? docFor(c) : 'intent');
  });
  readonly docs = computed<DocsPresent>(() => {
    const c = this.change();
    return { intent: c?.intent.exists ?? false, spec: c?.spec.exists ?? false, plan: c?.plan.exists ?? false };
  });
  readonly docName = computed(() => `${this.shownDoc()}.md`);
  readonly stems: readonly DocStem[] = ['intent', 'spec', 'plan'];
  readonly docParts = computed(() => splitFrontMatter(this.doc() ?? ''));
  readonly actions = computed(() => {
    const c = this.change();
    return c ? actionsForChange(c) : [];
  });
  /** What blocks the build, shown above the plan; null when nothing does or another document is shown. */
  readonly planBanner = computed(() => {
    const c = this.change();
    if (c === null || this.shownDoc() !== 'plan') return null;
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
      if (seq !== this.loadSeq) return;
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
