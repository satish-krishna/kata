import type { RepoBoard } from '@bindings/RepoBoard';
import type { ReviewStanding } from '@bindings/ReviewStanding';
import type { Stop } from '@bindings/Stop';
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
import type { ChangeInfo } from '../../lib/sdlc-mock-types';
import type { ChangeView } from '@bindings/ChangeView';
import type { WorkspaceView } from '@bindings/WorkspaceView';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { BuildScope } from '@bindings/BuildScope';
import type { Snapshot } from '@bindings/Snapshot';
import type { SnapshotTarget } from '@bindings/SnapshotTarget';
import type { DocumentRead } from '@bindings/DocumentRead';
import type { OpenedChange } from '@bindings/OpenedChange';
import type { OpenNotice } from '@bindings/OpenNotice';
import type { ParsedRead } from '@bindings/ParsedRead';
import type { Leftovers } from '@bindings/Leftovers';
import type { ChangeStart } from '@bindings/ChangeStart';
import type { AcceptOutcome } from '@bindings/AcceptOutcome';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RejectOutcome } from '@bindings/RejectOutcome';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { TaskLink } from '@bindings/TaskLink';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { Part } from '@bindings/Part';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { OldChecksNotice } from '@bindings/OldChecksNotice';
import type { RenameOutcome } from '@bindings/RenameOutcome';
import type { DeclareView } from '@bindings/DeclareView';
import type { DoneStep } from '@bindings/DoneStep';
import type { PullRequestsView } from '@bindings/PullRequestsView';
import type { Resolved } from '@bindings/Resolved';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, seedSpec, validateLocal, previewFixture, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, mockVersions, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import type { OpenRun } from '@bindings/OpenRun';
import type { Opens } from '@bindings/Opens';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunRef } from '@bindings/RunRef';
import { BUILD_REPOS_OF, MOCK_BUILD_CHANGE, MOCK_LAYOUTS, MOCK_MASTER, MOCK_PLUGIN_VERSION, MOCK_SDLC_CATALOG, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, MockBuildHost, mockBoard, mockChangeKey, mockDefaultPicks, mockStanding, mockReviewView, mockRoundOffer, mockRoundPlan, SdlcMock, TRIAGE_LIGHT, buildRunScript, reviewRunScript, roundRunScript, sdlcSetupScript, sdlcSpecScript, sdlcTriageScript } from '../../lib/sdlc-mock';
import type { ZoomStep } from '../../lib/zoom-keys';
import type { BuildState } from '@bindings/BuildState';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { StartForm } from '@bindings/StartForm';
import type { HistoryEntry } from '@bindings/HistoryEntry';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { CloseOutcome } from '@bindings/CloseOutcome';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { RunForm } from '@bindings/RunForm';
import type { Versions } from '@bindings/Versions';
import type { RunningStrip } from '@bindings/RunningStrip';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { BuildPreviewKind } from '@bindings/BuildPreviewKind';
import type { BuildSection } from '@bindings/BuildSection';
import type { ReviewView } from '@bindings/ReviewView';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { DocumentKind } from '../../lib/build-host';
import { KataTransport, NO_BACKEND, type NamingState, type ReviewStandingInput } from './kata-transport';

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

/** The answer of a read, or its rejection, as a promise. A module function, so it is not a member of the transport. */
function settled<T>(read: () => T): Promise<T> {
  try {
    return Promise.resolve(read());
  } catch (e) {
    return Promise.reject(e);
  }
}

/** Browser stand-in: fixtures plus scripted runs (head, ask, mid, permission,
 *  tail), unblocked by submitAnswer / submitDecision. Several runs play at once,
 *  each tagged with its own id. */
