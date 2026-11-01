import type { Readiness } from '@bindings/Readiness';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { InstructionsState } from '@bindings/InstructionsState';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ChangeView } from '@bindings/ChangeView';
import type { SystemView } from '@bindings/SystemView';
import type { BranchInfo } from '@bindings/BranchInfo';
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
import type { PublishSummary } from '@bindings/PublishSummary';
import type { RemoteClash } from '@bindings/RemoteClash';
import type { PublishStep } from '@bindings/PublishStep';
import type { PrState } from '@bindings/PrState';
import type { DoneView } from '@bindings/DoneView';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, seedSpec, validateLocal, previewFixture, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunRef } from '@bindings/RunRef';
import { BUILD_REPOS_OF, MOCK_BUILD_CHANGE, MOCK_LAYOUTS, MOCK_MASTER, MOCK_PLUGIN_VERSION, MOCK_SDLC_CATALOG, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, MockBuildHost, mockDefaultPicks, mockReviewView, mockRoundOffer, mockRoundPlan, SdlcMock, TRIAGE_LIGHT, buildRunScript, reviewRunScript, roundRunScript, sdlcSetupScript, sdlcSpecScript, sdlcTriageScript } from '../../lib/sdlc-mock';
import type { ZoomStep } from '../../lib/zoom-keys';
import type { BuildState } from '@bindings/BuildState';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { StartForm } from '@bindings/StartForm';
import type { HistoryEntry } from '@bindings/HistoryEntry';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { CloseOutcome } from '@bindings/CloseOutcome';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { RunForm } from '@bindings/RunForm';
import type { RunningStrip } from '@bindings/RunningStrip';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { BuildPreviewKind } from '@bindings/BuildPreviewKind';
import type { BuildSection } from '@bindings/BuildSection';
import type { ReviewView } from '@bindings/ReviewView';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { DocumentKind } from '../../lib/build-host';
import { KataTransport, NO_BACKEND, type NamingState, type RenameResult } from './kata-transport';

/** How long the first scan of the demo setup folder takes, long enough to see the checking steps. */
const SETUP_SCAN_MS = 1800;

/** How long the scripted agent takes to read a message the operator sent. */
const MESSAGE_READ_MS = 600;

/** The `?demo=` value of the address in a plain browser, or null; this class never runs under Tauri. */
const demoParam = (): string | null => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('demo'));

/** One scripted run in flight: what to play after an answer or a decision, and what finishing it does. */
interface ScriptedRun {
  kind: 'workbench' | 'sdlc-spec' | 'sdlc-setup' | 'sdlc-triage' | 'build';
  mid: ScriptStep[];
  timers: ReturnType<typeof setTimeout>[];
  onDone: (() => void) | null;
  /** The run is paused on an ask or a permission the operator has not settled. */
  awaiting?: boolean;
  /** The run has reached a terminal event or been cancelled. */
  ended?: boolean;
  /** Called once, when the run ends in any way: a build host carries on from it. */
  onEnd?: () => void;
  /** The text of the question the run waits on, for the running changes. */
  question?: string;
  /** The label a scripted triage was answered with. */
  answer?: string;
}

/** Browser stand-in: fixtures plus scripted runs (head, ask, mid, permission,
 *  tail), unblocked by submitAnswer / submitDecision. Several runs play at once,
 *  each tagged with its own id. */
export class MockTransport extends KataTransport {
  /** Every run store listening for events: a build starts several runs, each with its own listener. */
  private readonly listeners = new Set<(runId: string, ev: KataEvent, seq?: number) => void>();
  /** Everything listening for what publishing is doing. */
  private readonly publishListeners = new Set<(step: PublishStep) => void>();
  private readonly runs = new Map<string, ScriptedRun>();
  private nextRun = 0;
  /** `?demo=build-long` (browser only) widens the build demo to three repositories, seventeen tasks, many files and findings, so every area of the build page overflows at 1280 by 800. */
  private readonly sdlc = new SdlcMock(demoParam() === 'build-long', demoParam());
  private setupScanned = false;
  /** The build layout a browser session has saved; a fresh session starts with none. */
  private buildLayout: Record<string, unknown> = {};

