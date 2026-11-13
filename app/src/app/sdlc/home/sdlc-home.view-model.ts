import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { StepEvent } from '@bindings/StepEvent';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { WorkspaceView } from '@bindings/WorkspaceView';
import type { FinishedChange } from '@bindings/FinishedChange';
import type { HomeList } from '@bindings/HomeList';
import type { HomeRow } from '@bindings/HomeRow';
import type { Refresh } from '@bindings/Refresh';
import type { ContextState } from '@bindings/ContextState';
import type { InstructionsState } from '@bindings/InstructionsState';
import type { Readiness } from '@bindings/Readiness';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceChoice } from '@bindings/WorkspaceChoice';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { RunSpec } from '@bindings/RunSpec';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { ProgressStore } from '../../core/progress/progress.store';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice, type PickedNaming } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport, type NamingState } from '../../core/transport/kata-transport';
import { VersionsStore } from '../../core/versions/versions.store';
import { defaultWorkType, namingRefusal, orderedWorkTypes, type WorkType } from '../../lib/sdlc-naming';
import { inTauri } from '../../lib/mock';
import type { ProgressStepId } from '../../lib/progress-steps';
import { isStep, removalStopped, sameStepChange, startStopped, type StepView, type StepWant } from '../../lib/sdlc-steps';
import type { ChangeRef } from '@bindings/ChangeRef';
import { shownChangeList } from '../../lib/doc-notice';
import { hasAiSdlcPlugin, specFor, type StartTrack } from '../../lib/sdlc';
import { DEMO_SETUP_FOLDER, DEMO_START_IDEA, DEMO_START_SYSTEM } from '../../lib/demo';
import {
  folderName,
  isSetUp,
  lastRunTimes,
  masterPath,
  masterRepo,
  readContextStates,
  repoRows,
  systemNames,
  systemOf,
  type WorkspaceCandidate,
} from '../../lib/sdlc-workspace';
import type { ChangeRow } from '../../ui/changes-table';
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

