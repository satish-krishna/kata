import type { Readiness } from '@bindings/Readiness';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildAction } from '@bindings/BuildAction';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { TaskLink } from '@bindings/TaskLink';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ReadResult } from '@bindings/ReadResult';
import type { ReadError } from '../../lib/doc-notice';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { UnsavedRows } from '@bindings/UnsavedRows';
import type { Participant } from '@bindings/Participant';
import type { PrepareOutcome } from '@bindings/PrepareOutcome';
import type { BuildStart } from '@bindings/BuildStart';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { Part } from '@bindings/Part';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { Offender } from '@bindings/Offender';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { PrResult } from '@bindings/PrResult';
import type { PrState } from '@bindings/PrState';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, validateLocal, previewFixture, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import { MOCK_LAYOUTS, MOCK_PLUGIN_VERSION, MOCK_SDLC_CATALOG, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, SdlcMock, buildRunScript, reviewRunScript, sdlcSetupScript, sdlcSpecScript } from '../../lib/sdlc-mock';
import type { ZoomStep } from '../../lib/zoom-keys';
import { KataTransport, NO_BACKEND } from './kata-transport';

/** How long the first scan of the demo setup folder takes, long enough to see the checking steps. */
const SETUP_SCAN_MS = 1800;

/** One scripted run in flight: what to play after an answer or a decision, and what finishing it does. */
interface ScriptedRun {
  kind: 'workbench' | 'sdlc-spec' | 'sdlc-setup' | 'build';
  mid: ScriptStep[];
  timers: ReturnType<typeof setTimeout>[];
  onDone: (() => void) | null;
}

/** Browser stand-in: fixtures plus scripted runs (head, ask, mid, permission,
 *  tail), unblocked by submitAnswer / submitDecision. Several runs play at once,
 *  each tagged with its own id. */
export class MockTransport extends KataTransport {
  /** Every run store listening for events: a build starts several runs, each with its own listener. */
  private readonly listeners = new Set<(runId: string, ev: KataEvent) => void>();
  private readonly runs = new Map<string, ScriptedRun>();
  private nextRun = 0;
  private readonly sdlc = new SdlcMock();
  private setupScanned = false;

  private emit(runId: string, ev: KataEvent): void {
    for (const listen of [...this.listeners]) listen(runId, ev);
  }

  private play(runId: string, segment: ScriptStep[]): void {
    const run = this.runs.get(runId) ?? this.adopt(runId);
    let acc = 0;
    for (const step of segment) {
      acc += step.delay;
      run.timers.push(setTimeout(() => {
        if (step.ev.type === 'run.completed') run.onDone?.();
        this.emit(runId, step.ev);
      }, acc));
    }
  }

  /** A run id nobody started here (a test driving an answer cold) plays the Workbench script. */
  private adopt(runId: string): ScriptedRun {
    const run: ScriptedRun = { kind: 'workbench', mid: runScriptMid, timers: [], onDone: null };
    this.runs.set(runId, run);
    return run;
  }

  /** Pick the script for a run by its spec: a build run by its group, an AI-SDLC run by its name, anything else is the Workbench demo. */
  private begin(spec: RunSpec, group: string | undefined): { run: ScriptedRun; head: ScriptStep[] } {
    const make = (kind: ScriptedRun['kind'], mid: ScriptStep[], onDone: (() => void) | null = null): ScriptedRun => ({ kind, mid, timers: [], onDone });
    if (group?.startsWith('build:') || spec.name.startsWith('sdlc-build')) {
      if (spec.name.includes('review')) {
        return { run: make('build', reviewRunScript.mid, () => this.sdlc.recordReview()), head: reviewRunScript.head };
      }
      const repo = spec.workdir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      const tasks = this.sdlc.readyTasks(repo);
      const script = buildRunScript(repo, tasks, repo === 'customer-portal' && tasks.length > 0 && tasks[0].id === 'T2');
      return { run: make('build', script.mid, () => this.sdlc.commitRows(tasks)), head: script.head };
    }
    if (spec.name.startsWith('sdlc-')) {
      const setup = spec.name === 'sdlc-setup';
      this.sdlc.beginRun();
      const script = setup ? sdlcSetupScript : sdlcSpecScript;
      return { run: make(setup ? 'sdlc-setup' : 'sdlc-spec', script.mid, setup ? () => this.sdlc.finishSetup() : null), head: script.head };
    }
    return { run: make('workbench', runScriptMid), head: runScriptHead };
  }