export class MockTransport extends KataTransport {
  /** Every run store listening for events: a build starts several runs, each with its own listener. */
  private readonly listeners = new Set<(runId: string, ev: KataEvent, seq?: number) => void>();
  /** Everything listening for what publishing is doing. */
  private readonly doneListeners = new Set<(step: DoneStep) => void>();
  private readonly runs = new Map<string, ScriptedRun>();
  /** The change of each document run started through `sdlcRunChange`, by run id; a run that has ended no longer holds the checkout. */
  private readonly changeRunsLive = new Map<string, string>();
  /** The change each scripted run started through the plugin, by `<system>/<transcript>`, from its `change start` answer. */
  private readonly triageStarted = new Map<string, string>();
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
    if (ev.type === 'tool.result' && ev.output) this.noteStarted(runId, ev.output);
    if (ev.type === 'ask.requested' || ev.type === 'ask.answered' || ev.type === 'permission.requested' || ev.type === 'permission.decided') this.announceRunning();
  }

  /** A run's tool printed the plugin's `change start` answer: remember the change it started under the run's transcript, as the backend reads it from the run's record. */
  private noteStarted(runId: string, output: string): void {
    let answer: { event?: string; system?: string; change?: string; outcome?: string } | null;
    try {
      answer = JSON.parse(output) as typeof answer;
    } catch {
      return;
    }
    if (typeof answer !== 'object' || answer === null || answer.event !== 'change.start' || answer.outcome !== 'passed' || !answer.system || !answer.change) return;
    const log = (this.histories.get(runId) ?? []).map((h) => h.event).find((e) => e.type === 'log' && e.message.startsWith('transcript: '));
    const stem = log?.type === 'log' ? (log.message.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '') : '';
    if (stem !== '') this.triageStarted.set(`${answer.system}/${stem}`, answer.change);
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
      const open = (g: { runId: string; repo: string }, waits: boolean): OpenRun => ({ run: Number(g.runId), kind: g.repo === 'review' ? 'review' : 'build', repo: g.repo === 'review' ? null : g.repo, waiting: waits });
      // What the backend says picking the entry opens: the one waiting session, else a list of the runs, else the change.
      const opens: Opens = asking.length === 1 ? { kind: 'session', run: open(asking[0], true) } : asking.length > 1 ? { kind: 'list', runs: asking.map((g) => open(g, true)) } : v.going.length > 0 ? { kind: 'list', runs: v.going.map((g) => open(g, false)) } : { kind: 'change' };
      const base = { change: v.change, since: v.changedMs, waiting, opens, workspaceId: this.sdlc.getWorkspaces()[0]?.id ?? null };
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
  async sdlcState(folder: string, systems: string[]): Promise<WorkspaceView> {
    return this.sdlc.workspaceView(systems, await this.sdlcPluginReadiness(folder));
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
  /** Everything the change page opens with, from the fixture the change's home picks; rejects for a change the workspace does not list. */
  async sdlcOpenChange(ref: ChangeRef, doc: string): Promise<OpenedChange> {
    const view = await this.sdlcChangeState(ref.workspace, ref.system, ref.change);
    const planned = view.state.documents.plan.exists;
    // Composed of the transport's own reads, so a test that changes what a read answers changes what the change opens with.
    const text = await this.sdlcReadDoc(ref, doc);
    const parsed = await this.parsedOf(ref, doc);
    // As the backend does: a part that cannot be read is left out with its reason, and the open still succeeds.
    const notices: OpenNotice[] = [];
    const failed = (part: OpenNotice['part']) => (e: unknown): null => {
      notices.push({ part, message: e instanceof Error ? e.message : String(e) });
      return null;
    };
    const status = planned ? await this.sdlcBuildStatus(ref).catch(failed('buildStatus')) : null;
    const review = planned ? await this.sdlcReviewRecord(ref).catch(failed('review')) : null;
    return { view, text, parsed, status, review, notices };
  }
  /** The text and the parsed read of one document, composed of the transport's own reads, so a test that changes what a read answers changes what this answers. A parsed read that fails is an error result, as the backend answers. */
  async sdlcReadDocument(ref: ChangeRef, doc: string): Promise<DocumentRead> {
    const text = await this.sdlcReadDoc(ref, doc);
    const parsed = await this.parsedOf(ref, doc);
    return { text, parsed };
  }
  private parsedOf(ref: ChangeRef, doc: string): Promise<ParsedRead | null> {
    if (doc !== 'spec' && doc !== 'plan') return Promise.resolve(null);
    return this.sdlcReadParsed(ref, doc).catch((e): ParsedRead => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  }
  sdlcReadDoc(ref: ChangeRef, doc: string): Promise<string | null> {
    try {
      return Promise.resolve(this.sdlc.readDoc(ref.change, doc));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  sdlcSnapshot(_target: SnapshotTarget): Promise<Snapshot> { return Promise.resolve(this.sdlc.snapshot()); }
  sdlcLeftovers(_target: SnapshotTarget, _before: Snapshot, _build?: BuildScope): Promise<Leftovers> { return Promise.resolve(this.sdlc.leftovers()); }
  sdlcDiscard(_target: SnapshotTarget, _before: Snapshot, paths: string[], _build?: BuildScope): Promise<void> { this.sdlc.discard(paths); return Promise.resolve(); }
  sdlcChangeName(title: string): Promise<string> { return Promise.resolve(this.sdlc.changeName(title)); }
  /** The change the run's own events name as started: the plugin's `change start` answer among its tool results, as the backend reads the run's record. */
  sdlcTriageChange(transcript: string, system: string): Promise<string | null> {
    return Promise.resolve(this.triageStarted.get(`${system}/${transcript}`) ?? null);
  }
  sdlcStartChange(_folder: string, _system: string, title: string, _workType: string, _scope: string, branch?: string): Promise<ChangeStart> { return Promise.resolve(this.sdlc.startChange(title, branch)); }
  sdlcNaming(_folder: string, _masterRepo: string, _system: string): Promise<NamingState> { return Promise.resolve(this.sdlc.naming()); }
  sdlcCheckScope(_folder: string, scope: string): Promise<string[]> { return Promise.resolve(scope.includes(' ') ? ['a scope cannot contain a space'] : []); }
  sdlcRenameBranch(_folder: string, _workspaceId: string, _system: string, change: string, to: string): Promise<RenameOutcome> { return Promise.resolve(this.sdlc.renameBranch(change, to)); }
  /** Refused, as the backend refuses it, while a change's document run is live. */
  sdlcCheckout(master: string, branch: string): Promise<void> {
    const busy = [...this.changeRunsLive].find(([id]) => this.runs.get(id)?.ended !== true);
    if (busy !== undefined) return Promise.reject(`The change ${busy[1]} has a run working in ${master}. Switch the branch after the run ends.`);
    this.sdlc.checkout(branch);
    return Promise.resolve();
  }
  sdlcAccept(change: ChangeRef, doc: ChangeDocument): Promise<AcceptOutcome> { return Promise.resolve(this.sdlc.accept(change.change, doc)); }
  sdlcCopyRemoval(change: ChangeRef): Promise<CopyRemoval> { return Promise.resolve(this.sdlc.copyRemoval(change.change)); }
  sdlcCopyBranch(change: ChangeRef): Promise<string> { return Promise.resolve(this.sdlc.copyBranch(change.change)); }
  sdlcRemoveCopy(change: ChangeRef): Promise<RemoveOutcome> { return Promise.resolve(this.sdlc.removeCopy(change.change)); }
  sdlcOpenCopyFolder(change: ChangeRef): Promise<void> {
    try {
      this.sdlc.openCopyFolder(change.change);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  sdlcReject(change: ChangeRef): Promise<RejectOutcome> { return Promise.resolve(this.sdlc.reject(change.change)); }
  sdlcRunLinks(): Promise<RunLink[]> { return Promise.resolve(this.sdlc.runLinks()); }
  sdlcLinkRun(link: RunLink): Promise<void> { this.sdlc.linkRun(link); return Promise.resolve(); }
  sdlcTaskLinks(): Promise<TaskLink[]> { return Promise.resolve(this.sdlc.taskLinks()); }
  /** The scripted run has no process to wait for. */
  sdlcWaitRunExit(_runId: string, _timeoutMs: number): Promise<boolean> { return Promise.resolve(true); }
  sdlcBuildStatus(ref: ChangeRef): Promise<BuildStatus> { return settled(() => this.sdlc.buildStatus(ref.change)); }
  sdlcBuildBoard(repos: string[], status: BuildStatus, going: string[], stopped: { [repo: string]: Stop | undefined }): Promise<RepoBoard[]> { return Promise.resolve(mockBoard(repos, status, going, stopped)); }
  sdlcReviewStanding(input: ReviewStandingInput): Promise<ReviewStanding> { return Promise.resolve(mockStanding(input)); }
  /** The fixture's parsed read; only the transport's own reads call it. */
  sdlcReadParsed(ref: ChangeRef, doc: string): Promise<ParsedRead | null> { return settled(() => this.sdlc.readParsed(ref.change, doc)); }
  sdlcReviewRecord(ref: ChangeRef): Promise<ReviewRecord | null> { return settled(() => { this.sdlc.homeOf(ref.change); return this.sdlc.reviewRecord(); }); }
  sdlcBuildHeads(ref: ChangeRef, repos: string[]): Promise<Record<string, string>> { return settled(() => { this.sdlc.homeOf(ref.change); return this.sdlc.heads(repos); }); }
  sdlcPluginReadiness(_workdir: string | null): Promise<Readiness> { return Promise.resolve({ kind: 'ready', plugin: { dir: '~/.claude/plugins/ai-sdlc', version: MOCK_PLUGIN_VERSION, layouts: MOCK_LAYOUTS }, gh: 'present' }); }
  sdlcChangeRepos(ref: ChangeRef): Promise<ChangeRepo[]> { return settled(() => this.sdlc.changeRepos(ref.workspace, ref.change)); }
  sdlcMissingChangeBranches(ref: ChangeRef): Promise<string[]> { return settled(() => { this.sdlc.homeOf(ref.change); return []; }); }
  sdlcDiffFiles(_repoPath: string, part: Part): Promise<DiffListing> { return Promise.resolve(this.sdlc.diffFiles(part)); }
  sdlcCommitFiles(repoPath: string): Promise<CommitFiles[]> { return Promise.resolve(this.sdlc.commitFiles(repoPath)); }
  sdlcDiffPair(_repoPath: string, _part: Part, path: string): Promise<FilePair> { return Promise.resolve(this.sdlc.diffPair(path)); }
  sdlcDiffBase(_repoPath: string): Promise<BaseInfo> { return Promise.resolve(this.sdlc.diffBase()); }
  sdlcOldChecks(_folder: string, systems: string[]): Promise<OldChecksNotice[]> { return Promise.resolve(this.sdlc.oldChecks(systems)); }
  sdlcOldChecksSeen(systems: string[]): Promise<void> { this.sdlc.oldChecksSeen(systems); return Promise.resolve(); }
  sdlcChecksView(change: ChangeRef): Promise<RepoCheckView[]> { return Promise.resolve(this.sdlc.checksView(change.change)); }
  /** The plugin's answer to declaring the change done, with the steps it reports on the way; `?demo=done-refused`, `done-partial`, `done-cannot`, `done-gh` and `done-warnings` give each of the other answers. */
  async sdlcDeclareDone(change: ChangeRef): Promise<DeclareView> {
    const { view, steps } = this.sdlc.declareDone(change.change);
    for (const step of steps) for (const listen of [...this.doneListeners]) listen(step);
    return view;
  }
  /** `?demo=pr-fail` makes the read fail, so the browser checks can see the "Could not check pull requests" note; `?demo=one-pr` keeps only the
   *  first pull request, so they can see the single inline link; `?demo=pr-states` gives each state GitHub can answer with and one it cannot;
   *  `?demo=earlier-declaration` records the pull requests the way an earlier version of Kata did. Browser only; this class never runs under Tauri. */
  async sdlcPullRequestsView(_folder: string, _workspaceId: string, _system: string, change: string, refresh: boolean): Promise<PullRequestsView> {
    const demo = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('demo');
    if (demo === 'pr-fail') throw new Error('the recorded pull requests could not be read');
    const view = this.sdlc.pullRequestsView(change, refresh);
    return demo === 'one-pr' ? { ...view, links: view.links.slice(0, 1) } : view;
  }
  loadBuildLayout(): Promise<unknown> { return Promise.resolve(this.buildLayout); }
  saveBuildLayout(layout: Record<string, unknown>): Promise<void> { this.buildLayout = layout; return Promise.resolve(); }
  openUrl(url: string): Promise<void> { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve(); }
  /** A plain browser has no window to zoom. */
  zoom(_step: ZoomStep): Promise<number> { return Promise.resolve(1); }
  appVersions(): Promise<Versions> { return Promise.resolve(mockVersions(demoParam())); }
  copyText(text: string): Promise<void> { return navigator.clipboard.writeText(text); }
  pickDirectory(): Promise<string | null> { return Promise.resolve(null); }
  pickOpenSpec(): Promise<string | null> { return Promise.resolve(null); }
  pickSaveSpec(): Promise<string | null> { return Promise.resolve(null); }

  async onDoneStep(cb: (step: DoneStep) => void): Promise<() => void> {
    this.doneListeners.add(cb);
    return () => { this.doneListeners.delete(cb); };
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
    // `?demo=close` (browser only) asks the close question once the app shell listens, so the browser checks can see the dialog.
    if (demoParam() === 'close') queueMicrotask(() => cb({ type: 'ask', running: [{ change: 'A', what: 'building in kata' }, { change: 'B', what: 'writing its spec' }] }));
    return () => { this.closeListeners.delete(cb); };
  }
  async sdlcRunHistory(runId: string): Promise<HistoryEntry[]> { return [...(this.histories.get(runId) ?? [])]; }
  async sdlcRunChange(change: ChangeRef, kind: DocumentKind, form: RunForm): Promise<string> {
    void kind;
    const id = await this.runSpec({ ...seedSpec(), name: form.name, task: form.task, workdir: change.workspace });
    this.changeRunsLive.set(id, change.change);
    return id;
  }
  async sdlcBuildStart(change: ChangeRef, form: StartForm): Promise<StartOutcome> { return this.host.start(change, form); }
  // The scripted host runs no agent, so the choices a continue or review carries change nothing it shows.
  async sdlcBuildContinue(change: ChangeRef, repo: string, _off?: string[]): Promise<StartOutcome> { return this.host.continueRepo(change, repo); }
  async sdlcBuildState(change: ChangeRef): Promise<BuildState | null> { return this.host.state(change); }
  async sdlcChangeKey(change: ChangeRef): Promise<ChangeKey> { return mockChangeKey(change); }
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
  async sdlcReviewStart(change: ChangeRef, _off?: string[]): Promise<StartOutcome> { return this.host.reviewStart(change); }
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
