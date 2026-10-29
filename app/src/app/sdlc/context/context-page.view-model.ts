import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { ContextState } from '@bindings/ContextState';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { LockStore } from '../../core/lock/lock.store';
import { ModeStore } from '../../core/mode/mode.store';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { parseFrontMatter } from '../../lib/sdlc';
import { contextAction, contextLabel, masterPath, masterRepo, readContextStates, repoRows } from '../../lib/sdlc-workspace';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSecs = () => Math.floor(Date.now() / 1000);

export type ContextPageState = 'loading' | 'not-found' | 'ready';

/**
 * The context screen: one product repo's `intent/<system>/context/<repo>.md`, read-only, beside the list of the
 * workspace's product repos and their context state. It reads; it runs nothing. Run or Refresh context hands the repo
 * to the workspace home, which owns the run with its preview, branch check, session and leftovers.
 */
@Injectable()
export class ContextPageViewModel {
  private readonly transport = inject(KataTransport);
  private readonly lock = inject(LockStore);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  readonly system = computed(() => this.params().get('system') ?? '');
  readonly repo = computed(() => this.params().get('repo') ?? '');

  readonly state = signal<ContextPageState>('loading');
  readonly workspaces = signal<WorkspaceEntry[]>([]);
  readonly current = computed(() => [...this.workspaces()].sort((a, b) => b.last_opened - a.last_opened)[0] ?? null);
  private readonly scan = signal<WorkspaceScan | null>(null);
  private readonly branches = signal<BranchInfo | null>(null);
  private readonly contexts = signal<Record<string, ContextState>>({});
  /** The picked repo's context file: `null` when there is none, `undefined` while it is read. */
  readonly text = signal<string | null | undefined>(undefined);

  readonly locked = computed(() => this.lock.active() !== null);
  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly crumbs = computed(() => [`${this.repo()} · context`]);
  /** Every repo but the master: the ones a context file describes. */
  readonly rows = computed(() => {
    const s = this.scan();
    return s ? repoRows(s, this.contexts()).filter((r) => r.role !== 'master') : [];
  });
  readonly picked = computed(() => this.rows().find((r) => r.name === this.repo()) ?? null);
  readonly pickedLabel = computed(() => contextLabel(this.picked()?.context ?? null));
  readonly action = computed(() => contextAction(this.picked()?.context ?? null));
  /** The file split into its front matter fields and the text under them. */
  readonly doc = computed(() => {
    const text = this.text();
    return typeof text === 'string' ? parseFrontMatter(text) : null;
  });

  private loaded: Promise<string | null> | null = null;
  private readSeq = 0;

  constructor() {
    // The router reuses this screen when only the repo moves, so the read follows the params, not a snapshot.
    effect(() => {
      this.system();
      this.repo();
      untracked(() => void this.read());
    });
  }

  readonly label = contextLabel;

  /** Show another repo's context. */
  openRepo(repo: string): Promise<boolean> {
    const row = this.rows().find((r) => r.name === repo);
    return this.router.navigate(['/sdlc', row?.system ?? this.system(), 'context', repo]);
  }

  /** Run or refresh this repo's context: the workspace home starts it, as it does from its Repositories table. */
  runContext(): Promise<boolean> {
    return this.router.navigate(['/sdlc'], { queryParams: { context: this.repo() } });
  }

  toHome(): Promise<boolean> {
    return this.router.navigate(['/sdlc']);
  }

  /** Switching workspace leaves this screen: the repo belongs to the workspace that was open. */
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

  /** The master folder of the open workspace, read once; null when there is none. */
  private master(): Promise<string | null> {
    this.loaded ??= this.loadWorkspace();
    return this.loaded;
  }

  private async loadWorkspace(): Promise<string | null> {
    try {
      this.workspaces.set(await this.transport.sdlcWorkspaces());
      const w = this.current();
      if (!w) return null;
      const scan = await this.transport.sdlcScan(w.folder);
      const repo = masterRepo(scan);
      if (repo === null) return null;
      const master = masterPath(w.folder, repo);
      const [branches, contexts] = await Promise.all([
        this.transport.sdlcBranches(master),
        readContextStates(scan, (m, s, r) => this.transport.sdlcContextHealth(w.folder, m, s, r)),
      ]);
      this.scan.set(scan);
      this.branches.set(branches);
      this.contexts.set(contexts);
      return master;
    } catch (e) {
      this.toasts.error(`Could not read the workspace: ${message(e)}`);
      return null;
    }
  }

  /** Read the picked repo's context file. A newer read supersedes an older one still in flight. */
  private async read(): Promise<void> {
    const seq = ++this.readSeq;
    this.text.set(undefined);
    const master = await this.master();
    if (seq !== this.readSeq) return;
    if (master === null) {
      this.state.set('not-found');
      return;
    }
    let text: string | null = null;
    try {
      text = await this.transport.sdlcReadContext(master, this.system(), this.repo());
    } catch (e) {
      this.toasts.error(`Could not read the context of ${this.repo()}: ${message(e)}`);
    }
    if (seq !== this.readSeq) return;
    this.text.set(text);
    this.state.set('ready');
  }
}