  catalog(workdir: string | null): Promise<CatalogEntry[]> {
    return Promise.resolve(workdir === MOCK_WORKSPACE_FOLDER ? [...seedCatalog, ...MOCK_SDLC_CATALOG] : seedCatalog);
  }
  listRuns(): Promise<RunRecord[]> { return Promise.resolve(history); }
  loadRun(id: string): Promise<RunDetail> {
    const detail = runDetailFixture(id);
    // The scripted review run: its transcript closes with the findings the build view reads.
    if (id.includes('-review-')) return Promise.resolve({ record: { ...detail.record, id }, events: reviewRunScript.head.map((step) => step.ev) });
    return Promise.resolve(detail);
  }
  loadSpec(_path: string): Promise<RunSpec> { return Promise.reject(new Error(NO_BACKEND)); }
  saveSpec(_path: string, _spec: RunSpec): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  validateSpec(spec: RunSpec): Promise<string[]> { return Promise.resolve(validateLocal(spec)); }
  previewRun(spec: RunSpec): Promise<Resolved> { return Promise.resolve(previewFixture(spec)); }
  listKatas(): Promise<KataListing> { return Promise.resolve({ katas: katasFixture, failures: [] }); }
  loadKata(name: string): Promise<RunSpec> { return Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]); }
  saveKata(_spec: RunSpec): Promise<void> { return Promise.resolve(); }
  listPresets(): Promise<Preset[]> { return Promise.resolve(presetsFixture); }
  savePreset(_name: string, _body: string): Promise<void> { return Promise.resolve(); }
  exportBundle(_spec: RunSpec, _out: string): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  sdlcSettings(): Promise<Settings> { return Promise.resolve(this.sdlc.getSettings()); }
  sdlcSaveSettings(settings: Settings): Promise<void> { this.sdlc.saveSettings(settings); return Promise.resolve(); }
  sdlcWorkspaces(): Promise<WorkspaceEntry[]> { return Promise.resolve(this.sdlc.getWorkspaces()); }
  sdlcSaveWorkspaces(workspaces: WorkspaceEntry[]): Promise<void> { this.sdlc.saveWorkspaces(workspaces); return Promise.resolve(); }
  sdlcScan(folder: string): Promise<WorkspaceScan> {
    // The first scan of the demo folder that needs setup is slow, so the "Checking workspace" steps are visible.
    if (folder === MOCK_SETUP_FOLDER && !this.setupScanned) {
      this.setupScanned = true;
      return new Promise((ok) => setTimeout(() => ok(this.sdlc.scan(folder)), SETUP_SCAN_MS));
    }
    return Promise.resolve(this.sdlc.scan(folder));
  }
  sdlcContextHealth(_folder: string, _master: string, _system: string, repo: string): Promise<ContextState> { return Promise.resolve(this.sdlc.contextHealth(repo)); }
  sdlcChanges(_master: string, _system: string): Promise<ChangeInfo[]> { return Promise.resolve(this.sdlc.listChanges()); }
  sdlcBranches(_master: string): Promise<BranchInfo> { return Promise.resolve(this.sdlc.branches()); }
  sdlcReadDoc(_master: string, _system: string, change: string, doc: string): Promise<string | null> {
    try {
      return Promise.resolve(this.sdlc.readDoc(change, doc));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  sdlcSnapshot(_master: string): Promise<Snapshot> { return Promise.resolve(this.sdlc.snapshot()); }
  sdlcLeftovers(_master: string, _before: Snapshot, _productRepos: string[], _build?: BuildScope): Promise<Leftovers> { return Promise.resolve(this.sdlc.leftovers()); }
  sdlcDiscard(_master: string, _before: Snapshot, paths: string[], _build?: BuildScope): Promise<void> { this.sdlc.discard(paths); return Promise.resolve(); }
  sdlcStartChange(_master: string, _base: string): Promise<string> { return Promise.resolve(this.sdlc.startChange()); }
  sdlcFinishChange(_master: string, _pending: string, base: string): Promise<FinishOutcome> { return Promise.resolve(this.sdlc.finishChange(base)); }
  sdlcCheckout(_master: string, branch: string): Promise<void> { this.sdlc.checkout(branch); return Promise.resolve(); }
  sdlcDecide(_master: string, _system: string, change: string, decision: Decision, _confirmed: boolean): Promise<DecideOutcome> { return Promise.resolve(this.sdlc.decide(change, decision)); }
  sdlcRunLinks(): Promise<RunLink[]> { return Promise.resolve(this.sdlc.runLinks()); }
  sdlcLinkRun(link: RunLink): Promise<void> { this.sdlc.linkRun(link); return Promise.resolve(); }
  sdlcTaskLinks(): Promise<TaskLink[]> { return Promise.resolve(this.sdlc.taskLinks()); }
  sdlcLinkTasks(links: TaskLink[]): Promise<void> { this.sdlc.linkTasks(links); return Promise.resolve(); }
  /** The scripted run has no process to wait for. */
  sdlcWaitRunExit(_runId: string, _timeoutMs: number): Promise<boolean> { return Promise.resolve(true); }
  sdlcBuildStatus(_master: string, _system: string, change: string): Promise<BuildStatus> { return Promise.resolve(this.sdlc.buildStatus(change)); }
  sdlcReadParsed(_master: string, _system: string, change: string, doc: string): Promise<ReadResult | ReadError | null> { return Promise.resolve(this.sdlc.readParsed(change, doc)); }
  sdlcReviewRecord(_master: string, _system: string, _change: string): Promise<ReviewRecord | null> { return Promise.resolve(this.sdlc.reviewRecord()); }
  sdlcReviewVerify(_master: string, _system: string, _change: string, _since: string, _before: Snapshot['dirty']): Promise<string[]> { return Promise.resolve([]); }
  sdlcUnsavedRows(_master: string, _system: string, _change: string): Promise<UnsavedRows[]> { return Promise.resolve([]); }
  sdlcBuildParticipants(folder: string, _masterRepo: string, _system: string, _change: string, _pending?: string | null): Promise<Participant[]> { return Promise.resolve(this.sdlc.participants(folder)); }
  sdlcBuildPrepare(folder: string, _masterRepo: string, _system: string, change: string, _continueWithLeftovers: boolean, _pending: string | null, _action: BuildAction): Promise<PrepareOutcome> {
    return Promise.resolve({ kind: 'ready', start: this.sdlc.prepare(folder, change) });
  }
  sdlcBuildSettle(_start: BuildStart): Promise<string[]> { return Promise.resolve([]); }
  sdlcBuildHeads(_folder: string, repos: string[], _change: string): Promise<Record<string, string>> { return Promise.resolve(this.sdlc.heads(repos)); }
  sdlcPluginReadiness(_workdir: string | null): Promise<Readiness> { return Promise.resolve({ kind: 'ready', dir: '~/.claude/plugins/ai-sdlc', version: MOCK_PLUGIN_VERSION, layouts: MOCK_LAYOUTS }); }
  sdlcChangeRepos(folder: string, _masterRepo: string, _system: string, change: string): Promise<ChangeRepo[]> { return Promise.resolve(this.sdlc.changeRepos(folder, change)); }
  sdlcMissingChangeBranches(_folder: string, _masterRepo: string, _system: string, _change: string): Promise<string[]> { return Promise.resolve([]); }
  sdlcDiffFiles(_repoPath: string, part: Part): Promise<DiffListing> { return Promise.resolve(this.sdlc.diffFiles(part)); }
  sdlcCommitFiles(repoPath: string): Promise<CommitFiles[]> { return Promise.resolve(this.sdlc.commitFiles(repoPath)); }
  sdlcDiffPair(_repoPath: string, _part: Part, path: string): Promise<FilePair> { return Promise.resolve(this.sdlc.diffPair(path)); }
  sdlcDiffBase(_repoPath: string): Promise<BaseInfo> { return Promise.resolve(this.sdlc.diffBase()); }
  sdlcTouchedRepos(folder: string, _masterRepo: string, _system: string, _change: string): Promise<PublishRepo[]> { return Promise.resolve(this.sdlc.touchedRepos(folder)); }
  sdlcCommitOffenders(_folder: string, _masterRepo: string, _system: string, _change: string): Promise<Offender[]> { return Promise.resolve([]); }
  sdlcChecksDir(): Promise<string> { return Promise.resolve(this.sdlc.checksPlan().path.replace(/\/[^/]*$/, '')); }
  sdlcChecksLoad(_folder: string, _masterRepo: string, _system: string): Promise<ChecksPlan> { return Promise.resolve(this.sdlc.checksPlan()); }
  sdlcRunChecks(_folder: string, _masterRepo: string, _system: string, repo: PublishRepo): Promise<RepoChecks> { return Promise.resolve(this.sdlc.runChecks(repo.repo)); }
  sdlcGhSignedIn(_repos: PublishRepo[]): Promise<string> { return Promise.resolve('demo-user'); }
  sdlcGhOrigins(_repos: PublishRepo[]): Promise<void> { return Promise.resolve(); }
  sdlcPublish(_folder: string, _masterRepo: string, _system: string, _change: string, repos: PublishRepo[]): Promise<PrResult[]> { return Promise.resolve(this.sdlc.publish(repos)); }
  /** `?demo=pr-fail` makes the read fail, so the browser checks can see the "Could not check pull requests" note; `?demo=one-pr` keeps only the
   *  first pull request, so they can see the single inline link. Browser only; this class never runs under Tauri. */
  sdlcPullRequests(repos: PublishRepo[], change: string): Promise<PrState[]> {
    const demo = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('demo');
    if (demo === 'pr-fail') return Promise.reject(new Error('gh is not signed in'));
    const prs = this.sdlc.pullRequests(repos, change);
    return Promise.resolve(demo === 'one-pr' ? prs.slice(0, 1) : prs);
  }
  loadBuildLayout(): Promise<unknown> { throw new Error('not implemented'); }
  saveBuildLayout(_layout: Record<string, unknown>): Promise<void> { throw new Error('not implemented'); }
  /** A plain browser has no window to zoom. */
  zoom(_step: ZoomStep): Promise<number> { return Promise.resolve(1); }
  pickDirectory(): Promise<string | null> { return Promise.resolve(null); }
  pickOpenSpec(): Promise<string | null> { return Promise.resolve(null); }
  pickSaveSpec(): Promise<string | null> { return Promise.resolve(null); }

  async onRunEvent(cb: (runId: string, ev: KataEvent) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  async runSpec(spec: RunSpec, group?: string): Promise<string> {
    const id = String(++this.nextRun);
    const { run, head } = this.begin(spec, group);
    this.runs.set(id, run);
    this.play(id, head);
    return id;
  }
  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.timers.forEach(clearTimeout);
    run.timers = [];
    if (run.kind === 'sdlc-spec' || run.kind === 'sdlc-setup') this.sdlc.cancelRun();
  }
  async submitAnswer(runId: string, id: string, answers: string[][]): Promise<void> {
    this.emit(runId, { type: 'ask.answered', id, answers });
    this.play(runId, (this.runs.get(runId) ?? this.adopt(runId)).mid);
  }
  async submitDecision(runId: string, id: string, allow: boolean, message: string | null): Promise<void> {
    this.emit(runId, { type: 'permission.decided', id, ...PENDING_PERMISSION, allow, decided_by: 'operator', message: message ?? undefined });
    this.play(runId, runScriptTail);
  }
}
