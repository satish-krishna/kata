import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { Decision } from '@bindings/Decision';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
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
const NO_COUNTS: StepCounts = { intent: 0, spec: 0, plan: 0 };

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
        await this.commitDecision(action, false);
        return;
      case 'commit-acceptance':
        await this.commitDecision(this.change()?.stage === 'intent-accepted-uncommitted' ? 'accept-intent' : 'accept-spec', false);
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

  async discardLeftovers(paths: string[]): Promise<void> {
    await this.runner.discard(paths);
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
      if (seq !== this.loadSeq) return;
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