  /** Everything each run said, in order, for a session opened late. */
  private readonly histories = new Map<string, HistoryEntry[]>();
  private readonly buildListeners = new Set<(event: BuildEvent) => void>();
  private readonly runningListeners = new Set<(strip: RunningStrip) => void>();
  private readonly closeListeners = new Set<(ask: CloseOutcome) => void>();
  /** The scripted builds: several changes at once, each holding the repositories it works in. */
  private readonly host = new MockBuildHost({
    launch: (change, repo, onEnd, instructions) => this.launchBuildRun(change, repo, onEnd, instructions),
    cancel: (runId) => void this.cancelRun(runId),
    status: (change) => (change.change === MOCK_BUILD_CHANGE ? this.sdlc.buildStatus(change.change) : null),
    announce: (event) => {
      for (const listen of [...this.buildListeners]) listen(event);
      this.announceRunning();
    },
    now: () => Date.now(),
  });

  private emit(runId: string, ev: KataEvent): void {
    const seen = this.histories.get(runId) ?? [];
    this.histories.set(runId, [...seen, { seq: seen.length, event: ev }]);
    for (const listen of [...this.listeners]) listen(runId, ev, seen.length);
    if (ev.type === 'ask.requested' || ev.type === 'ask.answered' || ev.type === 'permission.requested' || ev.type === 'permission.decided') this.announceRunning();
  }

  private finish(run: ScriptedRun): void {
    run.ended = true;
    const onEnd = run.onEnd;
    run.onEnd = undefined;
    onEnd?.();
  }

  private launchBuildRun(change: ChangeRef, repo: string, onEnd: () => void, instructions?: string): string {
    const name = repo === 'review' ? `sdlc-build-${change.change}-review` : `sdlc-build-${repo}`;
    const task = instructions === undefined ? seedSpec().task : `Use the ai-sdlc build skill.\n\nInstructions from the engineer for this run:\n${instructions}`;
    const spec: RunSpec = { ...seedSpec(), name, task, workdir: `${MOCK_WORKSPACE_FOLDER}/${repo}` };
    const id = String(++this.nextRun);
    const { run, head } = this.begin(spec, `build:${change.system}/${change.change}`);
    run.onEnd = onEnd;
    this.runs.set(id, run);
    this.play(id, head);
    return id;
  }

  /** The running changes as the backend would report them, from the scripted builds. */
  private strip(): RunningStrip {
    const entries = this.host.views().map((v): RunningEntry => {
      const asking = v.going.filter((g) => this.runs.get(g.runId)?.awaiting);
      const waiting: RunRef[] = asking.map((g) => ({ run: Number(g.runId), kind: g.repo === 'review' ? 'review' : 'build', repo: g.repo === 'review' ? null : g.repo }));
      const base = { change: v.change, since: v.changedMs, waiting };
      if (asking.length > 0) return { ...base, state: 'needsAnswer', text: this.runs.get(asking[0].runId)?.question ?? 'A question is waiting.', run: Number(asking[0].runId) };
      if (v.going.length > 0) return { ...base, state: 'working', stage: v.going[0].repo === 'review' ? 'review' : 'build', repo: v.going[0].repo === 'review' ? null : v.going[0].repo, run: Number(v.going[0].runId) };
      if (v.reviewWaiting.length > 0) return { ...base, state: 'reviewWaiting', holder: v.reviewWaiting[0].holder };
      if (v.heldStart.length > 0) return { ...base, state: 'held', holder: v.heldStart[0].holder };
      return { ...base, state: 'finished' };
    });
    return { shown: entries.slice(0, 3), all: entries };
  }