/** The home page's progress entry, kept apart from the change page's. */
const PROGRESS_OWNER = 'home';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
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
  /** The preview every document run goes through; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);
  private readonly progress = inject(ProgressStore);
  private readonly versions = inject(VersionsStore);

  // --- workspaces
  readonly workspaces = signal<WorkspaceEntry[]>([]);
  private readonly currentId = signal<string | null>(null);
  readonly current = computed(() => this.workspaces().find((w) => w.id === this.currentId()) ?? null);
  /** Ids of workspaces whose folder is gone, from one existence check on every folder. */
  private readonly foldersGone = signal<string[]>([]);
  /** Ids of workspaces whose folder could not be scanned. */
  private readonly scanFailed = signal<string[]>([]);
  readonly missing = computed(() => [...new Set([...this.foldersGone(), ...this.scanFailed()])]);

  // --- what the current workspace holds
  private readonly catalog = signal<CatalogEntry[] | null>(null);
  readonly pluginMissing = computed(() => this.catalog() !== null && !hasAiSdlcPlugin(this.catalog() ?? []));
  readonly scan = signal<WorkspaceScan | null>(null);
  readonly scanError = signal<string | null>(null);
  readonly branches = signal<BranchInfo | null>(null);
  /** The backend's answer for every system of the workspace, from one read; null until it is in. */
  private readonly workspace = signal<WorkspaceView | null>(null);
  private readonly views = computed(() => this.workspace()?.systems ?? []);
  /** The reading-changes progress line while the plugin is being asked, or null while nothing should show. */
  readonly readingProgress = this.progress.view(PROGRESS_OWNER);
  /** How many plugin reads are in flight; the line shows from the first start to the last end. */
  private reads = 0;
  /** The backend's last answer to listing the home; null until it is in. */
  private readonly homeList = signal<HomeList | null>(null);
  private readonly listed = computed(() => {
    const l = this.homeList();
    return l?.kind === 'listed' ? l : null;
  });
  /** The last row the backend gave each open change, by name, and whether its read failed. Replaced entry by entry, never emptied by a read. */
  private readonly homeRows = signal<ReadonlyMap<string, { row: HomeRow | null; failed: boolean }>>(new Map());
  /** What the last open read could not read; a failed merge check adds nothing. */
  private readonly openProblems = signal<string[]>([]);
  /** The list the page shows. A listed home shows the shown system's open changes in the workflow's order, each filling in as its row arrives; a legacy home shows every change of every system. */
  readonly rows = computed<ChangeRow[]>(() => {
    const l = this.listed();
    if (l) {
      const known = this.homeRows();
      return l.open.map((o) => {
        const e = known.get(o.change);
        const row = e?.row ?? null;
        return {
          system: l.system ?? '',
          change: o.change,
          title: o.title ?? row?.view.state.title ?? null,
          offer: row?.view.offer ?? null,
          label: row?.reading.label ?? null,
          action: row?.reading.action ?? null,
          failed: e?.failed ?? false,
        };
      });
    }
    return this.views().flatMap((v) =>
      v.changes.map((c) => ({ system: v.system, change: c.state.change, title: c.state.title, offer: c.offer, label: c.offer.label, action: null, failed: false })),
    );
  });
  /** The systems to choose between, when the home lists and there is more than one. */
  readonly systemChoice = computed<string[]>(() => {
    const l = this.listed();
    return l && l.systems.length > 1 ? l.systems : [];
  });
  /** The picker's options, one per system. */
  readonly systemOptions = computed(() => this.systemChoice().map((s) => ({ value: s, label: s })));
  /** The system the home shows, as the backend chose it; null on a legacy list. */
  readonly shownSystem = computed<string | null>(() => this.listed()?.system ?? null);
  /** The finished changes of the shown system, as the backend listed them. */
  readonly finished = computed<FinishedChange[]>(() => this.listed()?.finished ?? []);
  /** How many changes the shown system has finished. */
  readonly finishedCount = computed(() => this.listed()?.finishedCount ?? 0);
  readonly contexts = signal<Record<string, ContextState>>({});
  readonly lastRuns = signal<Record<string, number>>({});
  private readonly readiness = signal<Readiness>({ kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' });
  /** Above the change list when a plan could not be read; null when every plan was. The plugin's own words come from the answer's problems. */
  readonly listNotice = computed(() => {
    const unreadable = this.rows().filter((r) => r.offer?.stage === 'plan-unreadable');
    const problems = [...this.views().flatMap((v) => v.problems), ...this.openProblems()];
    return shownChangeList(
      this.readiness(),
      problems.length > 0 ? problems : unreadable.map(() => null),
    );
  });
  /** Whether a new change may be started across the workspace's systems, as the backend decided; false until the answer is in. */
  readonly canStartChange = computed(() => this.listed()?.canStartChange ?? this.workspace()?.canStartChange ?? false);
  /** Why a new change may not be started, as the backend gave it; null when it may. */
  readonly startChangeReason = computed(() => {
    const l = this.listed();
    return l ? l.startChangeReason : (this.workspace()?.startChangeReason ?? null);
  });
  /** This machine's workspace instructions against the master's; null when the plugin cannot report it. */
  readonly instructions = signal<InstructionsState | null>(null);
  /** Old per-machine checks files the backend says the engineer has not been told about, shown until dismissed. */
  readonly oldChecks = signal<{ system: string; path: string; text: string }[]>([]);
  private readonly catalogRead = signal(false);
  private readonly currentRead = signal(false);
  /** The page can show a state once the catalog and the current workspace's change list are in. */
  private readonly loaded = computed(() => this.catalogRead() && this.currentRead());
  private loadSeq = 0;
  private viewSeq = 0;

  readonly masters = computed(() => {
    const m = this.scan()?.master;
    return m?.kind === 'many' ? m.repos : [];
  });
  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly otherBranches = computed(() => (this.branches()?.others ?? []).map((o) => o.change));
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
  /** Set when a triage ended with no change; null otherwise. */
  readonly triageNotice = signal<{ idea: string; runId: string | null } | null>(null);
  readonly newChangeIdea = signal('');
  readonly newChangeTrack = signal<StartTrack>('decide');
  readonly newChangeNote = signal<string | null>(null);
  /** The system the dialog reopens on after a refused start; null opens on the first. */
  readonly newChangeSystem = signal<string | null>(null);
  /** Why the plugin refused the branch name of the last start; empty when it did not. */
  readonly branchProblems = signal<string[]>([]);
  /** Whether the plugin on this machine can triage a change. */
  readonly lightTrack = computed(() => {
    const r = this.readiness();
    return r.kind === 'ready';
  });
  readonly settingsOpen = signal(false);

  // --- naming at the start of a change
  private readonly naming = signal<NamingState | null>(null);
  /** The naming answer for the system the dialog shows; null while it is being read or the dialog is closed. */
  readonly newChangeNaming = this.naming.asReadonly();
  private readonly namingSystem = signal<string | null>(null);
  /** The route the dialog is on: a described change goes to triage ('decide'), the other starts the full pipeline. */
  private readonly route = signal<StartTrack>('decide');
  private readonly typePicked = signal<WorkType | null>(null);
  /** The types the picker offers, the route's default first; empty without a naming setting. */
  readonly workTypes = computed(() => (this.naming()?.kind === 'setting' ? orderedWorkTypes(this.route()) : []));
  readonly workType = computed(() => {
    const picked = this.typePicked();
    return picked !== null && this.workTypes().includes(picked) ? picked : defaultWorkType(this.route());
  });
  readonly scope = signal('');
  readonly scopeProblems = signal<string[]>([]);
  /** The scope the last finished check was about. */
  private readonly scopeChecked = signal<string | null>(null);
  private scopeCheck = 0;
  private namingRead = 0;
  /** Why the system's setting stops a new change, worded for the dialog; null when it does not. */
  readonly namingError = computed(() => {
    const n = this.naming();
    if (n?.kind !== 'error') return null;
    return namingRefusal(this.namingSystem() ?? 'this system', this.branches()?.default_base ?? null, n.message);
  });
  /** Whether the naming part of the dialog allows Start: the answer is in, and a setting comes with a scope that passed its check. */
  readonly namingReady = computed(() => {
    const n = this.naming();
    if (n === null || n.kind === 'error') return false;
    if (n.kind === 'none') return true;
    const scope = this.scope();
    return scope.trim() !== '' && this.scopeChecked() === scope && this.scopeProblems().length === 0;
  });

  pickSystem(system: string): void {
    void this.readNaming(system);
  }

  pickTrack(track: StartTrack): void {
    this.route.set(track);
    this.typePicked.set(null);
  }

  pickWorkType(type: WorkType): void {
    this.typePicked.set(type);
  }

  setScope(value: string): void {
    this.scope.set(value);
    void this.checkScope(value);
  }

  private async checkScope(value: string): Promise<void> {
    const run = ++this.scopeCheck;
    this.scopeChecked.set(null);
    const folder = this.current()?.folder;
    if (value.trim() === '' || !folder) {
      this.scopeProblems.set([]);
      return;
    }
    let problems: string[];
    try {
      problems = await this.transport.sdlcCheckScope(folder, value);
    } catch (e) {
      problems = [message(e)];
    }
    if (run !== this.scopeCheck) return;
    this.scopeProblems.set(problems);
    this.scopeChecked.set(value);
  }

  /** Reads the naming answer for `system` and, for a setting, offers the system's commit scope (else its name) as the scope. */
  private async readNaming(system: string | null): Promise<void> {
    const read = ++this.namingRead;
    this.naming.set(null);
    this.namingSystem.set(system);
    this.scopeCheck++;
    this.scopeChecked.set(null);
    this.scopeProblems.set([]);
    this.scope.set('');
    const folder = this.current()?.folder;
    const scan = this.scan();
    const repo = scan ? masterRepo(scan) : null;
    if (system === null || !folder || !repo) {
      this.naming.set({ kind: 'none' });
      return;
    }
    let answer: NamingState;
    try {
      answer = await this.transport.sdlcNaming(folder, repo, system);
    } catch (e) {
      answer = { kind: 'error', reason: 'unreadable', message: message(e) };
    }
    if (read !== this.namingRead) return;
    this.naming.set(answer);
    if (answer.kind === 'setting') this.setScope(scan?.marker?.systems[system]?.commitScope || system);
  }

  private clearNaming(): void {
    this.namingRead++;
    this.naming.set(null);
    this.namingSystem.set(null);
  }
  readonly switchPrompt = signal<string | null>(null);
  private switchResolve: ((ok: boolean) => void) | null = null;
  private readonly removeId = signal<string | null>(null);
  readonly removePrompt = computed(() => {
    const w = this.workspaces().find((x) => x.id === this.removeId());
    return w ? `Remove ${w.name} from the list? Nothing on disk is touched.` : null;
  });
  readonly leftovers = this.runner.leftovers;
  /**
   * The session view's Close waits for the after-run work of the run it shows (the solo run that holds the screen, read by its id) and for
   * any leftover decision of a run started here. A change run started here, such as a new change's intent run, is never on show here.
   */
  readonly closeBlocked = computed(
    () => (this.session() !== null && this.runner.settlingRun(this.runs.lastRunId())) || this.runner.leftovers() !== null,
  );

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
  readonly messages = this.runs.messages;
  readonly refusal = this.runs.refusal;
  readonly permissions = this.runs.permissions;
  readonly given = this.runs.given;

  private readonly masterDir = computed(() => {
    const w = this.current();
    const repo = this.scan() ? masterRepo(this.scan()!) : null;
    return w && repo ? masterPath(w.folder, repo) : null;
  });

  /** `demo` is the `?demo=` query value: `sdlc-setup` opens the add-workspace flow on a folder that needs setup, and `start` triages a described change with a scripted run. Browser only. `context` is the `?context=` query value, a repo the context screen handed over to run or refresh its context. */
  async init(demo: string | null = null, context: string | null = null): Promise<void> {
    try {
      await this.modes.load();
    } catch (e) {
      this.toasts.error(`Could not read the settings: ${message(e)}`);
    }
    try {
      const list = await this.transport.sdlcWorkspaces();
      this.workspaces.set(list);
      this.currentId.set(await this.transport.sdlcCurrentWorkspace());
    } catch (e) {
      this.toasts.error(`Could not read the workspace list: ${message(e)}`);
    }
    await Promise.all([this.loadCatalog(), this.loadCurrent(), this.refreshMissing()]);
    // Browser dev/review only: never fires under Tauri.
    if (!inTauri() && demo === 'sdlc-setup') await this.addWorkspace(DEMO_SETUP_FOLDER);
    if (!inTauri() && demo === 'start') await this.newChange(DEMO_START_SYSTEM, DEMO_START_IDEA, 'decide');
    if (context !== null) {
      // Drop the hand-off from the address first, so going back to this screen never starts the run again.
      await this.router.navigate(['/sdlc'], { replaceUrl: true });
      await this.runContext(context);
    }
  }

  // --- workspace list

  async selectWorkspace(id: string): Promise<void> {
    if (!this.workspaces().some((x) => x.id === id)) return;
    const choice = await this.change(() => this.transport.sdlcOpenWorkspace(id));
    if (choice === null) return;
    this.adopt(choice);
    this.triageNotice.set(null);
    this.clearDetail();
    await this.versions.refresh();
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
    const choice = await this.change(() => this.transport.sdlcRemoveWorkspace(id));
    if (choice === null) return;
    const shown = this.currentId();
    this.foldersGone.update((l) => l.filter((x) => x !== id));
    this.scanFailed.update((l) => l.filter((x) => x !== id));
    this.adopt(choice);
    if (choice.current !== shown) {
      await this.versions.refresh();
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
          return plural((await this.readViews(dir, found.scan)).systems.flatMap((v) => v.changes).length, 'change', 'changes');
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
      this.candidate.set({ folder: dir, name, scan, contexts: {} });
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
    if (masterRepo(scan) === null) return;
    this.candidate.set({ folder: dir, name, scan, contexts });
  }

  async confirmAddWorkspace(): Promise<void> {
    const c = this.candidate();
    this.candidate.set(null);
    if (!c || !isSetUp(c.scan)) return;
    const choice = await this.change(() => this.transport.sdlcAddWorkspace(c.name, c.folder));
    if (choice === null) return;
    this.adopt(choice);
    this.clearDetail();
    await this.versions.refresh();
    await Promise.all([this.loadCatalog(), this.loadCurrent(), this.refreshMissing()]);
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

  /** Open the context screen on `repo`. */
  openContext(repo: string): Promise<boolean> {
    const scan = this.scan();
    const system = (scan && systemOf(scan, repo)) ?? this.systems()[0] ?? '';
    return this.router.navigate(['/sdlc', system, 'context', repo]);
  }

  /** Setup is idempotent and supports adding a system, so Add system simply runs it again. */
  async addSystem(): Promise<void> {
    if (this.refuseWhileLocked()) return;
    await this.runOnBase('Running setup', 'Setup', 'setup', { system: '' });
  }

  /** Write or refresh the workspace instructions: one setup task, like any other. */
  async refreshInstructions(): Promise<void> {
    if (this.refuseWhileLocked()) return;
    await this.runOnBase('Refreshing workspace instructions', 'Instructions', 'setup', { system: '', instructions: true });
  }

  async newChange(system: string, idea: string, track: StartTrack, branch?: string): Promise<void> {
    const answer = this.naming();
    // A broken setting never falls back to `change/` naming (R3.2), and a setting needs its checked scope.
    if (answer?.kind === 'error' || (answer?.kind === 'setting' && !this.namingReady())) {
      this.toasts.error(this.namingError() ?? 'Pick a work type and a valid scope first.');
      return;
    }
    const picked: PickedNaming | null = answer?.kind === 'setting' ? { workType: this.workType(), scope: this.scope().trim() } : null;
    this.newChangeOpen.set(false);
    this.triageNotice.set(null);
    this.stepStopped.set(null);
    this.branchProblems.set([]);
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) {
      this.clearNaming();
      return;
    }
    try {
      const target = { workspace, master };
      const confirm = (spec: RunSpec) => this.confirm(spec);
      const more: [PickedNaming?, string?] = branch ? [picked ?? undefined, branch] : picked ? [picked] : [];
      const run = () => this.runner.newChange(target, system, idea, track, confirm, ...more);
      // The start is a step of the change the form names; the triage of the light track makes its change later, in a run.
      const outcome = track === 'full' ? await this.inStep(this.transport.sdlcChangeName(idea).then((change) => ({ workspace: workspace.folder, system, change })), 'starting', 'Stop starting the change', run) : await run();
      if (outcome.kind === 'none' && track === 'decide') this.triageNotice.set({ idea: outcome.idea, runId: outcome.runId });
      if (outcome.kind === 'retry') this.askAgain(system, idea, track, outcome);
      if (outcome.kind === 'startStopped') this.stepStopped.set(startStopped(outcome.answer));
    } catch (e) {
      this.toasts.error(`Could not start the change: ${message(e)}`);
    }
    if (!this.newChangeOpen()) this.clearNaming();
    await this.loadCurrent('action-ended');
  }

  /** The plugin refused the branch name or the scope: the dialog opens again on the same description, with what the engineer picked, and shows the plugin's reasons. */
  private askAgain(system: string, idea: string, track: StartTrack, retry: { ask: 'branch' | 'scope'; problems: string[] }): void {
    this.newChangeIdea.set(idea);
    this.newChangeTrack.set(track);
    this.newChangeSystem.set(system);
    this.newChangeNote.set(null);
    if (retry.ask === 'branch') this.branchProblems.set(retry.problems);
    else this.scopeProblems.set(retry.problems);
    this.newChangeOpen.set(true);
  }

  openNewChange(): void {
    if (this.refuseWhileLocked()) return;
    if (!this.canStartChange()) {
      this.toasts.error(this.startChangeReason() ?? 'A new change cannot be started yet.');
      return;
    }
    this.newChangeIdea.set('');
    this.newChangeTrack.set('decide');
    this.newChangeNote.set(null);
    this.newChangeSystem.set(null);
    this.branchProblems.set([]);
    this.beginNaming();
    this.newChangeOpen.set(true);
  }

  /** Reopen New change on the description the triage could not route, still letting the workflow decide. */
  describeAgain(): void {
    const notice = this.triageNotice();
    if (notice === null || this.refuseWhileLocked()) return;
    this.newChangeIdea.set(notice.idea);
    this.newChangeTrack.set('decide');
    this.newChangeNote.set('The last triage created no change. Change the description and start again.');
    this.newChangeSystem.set(null);
    this.branchProblems.set([]);
    this.beginNaming();
    this.newChangeOpen.set(true);
  }

  /** The triage's record, in the library. */
  async openRun(): Promise<void> {
    const runId = this.triageNotice()?.runId ?? null;
    if (runId === null) return;
    try {
      await this.router.navigate(['/library'], { queryParams: { run: runId } });
    } catch (e) {
      this.toasts.error(`Could not open the run: ${message(e)}`);
    }
  }

  closeNewChange(): void {
    this.branchProblems.set([]);
    this.clearNaming();
    this.newChangeOpen.set(false);
  }

  /** The dialog opens on the first system and on the route it will show: triage when the plugin can, else the full pipeline. */
  private beginNaming(): void {
    this.route.set(this.lightTrack() ? 'decide' : 'full');
    this.typePicked.set(null);
    void this.readNaming(this.systems()[0] ?? null);
  }

  /** Set the team's branch and pull request title patterns for `system`: a setup run with `--naming`, like the other setup runs. */
  async setTeamNaming(system: string): Promise<void> {
    if (this.refuseWhileLocked()) return;
    await this.runOnBase('Setting team naming', 'Naming', 'setup', { system, naming: true });
  }

  async discardLeftovers(choices: DiscardChoice[]): Promise<void> {
    await this.runner.discardAll(choices);
    await this.loadCurrent('action-ended');
  }

  closeLeftovers(): void {
    this.runner.closeLeftovers();
  }

  // --- long steps: the label the backend reports and Stop
  /** How the last stopped start or removal is worded; null while there is none. */
  readonly stepStopped = signal<string | null>(null);

  /** The long step of a change that runs from this page now (a start, a removal); null while none does. */
  readonly step = signal<StepView | null>(null);

  /** The change the running step belongs to; what Stop is asked to stop. */
  private stepRef: ChangeRef | null = null;

  /** Stop the running step. */
  async stopStep(): Promise<void> {
    const ref = this.stepRef;
    if (ref === null) return;
    try {
      await this.transport.stopStep(ref);
    } catch (e) {
      this.toasts.error(`Could not stop the step: ${message(e)}`);
    }
  }

  /**
   * Run a long step of the change `ref` names, showing the label the backend reports for it and Stop while it runs. The backend reports the
   * step as it begins, so the page words nothing itself. `ref` may still be on its way (the name of a change about to start comes from the
   * backend): that report can come first, so the reports are kept and the step is matched once the name is known.
   */
  private async inStep<T>(ref: ChangeRef | Promise<ChangeRef>, want: StepWant, stop: string, call: () => Promise<T>): Promise<T> {
    this.stepRef = null;
    const early: StepEvent[] = [];
    const show = (event: StepEvent): void => {
      if (this.stepRef !== null && sameStepChange(event.change, this.stepRef) && isStep(event.kind, want)) this.step.set({ label: event.progress.label, stop });
    };
    void Promise.resolve(ref).then(
      (named) => {
        this.stepRef = named;
        const heard = early.splice(0);
        const last = heard.filter((e) => sameStepChange(e.change, named) && isStep(e.kind, want)).at(-1);
        if (last !== undefined) show(last);
      },
      () => undefined,
    );
    const unlisten = await this.transport
      .onStep((event) => (this.stepRef === null ? early.push(event) : show(event)))
      .catch(() => (): void => undefined);
    try {
      return await call();
    } finally {
      unlisten();
      this.stepRef = null;
      this.step.set(null);
    }
  }

  // --- removing a merged change's copy

  /** The change the engineer is being asked about, or null. */
  readonly removeAsked = signal<string | null>(null);
  /** Only a row whose action is `remove-copy` is asked about. */
  askRemoveCopy(change: string): void {
    if (this.rows().some((r) => r.change === change && r.action === 'remove-copy')) this.removeAsked.set(change);
  }
  declineRemoveCopy(): void {
    this.removeAsked.set(null);
  }
  /** The engineer confirmed. The change page's removal runs; every outcome is a toast but a stopped one, which is a note, then the home reads again. */
  async confirmRemoveCopy(): Promise<void> {
    const change = this.removeAsked();
    this.removeAsked.set(null);
    this.stepStopped.set(null);
    const workspace = this.current()?.folder;
    const system = this.rows().find((r) => r.change === change)?.system;
    if (change === null || !workspace || !system) return;
    try {
      const ref = { workspace, system, change };
      const out = await this.inStep(ref, 'removingCopy', 'Stop removing the copy', () => this.transport.sdlcRemoveCopy(ref));
      switch (out.outcome) {
        case 'stopped':
          this.stepStopped.set(removalStopped(out.kept));
          break;
        case 'removed':
          this.toasts.info('The copy is removed. The change branch and its commits stay in the master repository.');
          break;
        case 'keep':
          this.toasts.error(`The copy holds uncommitted files, so it is kept: ${out.uncommitted.join(', ')}`);
          break;
        case 'refused':
          this.toasts.error(`The plugin did not remove the copy: ${out.problems.join('; ')}`);
          break;
        case 'couldNotRun':
          this.toasts.error(`The copy was not removed: the plugin could not run: ${out.message}`);
          break;
      }
    } catch (e) {
      this.toasts.error(`The copy was not removed: ${message(e)}`);
    }
    await this.loadCurrent('action-ended');
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
      // The branch is the one the list read: a recorded branch is not named after its change.
      const branch = this.branches()?.others.find((o) => o.change === change)?.branch ?? `change/${change}`;
      await this.transport.sdlcCheckout(master, branch);
    } catch (e) {
      this.toasts.error(message(e));
      return;
    }
    await this.loadCurrent();
    const found = this.rows().find((r) => r.change === change);
    if (!found) {
      this.toasts.error(`Could not find ${change} on that branch.`);
      return;
    }
    await this.openChange(found.system, found.change);
  }

  /** The window regained focus: documents may have changed outside the Workbench, so ask the plugin again. */
  windowFocused(): void {
    if (!this.canWork() || this.locked()) return;
    if (this.listed()) void this.readOpen('focus');
    else void this.shown('reading-stages', 'Reading changes', () => this.refreshLegacy());
  }

  /** On a legacy home the plugin may have been updated while the Workbench was open: ask the list first; a listed answer switches to the listed flow, a legacy one refreshes as before. */
  private async refreshLegacy(): Promise<void> {
    const w = this.current();
    const scan = this.scan();
    if (!w || !scan) return;
    const load = this.loadSeq;
    let list: HomeList;
    try {
      list = await this.transport.sdlcHomeList(w.id, systemNames(scan));
    } catch (e) {
      if (load === this.loadSeq) this.toasts.error(`Could not read the changes: ${message(e)}`);
      return;
    }
    if (load !== this.loadSeq) return;
    if (list.kind === 'listed') {
      this.workspace.set(null);
      this.applyList(list);
      await this.readOpen('open');
      return;
    }
    await this.refreshViews();
  }

  /** The engineer picked a system: the backend remembers it, and the home reads it as on opening. */
  async showSystem(system: string): Promise<void> {
    const w = this.current();
    const scan = this.scan();
    if (!w || !scan) return;
    try {
      const list = await this.shown('listing-changes', 'Listing changes', () => this.transport.sdlcHomePick(w.id, system, systemNames(scan)));
      this.homeRows.set(new Map());
      this.openProblems.set([]);
      this.applyList(list);
    } catch (e) {
      this.toasts.error(`Could not show ${system}: ${message(e)}`);
      return;
    }
    await this.readOpen('open');
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

  say(text: string): void {
    this.lock.say(text);
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

  /** The preview every document run goes through; null when it was cancelled or could not be opened. */
  private async confirm(spec: RunSpec): Promise<RunSpec | null> {
    try {
      return await this.preview.open({ spec: spec, mode: 'sdlc', workdir: spec.workdir, from: { session: this.givens.session(), job: null, build: null } });
    } catch (e) {
      this.toasts.error(`Could not preview the run: ${message(e)}`);
      return null;
    }
  }

  /** Setup and context describe the system, not a change, so their commits belong on the base branch. */
  private async runOnBase(
    title: string,
    label: string,
    kind: 'setup' | 'context',
    ctx: { system: string; repos?: string[]; instructions?: boolean; naming?: boolean },
  ): Promise<void> {
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    if (!(await this.onBase(master, masterRepo(scan) ?? 'the master repo'))) return;
    const built = specFor(kind, null, { folder: workspace.folder, change: null, ...ctx }, await this.currentSettings(), this.catalog() ?? []);
    const spec = await this.confirm(built);
    if (!spec) return;
    await this.runner.run(title, spec, {
      workspaceId: workspace.id,
      target: { kind: 'workspace', master },
      link: null,
      label,
    });
    await this.loadCurrent('action-ended');
  }

  /** Run first-time setup for a folder. Returns the rescanned workspace, or null when it did not end set up. */
  private async runSetup(folder: string, scan: WorkspaceScan): Promise<WorkspaceScan | null> {
    const repo = masterRepo(scan);
    const master = repo ? masterPath(folder, repo) : null;
    if (master && repo && !(await this.onBase(master, repo))) return null;
    const built = specFor('setup', null, { folder, system: '', change: null }, await this.currentSettings(), this.catalog() ?? []);
    const spec = await this.confirm(built);
    if (!spec) return null;
    const out = await this.runner.run('Running setup', spec, {
      workspaceId: folderName(folder),
      target: master === null ? null : { kind: 'workspace', master },
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
   * Offer to leave a change branch before a run that belongs on the base branch, which the backend resolves.
   */
  private async onBase(master: string, repo: string): Promise<boolean> {
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
    const target = info.default_base;
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

  /** Ask the backend to change the saved list; null, with the toast shown, when it could not. */
  private async change(call: () => Promise<WorkspaceChoice>): Promise<WorkspaceChoice | null> {
    try {
      return await call();
    } catch (e) {
      this.toasts.error(`Could not save the workspace list: ${message(e)}`);
      return null;
    }
  }

  /** The list and the current workspace are the backend's answer, taken only once it has saved. */
  private adopt(choice: WorkspaceChoice): void {
    this.workspaces.set(choice.workspaces);
    this.currentId.set(choice.current);
  }

  private async loadCatalog(): Promise<void> {
    try {
      this.catalog.set(await this.transport.catalog(this.current()?.folder ?? null));
    } catch (e) {
      // Unknown is not "missing": do not block the screen on a failed read.
      this.catalog.set(null);
      this.toasts.error(`Could not read the plugin catalog: ${message(e)}`);
    }
    this.catalogRead.set(true);
  }

  private readContexts(folder: string, scan: WorkspaceScan): Promise<Record<string, ContextState>> {
    return readContextStates(scan, (master, system, repo) => this.transport.sdlcContextHealth(folder, master, system, repo));
  }

  /** The backend's answer for every system of the workspace, in one call, none of it started by a change. */
  private readViews(folder: string, scan: WorkspaceScan): Promise<WorkspaceView> {
    return this.transport.sdlcState(folder, systemNames(scan));
  }

  /** Run a plugin read with the progress line shown while it runs. */
  private async shown<T>(step: ProgressStepId, plain: string, read: () => Promise<T>): Promise<T> {
    if (this.reads++ === 0) this.progress.begin(step, plain, PROGRESS_OWNER);
    try {
      return await read();
    } finally {
      if (--this.reads === 0) this.progress.end(PROGRESS_OWNER);
    }
  }

  /** `readViews` with the progress line shown while it runs. */
  private readViewsShown(folder: string, scan: WorkspaceScan): Promise<WorkspaceView> {
    return this.shown('reading-stages', 'Reading changes', () => this.readViews(folder, scan));
  }

  /** The home's list: the light list on opening (or when none is known yet); the whole workspace view when the plugin is too old to list. */
  private async readHome(w: WorkspaceEntry, scan: WorkspaceScan, trigger: Refresh): Promise<{ list: HomeList; views: WorkspaceView | null }> {
    const known = this.homeList();
    const list = trigger === 'open' || known === null ? await this.shown('listing-changes', 'Listing changes', () => this.transport.sdlcHomeList(w.id, systemNames(scan))) : known;
    if (list.kind === 'listed') return { list, views: null };
    return { list, views: await this.readViewsShown(w.folder, scan) };
  }

  /** Take the backend's list as the home's: the rows already read stay for every name still listed. */
  private applyList(list: HomeList): void {
    this.homeList.set(list);
    const names = new Set(list.kind === 'listed' ? list.open.map((o) => o.change) : []);
    this.homeRows.update((m) => new Map([...m].filter(([name]) => names.has(name))));
  }

  /** Replace the rows the backend answered, one by one; every other row stays as it was. */
  private applyRows(rows: HomeRow[]): void {
    this.homeRows.update((m) => {
      const next = new Map(m);
      for (const r of rows) next.set(r.view.state.change, { row: r, failed: false });
      return next;
    });
  }

  /** Read the shown system's open changes alone and fill the rows in place; follow a relist and the merge check the answer asks for. A newer read supersedes this one. */
  private async readOpen(trigger: Refresh): Promise<void> {
    const seq = ++this.viewSeq;
    const w = this.current();
    const scan = this.scan();
    const l = this.listed();
    if (!w || !scan || !l || l.system === null) return;
    const system = l.system;
    try {
      const answer = await this.shown('reading-open-stages', 'Reading changes', () =>
        this.transport.sdlcHomeOpen(w.folder, system, l.open.map((o) => o.change), trigger),
      );
      if (seq !== this.viewSeq) return;
      this.applyRows(answer.rows);
      this.openProblems.set(answer.problems);
      if (answer.relist) {
        const list = await this.shown('listing-changes', 'Listing changes', () => this.transport.sdlcHomeList(w.id, systemNames(scan)));
        if (seq !== this.viewSeq) return;
        this.applyList(list);
      }
      if (answer.check.length > 0) {
        const checked = await this.shown('reading-open-stages', 'Reading changes', () =>
          this.transport.sdlcHomePullRequests(w.folder, this.listed()?.system ?? system, answer.check),
        );
        if (seq !== this.viewSeq) return;
        // A merge check that could not be answered shows nothing: its problems are not put up, and the row keeps its last reading.
        this.applyRows(checked.rows);
      }
    } catch (e) {
      if (seq !== this.viewSeq) return;
      this.homeRows.update((m) => {
        const next = new Map(m);
        for (const o of this.listed()?.open ?? []) {
          if (!next.get(o.change)?.row) next.set(o.change, { row: null, failed: true });
        }
        return next;
      });
      this.toasts.error(`Could not read the changes: ${message(e)}`);
    }
  }

  /** Read the change list again for the current workspace. A newer read, or a reload of the workspace, supersedes it. */
  private async refreshViews(): Promise<void> {
    const seq = ++this.viewSeq;
    const w = this.current();
    const scan = this.scan();
    if (!w || !scan) return;
    try {
      const views = await this.readViewsShown(w.folder, scan);
      if (seq === this.viewSeq) this.workspace.set(views);
    } catch (e) {
      if (seq === this.viewSeq) this.toasts.error(`Could not read the changes: ${message(e)}`);
    }
  }

  /** Which workspace folders no longer exist, for every workspace in the list: an existence check, nothing is scanned. */
  private async refreshMissing(): Promise<void> {
    const list = this.workspaces();
    if (list.length === 0) {
      this.foldersGone.set([]);
      return;
    }
    try {
      const gone = new Set(await this.transport.sdlcMissingFolders(list.map((w) => w.folder)));
      this.foldersGone.set(list.filter((w) => gone.has(w.folder)).map((w) => w.id));
    } catch {
      // Unknown is not "missing": the switcher simply shows no flag.
    }
  }

  /** The notice was read: drop it. The backend recorded it as told when it was first shown, so it does not come back. */
  dismissOldChecks(system: string): void {
    this.oldChecks.update((l) => l.filter((n) => n.system !== system));
  }

  /** Ask the backend, in one call, which systems have an old checks file the engineer has not been told about, and say so once. */
  private async readOldChecks(folder: string, systems: string[]): Promise<void> {
    try {
      const found = await this.transport.sdlcOldChecks(folder, systems);
      if (found.length === 0) return;
      // Shown from here on, so it is recorded as told now: closing the app without a click does not bring it back.
      await this.transport.sdlcOldChecksSeen(found.map((n) => n.system));
      this.oldChecks.update((l) => [...l, ...found.filter((n) => !l.some((o) => o.system === n.system))]);
    } catch (e) {
      this.toasts.error(`Could not check for old checks: ${message(e)}`);
    }
  }

  private clearDetail(): void {
    this.scan.set(null);
    this.branches.set(null);
    this.workspace.set(null);
    this.homeList.set(null);
    this.homeRows.set(new Map());
    this.openProblems.set([]);
    this.contexts.set({});
    this.lastRuns.set({});
    this.instructions.set(null);
  }

  /** Read the current workspace from disk. A newer call supersedes an older one still in flight. */
  private async loadCurrent(trigger: Refresh = 'open'): Promise<void> {
    const seq = ++this.loadSeq;
    ++this.viewSeq;
    const w = this.current();
    this.scanError.set(null);
    if (!w) {
      this.clearDetail();
      this.currentRead.set(true);
      return;
    }
    let scan: WorkspaceScan;
    try {
      scan = await this.transport.sdlcScan(w.folder);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.clearDetail();
      this.scanError.set(message(e));
      this.scanFailed.update((l) => (l.includes(w.id) ? l : [...l, w.id]));
      this.currentRead.set(true);
      return;
    }
    let branches: BranchInfo | null = null;
    let views: WorkspaceView | null = null;
    let list: HomeList | null = null;
    let lastRuns: Record<string, number> = {};
    let readFailed = false;
    const repo = masterRepo(scan);
    let readiness: Readiness = { kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' };
    try {
      readiness = await this.transport.sdlcPluginReadiness(w.folder);
    } catch {
      // Nothing decided the plugin is usable, so the notice says to install it.
    }
    if (isSetUp(scan) && repo !== null) {
      try {
        const master = masterPath(w.folder, repo);
        let home: { list: HomeList; views: WorkspaceView | null };
        [branches, home, lastRuns] = await Promise.all([
          this.transport.sdlcBranches(master),
          this.readHome(w, scan, trigger),
          this.transport.sdlcRunLinks().then((links) => lastRunTimes(links, w.id)),
        ]);
        ({ list, views } = home);
      } catch (e) {
        readFailed = true;
        this.toasts.error(`Could not read the workspace: ${message(e)}`);
      }
    }
    if (seq !== this.loadSeq) return;
    this.scanFailed.update((l) => l.filter((x) => x !== w.id));
    this.scan.set(scan);
    this.branches.set(branches);
    this.workspace.set(views);
    if (list) this.applyList(list);
    else if (!(readFailed && trigger !== 'open')) this.homeList.set(null);
    // A refresh of the workspace on screen that failed keeps the list it knew, so the rows stay; opening a workspace starts from none.
    this.readiness.set(readiness);
    this.lastRuns.set(lastRuns);
    this.currentRead.set(true);
    // The names are on screen; the open stages fill in alongside the slower reads below.
    const opened = this.listed() ? this.readOpen(trigger) : Promise.resolve();
    // The change list is on screen with its labels; the slower reads below do not hold it up.
    let contexts: Record<string, ContextState> = {};
    let instructions: InstructionsState | null = null;
    if (isSetUp(scan) && repo !== null) {
      try {
        contexts = await this.readContexts(w.folder, scan);
      } catch (e) {
        this.toasts.error(`Could not read the workspace: ${message(e)}`);
      }
      if (readiness.kind === 'ready') {
        try {
          instructions = await this.transport.sdlcInstructions(w.folder, repo);
        } catch (e) {
          this.toasts.error(`Could not read the workspace instructions: ${message(e)}`);
        }
      }
    }
    if (seq !== this.loadSeq) return;
    this.contexts.set(contexts);
    this.instructions.set(instructions);
    await opened;
    if (isSetUp(scan)) await this.readOldChecks(w.folder, systemNames(scan));
  }
}
