import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { StageEvent } from '@bindings/StageEvent';
import type { ContextState } from '@bindings/ContextState';
import type { InstructionsState } from '@bindings/InstructionsState';
import type { Readiness } from '@bindings/Readiness';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { RunSpec } from '@bindings/RunSpec';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { ProgressStore } from '../../core/progress/progress.store';
import { RunStore } from '../../core/run/run.store';
import { ModeStore } from '../../core/mode/mode.store';
import { SdlcRunner, type DiscardChoice, type PickedNaming } from '../../core/sdlc/sdlc-runner';
import { SdlcStagesStore, stageKey, type ChangeRow } from '../../core/sdlc/sdlc-stages.store';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport, type NamingState } from '../../core/transport/kata-transport';
import { defaultWorkType, namingRefusal, orderedWorkTypes, type WorkType } from '../../lib/sdlc-naming';
import { inTauri } from '../../lib/mock';
import { shownChangeList } from '../../lib/doc-notice';
import { fixProgramFailed, hasAiSdlcPlugin, specFor, type StartTrack } from '../../lib/sdlc';
import { DEMO_SETUP_FOLDER, DEMO_START_IDEA, DEMO_START_SYSTEM } from '../../lib/demo';
import {
  folderName,
  isSetUp,
  lastRunTimes,
  masterPath,
  masterRepo,
  productRepos,
  readContextStates,
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

/** One change folder of the current workspace, before any stage is read. */
type NameRow = { system: string; change: string; title: string | null };

/** The home page's progress entry, kept apart from the change page's. */
const PROGRESS_OWNER = 'home';

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
  /** The preview every document run goes through; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);
  private readonly givens = inject(GivenStore);
  private readonly runs = inject(RunStore);
  private readonly runner = inject(SdlcRunner);
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);
  private readonly stages = inject(SdlcStagesStore);
  private readonly progress = inject(ProgressStore);
  private readonly destroyRef = inject(DestroyRef);

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
  /** Every change folder of the workspace, by system, in the order the names read gave. */
  private readonly names = signal<NameRow[]>([]);
  /** The list the page shows: each name with the stage this session has read for it, if any. */
  readonly rows = computed<ChangeRow[]>(() => {
    const id = this.currentId();
    const stored = id === null ? {} : this.stages.rows(id);
    return this.names().map((n) => {
      const row = stored[stageKey(n.system, n.change)];
      return { ...n, info: row?.info ?? null, error: row?.error ?? null, checking: row?.checking ?? false };
    });
  });
  /** The stages read so far. */
  readonly changes = computed(() => this.rows().flatMap((r) => (r.info === null ? [] : [r.info])));
  private readonly passRunning = signal(false);
  /** Whether a stage pass is running: the names are being read or some stage has not arrived yet. */
  readonly reading = this.passRunning.asReadonly();
  /** The reading-stages progress line, or null while nothing should show. */
  readonly readingProgress = this.progress.view(PROGRESS_OWNER);
  readonly contexts = signal<Record<string, ContextState>>({});
  readonly lastRuns = signal<Record<string, number>>({});
  private readonly readiness = signal<Readiness>({ kind: 'missing' });
  /** Above the change list when a plan could not be read; null when every plan was. */
  readonly listNotice = computed(() => {
    const unreadable = this.changes().filter((c) => c.plan_unreadable);
    // A fix's own reason is worded for the fix and shown as it is; only a plan's goes behind "Could not read this document".
    const fixReason = (c: ChangeInfo) =>
      c.stage === 'fix-needs-plugin'
        ? (c.plan_unreadable_reason ?? 'Needs ai-sdlc 0.13.0 or later.')
        : fixProgramFailed(c)
          ? `Kata could not read where ${c.change} stands: ${c.plan_unreadable_reason ?? 'the program gave no message'}`
          : null;
    return shownChangeList(
      this.readiness(),
      unreadable.filter((c) => fixReason(c) === null).map((c) => c.plan_unreadable_reason),
      unreadable.map(fixReason).filter((r): r is string => r !== null),
    );
  });
  /** This machine's workspace instructions against the master's; null when the plugin cannot report it. */
  readonly instructions = signal<InstructionsState | null>(null);
  private readonly catalogRead = signal(false);
  private readonly currentRead = signal(false);
  /** The page can show a state once the catalog and the current workspace's names are in; it never waits for the stages. */
  private readonly loaded = computed(() => this.catalogRead() && this.currentRead());
  private loadSeq = 0;

  readonly masters = computed(() => {
    const m = this.scan()?.master;
    return m?.kind === 'many' ? m.repos : [];
  });
  readonly masterBranch = computed(() => this.branches()?.current ?? null);
  readonly otherBranches = computed(() => (this.branches()?.others ?? []).map((o) => o.change));
  /** The other branches that are pending branches of a change waiting for its name. */
  readonly otherNeedingName = computed(() => (this.branches()?.others ?? []).filter((o) => o.needs_name).map((o) => o.change));
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
  /** Whether the plugin on this machine can triage a change. */
  readonly lightTrack = computed(() => {
    const r = this.readiness();
    return r.kind === 'ready' && r.lightTrack;
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
    this.destroyRef.onDestroy(() => this.stop());
    await this.listen();
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
    const w = this.workspaces().find((x) => x.id === id);
    if (!w) return;
    const next = this.workspaces().map((x) => (x.id === id ? { ...x, last_opened: nowSecs() } : x));
    this.workspaces.set(next);
    this.currentId.set(id);
    this.triageNotice.set(null);
    // The pass for the workspace being left stops at once; the new one reads its names and stages.
    this.cancelPass();
    this.clearDetail();
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
    this.stages.clear(id);
    this.foldersGone.update((l) => l.filter((x) => x !== id));
    this.scanFailed.update((l) => l.filter((x) => x !== id));
    await this.saveList(next);
    if (this.currentId() === id) {
      this.cancelPass();
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
          return plural((await this.readNameRows(dir, found.scan)).length, 'change', 'changes');
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
    const taken = new Set(this.workspaces().map((w) => w.id));
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
    let id = slug;
    for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
    const entry: WorkspaceEntry = { id, name: c.name, folder: c.folder, last_opened: nowSecs() };
    const next = [...this.workspaces(), entry];
    this.workspaces.set(next);
    this.currentId.set(id);
    this.cancelPass();
    this.clearDetail();
    await this.saveList(next);
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

  async newChange(system: string, idea: string, track: StartTrack): Promise<void> {
    const answer = this.naming();
    // A broken setting never falls back to `change/` naming (R3.2), and a setting needs its checked scope.
    if (answer?.kind === 'error' || (answer?.kind === 'setting' && !this.namingReady())) {
      this.toasts.error(this.namingError() ?? 'Pick a work type and a valid scope first.');
      return;
    }
    const picked: PickedNaming | null = answer?.kind === 'setting' ? { workType: this.workType(), scope: this.scope().trim() } : null;
    this.clearNaming();
    this.newChangeOpen.set(false);
    this.triageNotice.set(null);
    const workspace = this.current();
    const scan = this.scan();
    const master = this.masterDir();
    if (!workspace || !scan || !master) return;
    let first: string | null = null;
    try {
      const target = { workspace, master, productRepos: productRepos(scan) };
      const confirm = (spec: RunSpec) => this.confirm(spec);
      const outcome = picked
        ? await this.runner.newChange(target, system, idea, track, confirm, picked)
        : await this.runner.newChange(target, system, idea, track, confirm);
      if (outcome.kind === 'none' && track === 'decide') this.triageNotice.set({ idea: outcome.idea, runId: outcome.runId });
      first = outcome.kind === 'opened' ? outcome.change : null;
    } catch (e) {
      this.toasts.error(`Could not start the change: ${message(e)}`);
    }
    await this.loadCurrent(first);
  }

  openNewChange(): void {
    if (this.refuseWhileLocked()) return;
    this.newChangeIdea.set('');
    this.newChangeTrack.set('decide');
    this.newChangeNote.set(null);
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
      // The branch is the one the list read: a pending branch is not named after its change.
      const branch = this.branches()?.others.find((o) => o.change === change)?.branch ?? `change/${change}`;
      await this.transport.sdlcCheckout(master, branch);
    } catch (e) {
      this.toasts.error(message(e));
      return;
    }
    await this.loadCurrent();
    const found = this.names().find((n) => n.change === change);
    if (!found) {
      this.toasts.error(`Could not find ${change} on that branch.`);
      return;
    }
    await this.openChange(found.system, found.change);
  }

  /** The window regained focus: documents may have changed outside the Workbench, so read the stages again. */
  windowFocused(): void {
    if (!this.canWork() || this.locked()) return;
    this.trigger(null, false);
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
    if (master && repo && !(await this.onBase(master, repo))) return null;
    const built = specFor('setup', null, { folder, system: '', change: null }, await this.currentSettings(), this.catalog() ?? []);
    const spec = await this.confirm(built);
    if (!spec) return null;
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
    this.catalogRead.set(true);
  }

  private readContexts(folder: string, scan: WorkspaceScan): Promise<Record<string, ContextState>> {
    return readContextStates(scan, (master, system, repo) => this.transport.sdlcContextHealth(folder, master, system, repo));
  }

  /** The change folders of every system, from the folders alone: no stage is read and no program is started. */
  private async readNameRows(folder: string, scan: WorkspaceScan): Promise<NameRow[]> {
    const repo = masterRepo(scan);
    if (repo === null) return [];
    const master = masterPath(folder, repo);
    const lists = await Promise.all(
      systemNames(scan).map(async (system) => (await this.transport.sdlcChangeNames(master, system)).map((n) => ({ system, change: n.change, title: n.title }))),
    );
    return lists.flat();
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

  private clearDetail(): void {
    this.scan.set(null);
    this.branches.set(null);
    this.names.set([]);
    this.contexts.set({});
    this.lastRuns.set({});
    this.instructions.set(null);
  }

  /** Read the current workspace from disk. A newer call supersedes an older one still in flight. `first` is the change a run just touched, read before the others. */
  private async loadCurrent(first: string | null = null): Promise<void> {
    const seq = ++this.loadSeq;
    const w = this.current();
    this.scanError.set(null);
    if (!w) {
      this.cancelPass();
      this.clearDetail();
      this.currentRead.set(true);
      return;
    }
    let scan: WorkspaceScan;
    try {
      scan = await this.transport.sdlcScan(w.folder);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.cancelPass();
      this.clearDetail();
      this.scanError.set(message(e));
      this.scanFailed.update((l) => (l.includes(w.id) ? l : [...l, w.id]));
      this.currentRead.set(true);
      return;
    }
    let branches: BranchInfo | null = null;
    let names: NameRow[] = [];
    let lastRuns: Record<string, number> = {};
    const repo = masterRepo(scan);
    let readiness: Readiness = { kind: 'missing' };
    try {
      readiness = await this.transport.sdlcPluginReadiness(w.folder);
    } catch {
      // Nothing decided the plugin is usable, so the notice says to install it.
    }
    let namesRead = false;
    if (isSetUp(scan) && repo !== null) {
      try {
        const master = masterPath(w.folder, repo);
        [branches, names, lastRuns] = await Promise.all([
          this.transport.sdlcBranches(master),
          this.readNameRows(w.folder, scan),
          this.transport.sdlcRunLinks().then((links) => lastRunTimes(links, w.id)),
        ]);
        namesRead = true;
      } catch (e) {
        this.toasts.error(`Could not read the workspace: ${message(e)}`);
      }
    }
    if (seq !== this.loadSeq) return;
    this.scanFailed.update((l) => l.filter((x) => x !== w.id));
    this.scan.set(scan);
    this.branches.set(branches);
    this.names.set(names);
    this.readiness.set(readiness);
    this.lastRuns.set(lastRuns);
    this.currentRead.set(true);
    // The names are on screen: the stages are read behind them, and the slower reads below do not hold them up.
    if (namesRead) this.trigger(first, true);
    let contexts: Record<string, ContextState> = {};
    let instructions: InstructionsState | null = null;
    if (isSetUp(scan) && repo !== null) {
      try {
        contexts = await this.readContexts(w.folder, scan);
      } catch (e) {
        this.toasts.error(`Could not read the workspace: ${message(e)}`);
      }
      if (readiness.kind === 'ready' && readiness.lightTrack) {
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
  }

  // --- the stage pass

  /** Stage events of the pass being read: only that pass's own events count. */
  private livePass: number | null = null;
  /** Events that arrive before the command has handed back the pass id are held here and replayed once it has. */
  private early: StageEvent[] = [];
  private awaitingId = false;
  private passGen = 0;
  private passWorkspace: string | null = null;
  private passSystem = '';
  /** How many changes the systems read before this one hold, so "<read> of <total>" counts across all of them. */
  private passBefore = 0;
  private passDone: (() => void) | null = null;
  private queued: { first: string | null } | null = null;
  private unlisten: (() => void) | null = null;
  private stopped = false;

  private async listen(): Promise<void> {
    if (this.unlisten !== null) return;
    const off = await this.transport.onStageEvent((ev) => this.onStage(ev));
    if (this.stopped) off();
    else this.unlisten = off;
  }

  /** The page is gone: stop listening and stop the pass, so no progress line is left behind. */
  private stop(): void {
    this.stopped = true;
    this.cancelPass();
    this.unlisten?.();
    this.unlisten = null;
  }

  /**
   * Something may have moved the stages. A pass that is not running starts now (names, then stages); one that is
   * running queues exactly one more, which starts as soon as it ends and covers every trigger meanwhile.
   * `namesFresh` is set when the names were read a moment ago and need no second read.
   */
  private trigger(first: string | null, namesFresh = false): void {
    if (this.passRunning()) {
      this.queued = { first: this.queued?.first ?? first };
      return;
    }
    void this.runPass(first, namesFresh);
  }

  private async runPass(first: string | null, namesFresh: boolean): Promise<void> {
    const gen = ++this.passGen;
    const w = this.current();
    const scan = this.scan();
    if (!w || !scan) return;
    this.passWorkspace = w.id;
    this.passRunning.set(true);
    try {
      if (!namesFresh) {
        const names = await this.readNameRows(w.folder, scan);
        if (gen !== this.passGen) return;
        this.names.set(names);
      }
      await this.readStages(gen, w.id, w.folder, scan, first);
    } catch (e) {
      if (gen !== this.passGen) return;
      this.toasts.error(`Could not read the stages: ${message(e)}`);
      this.progress.fail(PROGRESS_OWNER);
    }
    if (gen === this.passGen) this.endPass();
  }

  private async readStages(gen: number, workspaceId: string, folder: string, scan: WorkspaceScan, first: string | null): Promise<void> {
    const repo = masterRepo(scan);
    const total = this.names().length;
    if (repo === null || total === 0) return;
    const master = masterPath(folder, repo);
    this.stages.markChecking(workspaceId);
    this.progress.begin('reading-stages', readLabel(0, total), PROGRESS_OWNER);
    let before = 0;
    for (const system of systemNames(scan)) {
      const inSystem = this.names().filter((n) => n.system === system).length;
      if (inSystem === 0) continue;
      this.passSystem = system;
      this.early = [];
      this.awaitingId = true;
      const ended = new Promise<void>((resolve) => (this.passDone = resolve));
      let id: number;
      try {
        id = await this.transport.sdlcReadStages(master, system, first);
      } finally {
        this.awaitingId = false;
      }
      if (gen !== this.passGen) return;
      this.livePass = id;
      this.passBefore = before;
      const held = this.early;
      this.early = [];
      for (const ev of held) this.applyStage(ev, before, total);
      await ended;
      if (gen !== this.passGen) return;
      before += inSystem;
    }
  }

  private onStage(ev: StageEvent): void {
    if (this.awaitingId) {
      this.early.push(ev);
      return;
    }
    this.applyStage(ev, this.passBefore, this.names().length);
  }

  private applyStage(ev: StageEvent, before: number, total: number): void {
    const workspace = this.passWorkspace;
    if (workspace === null || ev.pass !== this.livePass) return;
    switch (ev.kind) {
      case 'stage':
        this.stages.put(workspace, ev.info);
        break;
      case 'failed':
        this.stages.putError(workspace, this.passSystem, ev.change, ev.error);
        break;
      case 'progress':
        this.progress.update(readLabel(before + ev.read, total), PROGRESS_OWNER);
        break;
      case 'done':
        this.passDone?.();
        break;
    }
  }

  /** The pass is over, whatever the way: nothing is checked any more, the progress line goes, and a queued pass starts. */
  private endPass(): void {
    const workspace = this.passWorkspace;
    this.livePass = null;
    this.passDone = null;
    if (workspace !== null) this.stages.settle(workspace);
    this.progress.end(PROGRESS_OWNER);
    this.passRunning.set(false);
    const next = this.queued;
    this.queued = null;
    if (next !== null) this.trigger(next.first);
  }

  /** Stop the running pass and forget the queued one. The backend drops a superseded pass's events; a late one is ignored here by its id. */
  private cancelPass(): void {
    this.passGen++;
    this.livePass = null;
    this.awaitingId = false;
    this.early = [];
    this.queued = null;
    const wake = this.passDone;
    this.passDone = null;
    wake?.();
    if (!this.passRunning()) return;
    if (this.passWorkspace !== null) this.stages.settle(this.passWorkspace);
    this.progress.end(PROGRESS_OWNER);
    this.passRunning.set(false);
  }
}

const readLabel = (read: number, total: number): string => `${read} of ${total} changes read`;