  private announceRunning(): void {
    if (this.runningListeners.size === 0) return;
    const strip = this.strip();
    for (const listen of [...this.runningListeners]) listen(strip);
  }

  private play(runId: string, segment: ScriptStep[]): void {
    const run = this.runs.get(runId) ?? this.adopt(runId);
    let acc = 0;
    for (const step of segment) {
      acc += step.delay;
      run.timers.push(setTimeout(() => {
        if (step.ev.type === 'run.completed') run.onDone?.();
        if (step.ev.type === 'ask.requested' || step.ev.type === 'permission.requested') run.awaiting = true;
        const terminal = step.ev.type === 'run.completed' || step.ev.type === 'run.error' || step.ev.type === 'run.cancelled';
        if (step.ev.type === 'ask.requested') run.question = step.ev.questions[0]?.question;
        this.emit(runId, step.ev);
        if (terminal) this.finish(run);
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
      // A round on a repository with nothing left to build: one scripted run per request, so two repositories' agents start together.
      if (tasks.length === 0 && spec.task.includes('Instructions from the engineer')) {
        const round = roundRunScript(repo);
        return { run: make('build', round.mid), head: round.head };
      }
      const script = buildRunScript(repo, tasks, repo === 'customer-portal' && tasks.length > 0 && tasks[0].id === 'T2', repo === 'billing-api' && tasks.length > 0);
      return { run: make('build', script.mid, () => this.sdlc.commitRows(tasks)), head: script.head };
    }
    if (spec.name.endsWith('-triage')) {
      this.sdlc.beginRun();
      const run = make('sdlc-triage', sdlcTriageScript.mid);
      run.onDone = () => { if (run.answer === TRIAGE_LIGHT) this.sdlc.createFix(); };
      return { run, head: sdlcTriageScript.head };
    }
    if (spec.name.startsWith('sdlc-')) {
      const setup = spec.name === 'sdlc-setup';
      this.sdlc.beginRun();
      const script = setup ? sdlcSetupScript : sdlcSpecScript;
      return { run: make(setup ? 'sdlc-setup' : 'sdlc-spec', script.mid, setup ? () => this.sdlc.finishSetup(spec.task.includes('--instructions')) : null), head: script.head };
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
  sdlcReadContext(_master: string, _system: string, repo: string): Promise<string | null> { return Promise.resolve(this.sdlc.readContext(repo)); }
  sdlcInstructions(_folder: string, _masterRepo: string): Promise<InstructionsState> { return Promise.resolve(this.sdlc.instructions()); }
  /** Scripted from the same fixtures the change page reads; the readiness is the one `sdlcPluginReadiness` answers. */
  async sdlcState(folder: string, system: string): Promise<SystemView> {
    return this.sdlc.systemView(system, await this.sdlcPluginReadiness(folder));
  }
  /** Scripted from the same fixtures as `sdlcState`; rejects a change the workspace does not have. */
  async sdlcChangeState(folder: string, _system: string, change: string): Promise<ChangeView> {
    return this.sdlc.changeView(change, await this.sdlcPluginReadiness(folder));
  }
  /** A test or a demo changes what the workspace holds for a change; the next `sdlcChangeState` and `sdlcState` show it. */
  patchChange(change: string, patch: Partial<ChangeInfo>): void { this.sdlc.patch(change, patch); }
  /** Every demo folder is there. */
  sdlcMissingFolders(_folders: string[]): Promise<string[]> { return Promise.resolve([]); }
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
  sdlcStartChange(_master: string): Promise<string> { return Promise.resolve(this.sdlc.startChange()); }
  sdlcFinishChange(_master: string, _pending: string): Promise<FinishOutcome> { return Promise.resolve(this.sdlc.finishChange()); }
  sdlcNaming(_folder: string, _masterRepo: string, _system: string): Promise<NamingState> { return Promise.resolve(this.sdlc.naming()); }
  sdlcCheckScope(_folder: string, scope: string): Promise<string[]> { return Promise.resolve(scope.includes(' ') ? ['a scope cannot contain a space'] : []); }
  sdlcSuggestBranch(_folder: string, _masterRepo: string, _system: string, change: string, workType: string): Promise<string> { return Promise.resolve(this.sdlc.suggestBranch(change, workType)); }
  sdlcConfirmBranch(_folder: string, _masterRepo: string, _system: string, change: string, _pending: string, name: string, _workType: string): Promise<FinishOutcome> { return Promise.resolve(this.sdlc.confirmBranch(change, name)); }
  sdlcRenameBranch(_folder: string, _workspaceId: string, _masterRepo: string, _system: string, change: string, newName: string): Promise<RenameResult> { return Promise.resolve(this.sdlc.renameBranch(change, newName)); }
  sdlcRemoteClashes(touched: PublishRepo[], _masterRepo: string, _system: string, change: string): Promise<RemoteClash[]> { return Promise.resolve(this.sdlc.remoteClashes(touched, change)); }
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
  sdlcBuildHeads(_folder: string, _masterRepo: string, _system: string, repos: string[], _change: string): Promise<Record<string, string>> { return Promise.resolve(this.sdlc.heads(repos)); }
  sdlcPluginReadiness(_workdir: string | null): Promise<Readiness> { return Promise.resolve({ kind: 'ready', plugin: { dir: '~/.claude/plugins/ai-sdlc', version: MOCK_PLUGIN_VERSION, layouts: MOCK_LAYOUTS }, gh: 'present' }); }
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
  sdlcPublish(_folder: string, _workspaceId: string, _masterRepo: string, _system: string, change: string, repos: PublishRepo[]): Promise<PublishSummary> {
    for (const r of repos) {
      for (const step of [{ kind: 'pushing', repo: r.repo }, { kind: 'opening', repo: r.repo }] as PublishStep[]) {
        for (const listen of [...this.publishListeners]) listen(step);
      }
    }
    return Promise.resolve({ results: this.sdlc.publish(repos, change), leftBehind: [] });
  }
  /** `?demo=pr-fail` makes the read fail, so the browser checks can see the "Could not check pull requests" note; `?demo=one-pr` keeps only the
   *  first pull request, so they can see the single inline link. Browser only; this class never runs under Tauri. */
  async sdlcDoneView(folder: string, masterRepo: string, _workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView> {
    const demo = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('demo');
    if (demo === 'pr-fail' && buildFinished) return { done: false, links: [], linksFrom: 'none', offerDeclare: true, prCheckFailed: true };
    const repos = await this.sdlcTouchedRepos(folder, masterRepo, system, change);
    const view = this.sdlc.doneView(repos, change, buildFinished);
    return demo === 'one-pr' ? { ...view, links: view.links.slice(0, 1) } : view;
  }
  sdlcRefreshPrStates(folder: string, masterRepo: string, workspaceId: string, system: string, change: string, buildFinished: boolean): Promise<DoneView> {
    return this.sdlcDoneView(folder, masterRepo, workspaceId, system, change, buildFinished);
  }
  sdlcPullRequests(_masterRepo: string, _system: string, repos: PublishRepo[], change: string): Promise<PrState[]> {
    return Promise.resolve(this.sdlc.pullRequests(repos, change));
  }
  loadBuildLayout(): Promise<unknown> { return Promise.resolve(this.buildLayout); }
  saveBuildLayout(layout: Record<string, unknown>): Promise<void> { this.buildLayout = layout; return Promise.resolve(); }
  openUrl(url: string): Promise<void> { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve(); }
  /** A plain browser has no window to zoom. */
  zoom(_step: ZoomStep): Promise<number> { return Promise.resolve(1); }
  pickDirectory(): Promise<string | null> { return Promise.resolve(null); }
  pickOpenSpec(): Promise<string | null> { return Promise.resolve(null); }
  pickSaveSpec(): Promise<string | null> { return Promise.resolve(null); }

  async onPublishStep(cb: (step: PublishStep) => void): Promise<() => void> {
    this.publishListeners.add(cb);
    return () => { this.publishListeners.delete(cb); };
  }

  async onRunEvent(cb: (runId: string, ev: KataEvent, seq?: number) => void): Promise<() => void> {
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
  async onBuildState(cb: (event: BuildEvent) => void): Promise<() => void> {
    this.buildListeners.add(cb);
    return () => { this.buildListeners.delete(cb); };
  }
  async onRunning(cb: (strip: RunningStrip) => void): Promise<() => void> {
    this.runningListeners.add(cb);
    return () => { this.runningListeners.delete(cb); };
  }
  async onCloseAsked(cb: (ask: CloseOutcome) => void): Promise<() => void> {
    this.closeListeners.add(cb);
    return () => { this.closeListeners.delete(cb); };
  }
  async sdlcRunHistory(runId: string): Promise<HistoryEntry[]> { return [...(this.histories.get(runId) ?? [])]; }
  async sdlcRunChange(change: ChangeRef, kind: DocumentKind, form: RunForm): Promise<string> {
    void kind;
    return this.runSpec({ ...seedSpec(), name: form.name, task: form.task, workdir: change.workspace });
  }
  async sdlcBuildStart(change: ChangeRef, form: StartForm): Promise<StartOutcome> { return this.host.start(change, form); }
  async sdlcBuildContinue(change: ChangeRef, repo: string): Promise<StartOutcome> { return this.host.continueRepo(change, repo); }
  async sdlcBuildState(change: ChangeRef): Promise<BuildState | null> { return this.host.state(change); }
  async sdlcBuildCancel(change: ChangeRef, repo: string | null): Promise<void> { this.host.cancel(change, repo); }
  async sdlcBuildRuns(change: ChangeRef): Promise<BuildRunRef[]> { return this.host.runs(change); }
  /** The run-spec the backend would compose: a triage or a fix run is always auto, a document run follows the form's permission setting, and the limit and the items are the form's. */
  async sdlcPreviewChangeRun(change: ChangeRef, kind: DocumentKind, form: RunForm): Promise<RunSpec> {
    const base = seedSpec();
    const mode = kind === 'fix' || kind === 'triage' ? 'auto' : form.permissionMode;
    return {
      ...base,
      name: form.name,
      task: form.task,
      workdir: change.workspace,
      permissions: { ...base.permissions, mode },
      leash: { ...base.leash, timeout_secs: form.timeoutSecs, max_turns: null, max_budget_usd: null },
      given: { ...(form.given ?? { hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [] }), required_plugins: ['ai-sdlc'], build: false },
    };
  }
  async sdlcPreviewBuild(change: ChangeRef, which: BuildPreviewKind, repo: string | null, form: StartForm): Promise<BuildSection[]> {
    const status = this.sdlc.buildStatus(change.change);
    const planned = status.repos.length > 0 ? status.repos.map((r) => r.repo) : (BUILD_REPOS_OF[change.change] ?? []);
    const section = (title: string, folder: string | null): BuildSection => ({
      title,
      repo: folder,
      spec: { ...seedSpec(), name: `sdlc-build-${folder ?? 'review'}`, workdir: `${MOCK_WORKSPACE_FOLDER}/${folder ?? MOCK_MASTER}`, leash: { ...seedSpec().leash, timeout_secs: form.timeoutSecs, max_turns: null, max_budget_usd: null } },
    });
    const review = section('Review', null);
    switch (which) {
      case 'start':
      case 'continue-all':
        return [...planned.map((r) => section(r, r)), review];
      case 'continue-one':
        return repo === null || repo === 'review' ? [review] : [section(repo, repo)];
      case 'round':
        return (form.rounds ?? []).map((r) => section(r.repo, r.repo));
      case 'manual-review':
        return [review];
    }
  }
  async sdlcReviewView(change: ChangeRef): Promise<ReviewView> {
    return mockReviewView(this.sdlc.reviewRecord(), this.reviewRepos(change));
  }
  async sdlcReviewStart(change: ChangeRef): Promise<StartOutcome> { return this.host.reviewStart(change); }
  async sdlcReviewWaiting(change: ChangeRef): Promise<HeldRepo[]> { return this.host.reviewWaiting(change); }
  /** The repositories a round may go to: the change's own, then the master. */
  private reviewRepos(change: ChangeRef): string[] {
    return [...this.sdlc.buildStatus(change.change).repos.map((r) => r.repo), MOCK_MASTER];
  }
  async sdlcRoundOffer(change: ChangeRef): Promise<[RoundOffer, RoundPicks]> {
    const offer = mockRoundOffer(this.sdlc.reviewRecord(), this.reviewRepos(change));
    return [offer, mockDefaultPicks(offer)];
  }
  async sdlcRoundPlan(change: ChangeRef, picks: RoundPicks): Promise<RoundPlan> {
    return mockRoundPlan(mockRoundOffer(this.sdlc.reviewRecord(), this.reviewRepos(change)), picks);
  }
  async sdlcRoundStart(change: ChangeRef, picks: RoundPicks): Promise<StartOutcome> {
    const plan = await this.sdlcRoundPlan(change, picks);
    if (plan.blocked !== null) return { kind: 'refused', problems: [plan.blocked] };
    return this.host.start(change, { timeoutSecs: 7200, rounds: plan.requests });
  }
  async sdlcRunning(): Promise<RunningStrip> { return this.strip(); }
  async sdlcMarkOpened(change: ChangeRef): Promise<void> { void change; }
  async sdlcCloseAnswer(confirm: boolean): Promise<void> { void confirm; }
  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.timers.forEach(clearTimeout);
    run.timers = [];
    this.finish(run);
    if (run.kind === 'sdlc-spec' || run.kind === 'sdlc-setup' || run.kind === 'sdlc-triage') this.sdlc.cancelRun();
  }
  async submitAnswer(runId: string, id: string, answers: string[][]): Promise<void> {
    this.emit(runId, { type: 'ask.answered', id, answers });
    const run = this.runs.get(runId) ?? this.adopt(runId);
    run.awaiting = false;
    if (run.kind === 'sdlc-triage') {
      run.answer = answers[0]?.[0];
      // Only the light track writes the fix; the other two answers end the run at once.
      this.play(runId, run.answer === TRIAGE_LIGHT ? run.mid : run.mid.slice(-1));
      return;
    }
    this.play(runId, run.mid);
  }
  /** The scripted run answers the way the engine does: refused while it waits on the operator, silent once it has ended, otherwise sent and, a moment later, read. */
  async sendMessage(runId: string, id: string, text: string): Promise<void> {
    const run = this.runs.get(runId) ?? this.adopt(runId);
    if (run.ended) return;
    if (run.awaiting) {
      this.emit(runId, { type: 'message.refused', id, reason: 'waiting-on-operator', text });
      return;
    }
    this.emit(runId, { type: 'message.sent', id, text, sent_at: Date.now() });
    run.timers.push(setTimeout(() => {
      if (!run.ended) this.emit(runId, { type: 'message.read', id, read_at: Date.now() });
    }, MESSAGE_READ_MS));
  }
  async submitDecision(runId: string, id: string, allow: boolean, message: string | null): Promise<void> {
    this.emit(runId, { type: 'permission.decided', id, ...PENDING_PERMISSION, allow, decided_by: 'operator', message: message ?? undefined });
    const run = this.runs.get(runId);
    if (run) run.awaiting = false;
    this.play(runId, run?.kind === 'build' ? run.mid : runScriptTail);
  }
}
