import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ContextState } from '@bindings/ContextState';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { inTauri } from '../../lib/mock';
import { hasAiSdlcPlugin, specFor } from '../../lib/sdlc';
import { DEMO_SETUP_FOLDER } from '../../lib/demo';
import {
  folderName,
  isSetUp,
  lastRunTimes,
  masterPath,
  masterRepo,
  productRepos,
  repoRows,
  systemNames,
  systemOf,
  type WorkspaceCandidate,
} from '../../lib/sdlc-workspace';
import type { SettingsSave } from '../../ui/sdlc-settings-dialog';

export type HomeState =
  | 'loading'
  | 'plugin-missing'
  | 'no-workspaces'
  | 'folder-missing'
  | 'master-gone'
  | 'many-masters'
  | 'marker-error'
  | 'not-set-up'
  | 'ready';

type Health = { missing: boolean; changes: number | null };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const nowSecs = (): number => Math.floor(Date.now() / 1000);
/** One spelling per folder: forward slashes, no trailing separator, case-insensitive (Windows paths). */
const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * The AI-SDLC workspace home: which workspace is open, what it contains, and every action that starts from
 * it. Long work goes through `SdlcRunner`; this class only decides what to run and refreshes afterwards.
 */
@Injectable()
export class SdlcHomeViewModel {
  private readonly transport = inject(KataTransport);
  private readonly lock = inject(LockStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  // --- workspaces
  readonly workspaces = signal<WorkspaceEntry[]>([]);
  private readonly currentId = signal<string | null>(null);
  readonly current = computed(() => this.workspaces().find((w) => w.id === this.currentId()) ?? null);
  private readonly health = signal<Record<string, Health>>({});
  readonly missing = computed(() => Object.entries(this.health()).filter(([, h]) => h.missing).map(([id]) => id));
  readonly counts = computed(() => {
    const out: Record<string, number> = {};
    for (const [id, h] of Object.entries(this.health())) if (h.changes !== null) out[id] = h.changes;
    return out;
  });

  // --- what the current workspace holds
  private readonly catalog = signal<CatalogEntry[] | null>(null);
  readonly pluginMissing = computed(() => this.catalog() !== null && !hasAiSdlcPlugin(this.catalog() ?? []));
  readonly scan = signal<WorkspaceScan | null>(null);
  readonly scanError = signal<string | null>(null);
  readonly branches = signal<BranchInfo | null>(null);
  readonly changes = signal<ChangeInfo[]>([]);
  readonly contexts = signal<Record<string, ContextState>>({});
  readonly lastRuns = signal<Record<string, number>>({});
  private readonly loaded = signal(false);
  private loadSeq = 0;

  readonly masters = computed(() => {
    const m = this.scan()?.master;
    return m?.kind === 'many' ? m.repos : [];
  });
  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly otherBranches = computed(() => this.branches()?.others ?? []);
  readonly systems = computed(() => {
    const s = this.scan();
    return s ? systemNames(s) : [];
  });
  readonly repoRows = computed(() => {
    const s = this.scan();
    return s ? repoRows(s, this.contexts()) : [];
  });
  readonly markerLine = computed(() => {
    const s = this.scan();
    if (!s?.marker) return '';
    return `.ai-sdlc.json in ${masterRepo(s) ?? 'the master repo'} · ${plural(this.systems().length, 'system', 'systems')}`;
  });

  readonly state = computed<HomeState>(() => {
    if (!this.loaded()) return 'loading';
    if (this.pluginMissing()) return 'plugin-missing';
    if (this.current() === null) return 'no-workspaces';
    if (this.scanError() !== null) return 'folder-missing';
    const scan = this.scan();
    if (scan === null) return 'loading';
    if (scan.master.kind === 'none') return 'master-gone';
    if (scan.master.kind === 'many') return 'many-masters';
    if (scan.marker_error !== null) return 'marker-error';
    return isSetUp(scan) ? 'ready' : 'not-set-up';
  });
  /** Anything that starts work in a workspace is offered only here. */
  readonly canWork = computed(() => this.state() === 'ready');

  readonly settings = computed<Settings | null>(() => this.modes.settings());

  // --- dialogs
  readonly candidate = signal<WorkspaceCandidate | null>(null);
  readonly newChangeOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly switchPrompt = signal<string | null>(null);
  private switchResolve: ((ok: boolean) => void) | null = null;
  private readonly removeId = signal<string | null>(null);
  readonly removePrompt = computed(() => {
    const w = this.workspaces().find((x) => x.id === this.removeId());
    return w ? `Remove ${w.name} from the list? Nothing on disk is touched.` : null;
  });
  readonly leftovers = this.runner.leftovers;
  /** The session view's Close waits for the run's after-run work and for any leftover decision. */
  readonly closeBlocked = computed(() => this.runner.settling() || this.runner.leftovers() !== null);

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

  private readonly masterDir = computed(() => {
    const w = this.current();
    const repo = this.scan() ? masterRepo(this.scan()!) : null;
    return w && repo ? masterPath(w.folder, repo) : null;
  });

  /** `demo` is the `?demo=` query value: `sdlc-setup` opens the add-workspace flow on a folder that needs setup. Browser only. */
  async init(demo: string | null = null): Promise<void> {
    try {
      await this.modes.load();
    } catch (e) {
      this.toasts.error(`Could not read the settings: ${message(e)}`);
    }
    try {
      const list = await this.transport.sdlcWorkspaces();
      this.workspaces.set(list);
      const newest = [...list].sort((a, b) => b.last_opened - a.last_opened)[0];
      this.currentId.set(newest?.id ?? null);
    } catch (e) {
      this.toasts.error(`Could not read the workspace list: ${message(e)}`);
    }
    await Promise.all([this.loadCatalog(), this.loadCurrent(), this.probeOthers()]);
    this.loaded.set(true);
    // Browser dev/review only: never fires under Tauri.
    if (!inTauri() && demo === 'sdlc-setup') await this.addWorkspace(DEMO_SETUP_FOLDER);
  }

  // --- workspace list

  async selectWorkspace(id: string): Promise<void> {
    const w = this.workspaces().find((x) => x.id === id);
    if (!w) return;
    const next = this.workspaces().map((x) => (x.id === id ? { ...x, last_opened: nowSecs() } : x));
    this.workspaces.set(next);
    this.currentId.set(id);
    await this.saveList(next);
    await Promise.all([this.loadCatalog(), this.loadCurrent()]);
  }

  askRemove(): void {
    this.removeId.set(this.currentId());
  }

  cancelRemove(): void {
    this.removeId.set(null);
  }

  async confirmRemove(): Promise<void> {
    const id = this.removeId();
    this.removeId.set(null);
    if (id !== null) await this.removeWorkspace(id);
  }

  /** Forget a workspace. Nothing on disk is touched. */
  async removeWorkspace(id: string): Promise<void> {
    const next = this.workspaces().filter((w) => w.id !== id);
    this.workspaces.set(next);
    await this.saveList(next);
    if (this.currentId() === id) {
      this.currentId.set([...next].sort((a, b) => b.last_opened - a.last_opened)[0]?.id ?? null);
      await Promise.all([this.loadCatalog(), this.loadCurrent()]);
    }
  }

  // --- add workspace

  async addWorkspace(picked: string | null = null): Promise<void> {
    if (this.refuseWhileLocked()) return;
    let folder: string | null = picked;
    try {
      folder ??= await this.transport.pickDirectory();
    } catch (e) {
      this.toasts.error(`Could not open the folder picker: ${message(e)}`);
      return;
    }
    if (!folder) return;
    const dir = folder;
    const existing = this.workspaces().find((w) => sameFolder(w.folder, dir));
    if (existing) {
      this.toasts.info('That folder is already in the list.');
      await this.selectWorkspace(existing.id);
      return;
    }

    const found: { scan: WorkspaceScan | null; contexts: Record<string, ContextState> } = { scan: null, contexts: {} };
    const outcome = await this.lock.runSteps('Checking workspace', [
      {
        label: 'Scan folder for repos',
        run: async () => {
          found.scan = await this.transport.sdlcScan(dir);
          return plural(found.scan.repos.length, 'repo', 'repos');
        },
      },
      {
        label: 'Find master repo',
        run: async () => {
          const m = found.scan?.master;
          return m?.kind === 'one' ? m.repo : m?.kind === 'many' ? `${m.repos.length} candidates` : 'none';
        },
      },
      {
        label: 'Read .ai-sdlc.json',
        run: async () => {
          const s = found.scan;
          if (s?.marker) return plural(Object.keys(s.marker.systems).length, 'system', 'systems');
          return s?.marker_error ?? 'not committed';
        },
      },
      {
        label: 'Check context staleness',
        run: async () => {
          if (!found.scan || !isSetUp(found.scan)) return 'skipped';
          found.contexts = await this.readContexts(dir, found.scan);
          return plural(Object.keys(found.contexts).length, 'repo', 'repos');
        },
      },
      {
        label: 'List changes',
        run: async () => {
          if (!found.scan || !isSetUp(found.scan)) return 'skipped';
          return plural(await this.countChanges(dir, found.scan), 'change', 'changes');
        },
      },
    ]);
    let scan = found.scan as WorkspaceScan | null;
    if (outcome === 'cancelled') {
      this.toasts.info('Workspace check cancelled. Nothing was added.');
      return;
    }
    if (outcome !== 'done' || scan === null) return;

    const name = folderName(dir);
    if (scan.repos.length === 0 || scan.master.kind === 'many') {
      this.candidate.set({ folder: dir, name, scan, contexts: {}, baseBranch: '' });
      return;
    }
    if (scan.marker_error !== null) {
      this.toasts.error(`.ai-sdlc.json could not be read: ${scan.marker_error}`);
      return;
    }
    let contexts = found.contexts;
    if (!isSetUp(scan)) {
      const ran = await this.runSetup(dir, scan);
      if (ran === null) return;
      scan = ran;
      try {
        contexts = await this.readContexts(dir, scan);
      } catch (e) {
        this.toasts.error(`Could not read the context health: ${message(e)}`);
        return;
      }
    }
    const repo = masterRepo(scan);
    if (repo === null) return;
    let baseBranch = 'main';
    try {
      const b = await this.transport.sdlcBranches(masterPath(dir, repo));
      baseBranch = b.default_base ?? b.current ?? baseBranch;
    } catch (e) {
      this.toasts.error(`Could not read the master repo's branches: ${message(e)}`);
      return;
    }
    this.candidate.set({ folder: dir, name, scan, contexts, baseBranch });
  }

  async confirmAddWorkspace(): Promise<void> {
    const c = this.candidate();
    this.candidate.set(null);
    if (!c || !isSetUp(c.scan)) return;
    const taken = new Set(this.workspaces().map((w) => w.id));
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
    let id = slug;
    for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
    const entry: WorkspaceEntry = { id, name: c.name, folder: c.folder, base_branch: c.baseBranch, last_opened: nowSecs() };
    const next = [...this.workspaces(), entry];
    this.workspaces.set(next);
    this.currentId.set(id);
    await this.saveList(next);
    await Promise.all([this.loadCatalog(), this.loadCurrent()]);
  }

  cancelAddWorkspace(): void {
    this.candidate.set(null);
  }

  // --- runs

  async runContext(repo: string): Promise<void> {
    const scan = this.scan();
    if (!scan || this.refuseWhileLocked()) return;
    const system = systemOf(scan, repo) ?? systemNames(scan)[0] ?? '';
    await this.runOnBase('Reading context', 'Context', 'context', { system, repos: [repo] });
  }

  /** Setup is idempotent and supports adding a system, so Add system simply runs it again. */
  async addSystem(): Promise<void> {
    if (this.refuseWhileLocked()) return;
    await this.runOnBase('Running setup', 'Setup', 'setup', { system: '' });
  }

  async newChange(system: string, idea: string): Promise<void> {
    this.newChangeOpen.set(false);
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    try {
      await this.runner.newChange({ workspace, master, productRepos: productRepos(scan) }, system, idea);
    } catch (e) {
      this.toasts.error(`Could not start the change: ${message(e)}`);
    }
    await this.loadCurrent();
  }

  openNewChange(): void {
    if (!this.refuseWhileLocked()) this.newChangeOpen.set(true);
  }

  closeNewChange(): void {
    this.newChangeOpen.set(false);
  }

  async discardLeftovers(choices: DiscardChoice[]): Promise<void> {
    await this.runner.discardAll(choices);
    await this.loadCurrent();
  }

  closeLeftovers(): void {
    this.runner.closeLeftovers();
  }

  // --- navigation

  async openChange(system: string, change: string): Promise<void> {
    try {
      await this.router.navigate(['/sdlc', system, change]);
    } catch (e) {
      this.toasts.error(`Could not open ${change}: ${message(e)}`);
    }
  }

  /** Check the change's branch out, then open the change. Git refuses on a dirty tree; its message is shown as is. */
  async openOtherBranch(change: string): Promise<void> {
    const master = this.masterDir();
    if (!master || this.refuseWhileLocked()) return;
    try {
      await this.transport.sdlcCheckout(master, `change/${change}`);
    } catch (e) {
      this.toasts.error(message(e));
      return;
    }
    await this.loadCurrent();
    const found = this.changes().find((c) => c.change === change);
    if (!found) {
      this.toasts.error(`Could not find ${change} on that branch.`);
      return;
    }
    await this.openChange(found.system, found.change);
  }

  switchMode(): Promise<void> {
    return this.modes.switchTo('workbench');
  }

  /** Re-read the catalog after the operator installs the plugin. */
  async recheckPlugin(): Promise<void> {
    await this.loadCatalog();
  }

  // --- settings

  openSettings(): void {
    this.settingsOpen.set(true);
  }

  closeSettings(): void {
    this.settingsOpen.set(false);
  }

  async saveSettings(save: SettingsSave): Promise<void> {
    try {
      await this.modes.save(save.settings);
    } catch (e) {
      this.toasts.error(`Could not save the settings: ${message(e)}`);
      return;
    }
    const w = this.current();
    if (w && save.baseBranch !== null && save.baseBranch !== w.base_branch) {
      await this.saveList(this.workspaces().map((x) => (x.id === w.id ? { ...x, base_branch: save.baseBranch! } : x)), true);
    }
    this.settingsOpen.set(false);
  }

  // --- the lock overlay and the branch confirm

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

  answerSwitch(ok: boolean): void {
    this.switchPrompt.set(null);
    const resolve = this.switchResolve;
    this.switchResolve = null;
    resolve?.(ok);
  }

  // --- internals

  private refuseWhileLocked(): boolean {
    if (this.lock.active() === null) return false;
    this.toasts.error('Another task is already running.');
    return true;
  }

  /** Setup and context describe the system, not a change, so their commits belong on the base branch. */
  private async runOnBase(
    title: string,
    label: string,
    kind: 'setup' | 'context',
    ctx: { system: string; repos?: string[] },
  ): Promise<void> {
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    if (!(await this.onBase(master, masterRepo(scan) ?? 'the master repo', workspace.base_branch))) return;
    const spec = specFor(kind, null, { folder: workspace.folder, change: null, ...ctx }, await this.currentSettings(), this.catalog() ?? []);
    await this.runner.run(title, spec, {
      workspaceId: workspace.id,
      master,
      productRepos: productRepos(scan),
      link: null,
      label,
    });
    await this.loadCurrent();
  }

  /** Run first-time setup for a folder. Returns the rescanned workspace, or null when it did not end set up. */
  private async runSetup(folder: string, scan: WorkspaceScan): Promise<WorkspaceScan | null> {
    const repo = masterRepo(scan);
    const master = repo ? masterPath(folder, repo) : null;
    if (master && repo && !(await this.onBase(master, repo, null))) return null;
    const spec = specFor('setup', null, { folder, system: '', change: null }, await this.currentSettings(), this.catalog() ?? []);
    const out = await this.runner.run('Running setup', spec, {
      workspaceId: folderName(folder),
      master,
      productRepos: productRepos(scan),
      link: null,
      label: 'Setup',
      // No master yet: snapshot every repo so a stopped setup can still report what it left in the master it made.
      firstSetup: master === null ? { folder, repos: scan.repos } : undefined,
    });
    if (out.state !== 'success') return null;
    let after: WorkspaceScan;
    try {
      after = await this.transport.sdlcScan(folder);
    } catch (e) {
      this.toasts.error(`Could not rescan ${folder}: ${message(e)}`);
      return null;
    }
    if (!isSetUp(after)) {
      this.toasts.error('Setup finished, but .ai-sdlc.json is not committed in the master repo.');
      return null;
    }
    return after;
  }

  /**
   * Offer to leave a change branch before a run that belongs on the base branch. `base` is null when the
   * workspace has no recorded base yet, in which case the repo's own default is used.
   */
  private async onBase(master: string, repo: string, base: string | null): Promise<boolean> {
    let info: BranchInfo;
    try {
      info = await this.transport.sdlcBranches(master);
    } catch (e) {
      // Without the branch there is no telling where a commit would land, so do not run.
      this.toasts.error(`Could not read the master repo's branch: ${message(e)}`);
      return false;
    }
    if (info.current === null) {
      // Detached or unreadable HEAD: there is no telling which branch a commit would land on.
      this.toasts.error(`${repo} is not on a branch (detached or unknown HEAD). Check out a branch first.`);
      return false;
    }
    const target = base ?? info.default_base;
    if (target === null || info.current === target) return true;
    if (!(await this.confirmSwitch(`Switch ${repo} to ${target} first?`))) return false;
    try {
      await this.transport.sdlcCheckout(master, target);
    } catch (e) {
      this.toasts.error(message(e));
      return false;
    }
    return true;
  }

  private confirmSwitch(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.switchResolve = resolve;
      this.switchPrompt.set(prompt);
    });
  }

  private async currentSettings(): Promise<Settings> {
    return this.modes.settings() ?? (await this.modes.load());
  }

  private async saveList(list: WorkspaceEntry[], adopt = false): Promise<void> {
    try {
      await this.transport.sdlcSaveWorkspaces(list);
      if (adopt) this.workspaces.set(list);
    } catch (e) {
      this.toasts.error(`Could not save the workspace list: ${message(e)}`);
    }
  }

  private async loadCatalog(): Promise<void> {
    try {
      this.catalog.set(await this.transport.catalog(this.current()?.folder ?? null));
    } catch (e) {
      // Unknown is not "missing": do not block the screen on a failed read.
      this.catalog.set(null);
      this.toasts.error(`Could not read the plugin catalog: ${message(e)}`);
    }
  }

  private async readContexts(folder: string, scan: WorkspaceScan): Promise<Record<string, ContextState>> {
    const repo = masterRepo(scan);
    if (repo === null) return {};
    const out: Record<string, ContextState> = {};
    const jobs = Object.entries(scan.marker?.systems ?? {}).flatMap(([system, def]) =>
      (def?.repos ?? []).filter((r) => r !== repo && !(r in out)).map(async (r) => {
        out[r] = await this.transport.sdlcContextHealth(folder, repo, system, r);
      }),
    );
    await Promise.all(jobs);
    return out;
  }

  private async listChanges(folder: string, scan: WorkspaceScan): Promise<ChangeInfo[]> {
    const repo = masterRepo(scan);
    if (repo === null) return [];
    const master = masterPath(folder, repo);
    const lists = await Promise.all(systemNames(scan).map((s) => this.transport.sdlcChanges(master, s)));
    return lists.flat();
  }

  private async countChanges(folder: string, scan: WorkspaceScan): Promise<number> {
    return (await this.listChanges(folder, scan)).length;
  }

  private markHealth(id: string, health: Health): void {
    this.health.update((h) => ({ ...h, [id]: health }));
  }

  /** Reachability and change counts for the workspaces the switcher lists but the screen is not showing. */
  private async probeOthers(): Promise<void> {
    await Promise.all(
      this.workspaces()
        .filter((w) => w.id !== this.currentId())
        .map(async (w) => {
          try {
            const scan = await this.transport.sdlcScan(w.folder);
            this.markHealth(w.id, { missing: false, changes: isSetUp(scan) ? await this.countChanges(w.folder, scan) : null });
          } catch {
            this.markHealth(w.id, { missing: true, changes: null });
          }
        }),
    );
  }

  private clearDetail(): void {
    this.scan.set(null);
    this.branches.set(null);
    this.changes.set([]);
    this.contexts.set({});
    this.lastRuns.set({});
  }

  /** Read the current workspace from disk. A newer call supersedes an older one still in flight. */
  private async loadCurrent(): Promise<void> {
    const seq = ++this.loadSeq;
    const w = this.current();
    this.scanError.set(null);
    if (!w) {
      this.clearDetail();
      return;
    }
    let scan: WorkspaceScan;
    try {
      scan = await this.transport.sdlcScan(w.folder);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.clearDetail();
      this.scanError.set(message(e));
      this.markHealth(w.id, { missing: true, changes: null });
      return;
    }
    let branches: BranchInfo | null = null;
    let changes: ChangeInfo[] = [];
    let contexts: Record<string, ContextState> = {};
    let lastRuns: Record<string, number> = {};
    const repo = masterRepo(scan);
    if (isSetUp(scan) && repo !== null) {
      try {
        const master = masterPath(w.folder, repo);
        [branches, changes, contexts, lastRuns] = await Promise.all([
          this.transport.sdlcBranches(master),
          this.listChanges(w.folder, scan),
          this.readContexts(w.folder, scan),
          this.transport.sdlcRunLinks().then((links) => lastRunTimes(links, w.id)),
        ]);
      } catch (e) {
        this.toasts.error(`Could not read the workspace: ${message(e)}`);
      }
    }
    if (seq !== this.loadSeq) return;
    this.scan.set(scan);
    this.branches.set(branches);
    this.changes.set(changes);
    this.contexts.set(contexts);
    this.lastRuns.set(lastRuns);
    this.markHealth(w.id, { missing: false, changes: isSetUp(scan) ? changes.length : null });
  }
}
