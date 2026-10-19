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
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import {
  actionLabel,
  actionsFor,
  primaryAction,
  runCounts,
  specFor,
  splitFrontMatter,
  stageLabel,
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
  'start-plan': { kind: 'plan', title: 'Starting plan', label: 'Plan' },
  'rerun-plan': { kind: 'plan', title: 'Re-running plan', label: 'Plan' },
};

const FILE: Record<Decision, 'intent.md' | 'spec.md'> = {
  'accept-intent': 'intent.md',
  'reject-intent': 'intent.md',
  'accept-spec': 'spec.md',
};
const DONE: Record<Decision, string> = {
  'accept-intent': 'Accepted intent',
  'reject-intent': 'Rejected intent',
  'accept-spec': 'Accepted spec',
};

type DocStem = 'intent' | 'spec' | 'plan';

/**
 * The document the page shows for a change: the current stage's, falling back to the last one that exists.
 * A stem, because that is what the backend's `read_doc` accepts; the page shows it as `<stem>.md`.
 */
function docFor(c: ChangeInfo): DocStem {
  const step = stageLabel(c.stage).step;
  if (step === 'plan') return c.plan.exists ? 'plan' : c.spec.exists ? 'spec' : 'intent';
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
  /** The current stage's document, raw as it is on disk, or null when the file is missing. */
  readonly doc = signal<string | null>(null);
  private loadSeq = 0;

  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly crumbs = computed(() => (this.changeName() === '' ? [] : [this.changeName()]));
  readonly counts = computed(() => {
    const w = this.current();
    const n = this.changeTotal();
    return w && n !== null ? { [w.id]: n } : {};
  });

  readonly docName = computed(() => {
    const c = this.change();
    return `${c ? docFor(c) : 'intent'}.md`;
  });
  readonly docParts = computed(() => splitFrontMatter(this.doc() ?? ''));
  readonly actions = computed(() => {
    const c = this.change();
    return c ? actionsFor(c.stage) : [];
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

  // --- the lock, as the overlay reads it
  readonly locked = computed(() => this.lock.active() !== null);
  readonly lockView = this.lock.active;
  readonly lockElapsed = this.lock.elapsedSecs;
  readonly lockLastTool = this.lock.lastTool;
  readonly lockTurn = this.lock.turn;
  readonly lockModel = this.lock.model;
  readonly lockAsk = this.lock.ask;
  readonly lockPermission = this.lock.permission;
  readonly lockDeadline = this.lock.deadlineSecs;
  readonly leftovers = this.runner.leftovers;

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
    if (this.state() === 'ready') await this.act('continue-spec');
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
        await this.runStage(action);
    }
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

  private async runStage(action: StageAction): Promise<void> {
    const run = RUNS[action];
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!run || !workspace || !scan || !master) return;
    let spec;
    try {
      const settings = this.modes.settings() ?? (await this.modes.load());
      spec = specFor(run.kind, action, { folder: workspace.folder, system: this.system(), change: this.changeName() }, settings, this.catalog());
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
