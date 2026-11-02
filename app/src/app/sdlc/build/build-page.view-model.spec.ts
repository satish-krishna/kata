import { Component, effect, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { BuildState } from '@bindings/BuildState';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { OfferStage } from '@bindings/OfferStage';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { ReviewRows } from '@bindings/ReviewRows';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { StartForm } from '@bindings/StartForm';
import type { TaskLink } from '@bindings/TaskLink';
import { toastState } from '@spartan-ng/brain/sonner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { ProgressStore } from '../../core/progress/progress.store';
import { ChangeDraftStore } from '../../core/sdlc/change-draft.store';
import { RunStore } from '../../core/run/run.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { GivenStore } from '../../core/given/given.store';
import { MOCK_BUILD_CHANGE, MOCK_DONE_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { IDLE, type RunSnapshot } from '../../core/run/reduce';
import { BuildLayoutViewModel } from './build-layout.view-model';
import { BuildPageViewModel, findingsAreaOf, type BuildContext, type Departure, type FindingsView, type ReviewEntry } from './build-page.view-model';
import { atStage, readAllChanges } from '../../../testing/read-all';

const FOLDER = MOCK_WORKSPACE_FOLDER;
const CTX: BuildContext = { workspaceId: 'acme-commerce', folder: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE, systemRepos: [] };
const REF = { workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };

/** Stands in for the change page, which provides the build page's view model and the preview beside its own. */
@Component({ template: '', providers: [BuildPageViewModel, RunPreviewViewModel] })
class Host {}

/** The hosts made in this test, so a time step can run the change detection that carries their view effects. */
let hosts: ComponentFixture<Host>[] = [];

function openHost() {
  const fixture = TestBed.createComponent(Host);
  hosts.push(fixture);
  return fixture;
}

function setup(transport = new MockTransport()) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: KataTransport, useValue: transport }],
  });
  const host = openHost();
  return {
    host,
    preview: host.debugElement.injector.get(RunPreviewViewModel),
    vm: host.debugElement.injector.get(BuildPageViewModel),
    transport,
    runs: TestBed.inject(RunStore),
  };
}

/** Advances the fake clock in small steps, flushing effects between them, the way a running app would. */
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
    TestBed.tick();
    for (const h of hosts) h.detectChanges();
  }
};

/** Runs the build to its end, answering every question the agents ask, until `done` holds. */
async function drive(vm: BuildPageViewModel, runs: RunStore, done: () => boolean, limitMs = 60000) {
  for (let t = 0; t < limitMs && !done(); t += 100) {
    await advance(100);
    for (const g of vm.groups()) {
      for (const run of g.runs) {
        const ask = run.asks.find((a) => a.answers === null);
        if (ask && run.state === 'awaiting') void runs.submitAnswer(run.id, ask.id, [['Reuse it']]);
      }
    }
  }
  await advance(200);
  expect(done()).toBe(true);
}

const group = (vm: BuildPageViewModel, repo: string) => vm.view().groups.find((g) => g.repo === repo)!;
const finished = (vm: BuildPageViewModel) => () => vm.phase() === 'finished' && vm.findings().length > 0;
const keyOf = (change: string): ChangeKey => ({ workspace: { key: FOLDER.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(), name: 'ws' }, system: 'commerce', change });
const state = (over: Partial<BuildState> = {}): BuildState => ({ phase: 'building', going: ['commerce-core'], stopped: {}, rounds: {}, waiting: [], report: null, ...over });

/** The page opened on the mock build change, as the change page would give it. */
async function opened(s: ReturnType<typeof setup>, over: { stage?: OfferStage; built?: boolean; review?: ReviewRecord | null; done?: boolean } = {}) {
  const status = await s.transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
  const [found] = (await readAllChanges(s.transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
  const change = over.stage === undefined ? found : atStage(found, over.stage);
  const load = () => s.vm.load({ ctx: CTX, master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` }, change, status, done: over.done ?? false, review: over.review ?? null });
  return { ...s, load, status, change };
}

beforeEach(() => {
  hosts = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  toastState.reset();
});

describe('the build page follows the build the backend hosts', () => {
  it('starting a build through the host starts every repository that does not wait, and the page follows each run (R2.1)', async () => {
    const s = await opened(setup());
    await s.load();
    expect(await s.vm.startBuild({ timeoutSecs: 5400 })).toBe('started');
    await advance(500);
    expect(s.vm.phase()).toBe('building');
    expect(s.vm.view().actions).toEqual(['cancel-build']);
    expect(s.vm.view().groups.map((g) => g.repo)).toEqual(['commerce-core', 'customer-portal']);
    expect(s.vm.groups().map((g) => g.key).sort()).toEqual(['commerce-core', 'customer-portal']);
    expect(group(s.vm, 'commerce-core')).toMatchObject({ status: { tone: 'success' }, action: 'cancel' });
    expect(group(s.vm, 'commerce-core').tasks[0].status).toEqual({ tone: 'success', label: 'Running' });
    expect(s.vm.view().sessions.length).toBeGreaterThan(0);
    expect(s.vm.view().facts.tasks).toBe('0/3 tasks');
  });

  it('shows the progress line while the host starts a build, and takes it away when the start has answered', async () => {
    const s = await opened(setup());
    await s.load();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const real = s.transport.sdlcBuildStart.bind(s.transport);
    vi.spyOn(s.transport, 'sdlcBuildStart').mockImplementation(async (ref, form) => {
      await slow;
      return real(ref, form);
    });
    const progress = TestBed.inject(ProgressStore);
    const starting = s.vm.startBuild({ timeoutSecs: 60 });
    await advance(600);
    expect(progress.view('build')()?.label).toBe('Checking the repositories before building');
    release();
    await starting;
    expect(progress.view('build')()).toBeNull();
  });

  it('Cancel on one repository stops only its run, and the host says the repository stopped (R6.1)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(500);
    s.vm.select('commerce-core');
    s.vm.cancelRun();
    await advance(500);
    expect(group(s.vm, 'commerce-core')).toMatchObject({ status: { tone: 'error', label: 'Stopped at T1' }, action: 'continue', stopLine: 'stopped: cancelled' });
    expect(group(s.vm, 'customer-portal').action).toBe('cancel');
    expect(s.vm.phase()).toBe('building');
  });

  it('Cancel build stops every run and starts none', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(500);
    s.vm.cancelBuild();
    await advance(500);
    expect(s.vm.phase()).toBe('cancelled');
    expect(s.vm.stage()).toBe('cancelled');
    expect(s.vm.view().groups.every((g) => g.action === 'continue' || g.action === null)).toBe(true);
    expect(s.vm.stageMessage()?.title).toBe('The build was cancelled.');
  });

  it('Continue runs the stopped repository again through the host, after its preview (R6.1)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(500);
    s.vm.select('commerce-core');
    s.vm.cancelRun();
    await advance(500);
    const resume = vi.spyOn(s.transport, 'sdlcBuildContinue');
    vi.spyOn(s.preview, 'openBuild').mockImplementation(async (req) => ({ off: new Set(req.from.build ?? []), request: null, picks: null, plan: null }));
    s.vm.select('commerce-core');
    await s.vm.continueRun();
    expect(resume).toHaveBeenCalledWith(REF, 'commerce-core', []);
    await advance(500);
    expect(group(s.vm, 'commerce-core').action).toBe('cancel');
  });

  it('a committed row shows its task done and the next one running without a click', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    const states = (repo: string) => Object.fromEntries(s.vm.taskAreas().find((g) => g.repo === repo)!.tasks.map((t) => [t.id, t.state.kind]));
    expect(states('customer-portal')).toEqual({ T2: 'running', T3: 'not-started' });
    const sdlc = (s.transport as unknown as { sdlc: { commitRows(t: { id: string; name: string; repo: string; dependsOn: string[] }[]): void } }).sdlc;
    sdlc.commitRows([
      { id: 'T1', name: '', repo: 'commerce-core', dependsOn: [] },
      { id: 'T2', name: '', repo: 'customer-portal', dependsOn: [] },
    ]);
    await advance(2500);
    expect(states('customer-portal')).toEqual({ T2: 'done', T3: 'running' });
  });

  it('the host reviews the finished build by itself and the page shows its findings, most serious first (R8.2)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await drive(s.vm, s.runs, () => s.vm.phase() === 'finished' && s.vm.findings().length > 0);
    expect(s.vm.findings().map((f) => f.text)).toEqual([
      'The upload limit is duplicated in commerce-core and customer-portal.',
      'The refusal message has no test.',
    ]);
    expect(s.vm.view().stage).toBe('review-finished');
    expect(group(s.vm, 'commerce-core').status).toEqual({ tone: 'success', label: 'Finished' });
    expect(s.vm.tasksLabel()).toBe('3/3 tasks');
    expect(s.vm.active()).toBe(false);
  });

  it('runs the backend started are linked to the change once their transcript shows, and each task once', async () => {
    const s = await opened(setup());
    const linkRun = vi.spyOn(s.transport, 'sdlcLinkRun');
    const before = await s.transport.sdlcTaskLinks();
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    const sdlc = (s.transport as unknown as { sdlc: { commitRows(t: { id: string; name: string; repo: string; dependsOn: string[] }[]): void } }).sdlc;
    sdlc.commitRows([{ id: 'T1', name: '', repo: 'commerce-core', dependsOn: [] }]);
    await advance(2500);
    expect(linkRun.mock.calls.map(([l]) => l.stage).sort()).toEqual(['build:commerce-core', 'build:customer-portal']);
    const id = s.vm.groups().find((g) => g.key === 'commerce-core')!.runs[0].id;
    // The host records which run recorded a task; the page never writes a task link.
    expect(await s.transport.sdlcTaskLinks()).toEqual(before);
    expect(id).toBeTruthy();
  });

  it('the switched-off given items of the build go to the host with a start, a preview, a continue and a review', async () => {
    const s = await opened(setup());
    await s.load();
    const key = `commerce/${MOCK_BUILD_CHANGE}`;
    const off = ['personal:plugin:superpowers@claude-plugins-official', 'run-spec:skill:doc-writer'];
    TestBed.inject(GivenStore).setBuild(key, { off: new Set(off) });
    const start = vi.spyOn(s.transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'started', uncommitted: {} });
    await s.vm.startBuild({ timeoutSecs: 60 });
    expect(start).toHaveBeenCalledWith(REF, { timeoutSecs: 60, off });
    const previewed = vi.spyOn(s.transport, 'sdlcPreviewBuild');
    vi.spyOn(s.preview, 'openBuild').mockResolvedValue(null);
    await s.vm.openPreview('start');
    expect(previewed.mock.calls[0][3].off).toEqual(off);
    vi.spyOn(s.preview, 'openBuild').mockImplementation(async (req) => ({ off: new Set(req.from.build ?? []), request: null, picks: null, plan: null }));
    const resume = vi.spyOn(s.transport, 'sdlcBuildContinue').mockResolvedValue({ kind: 'started', uncommitted: {} });
    s.vm.select('commerce-core');
    await s.vm.continueRun();
    expect(resume).toHaveBeenCalledWith(REF, 'commerce-core', off);
  });

  it('answers and messages go to the run store by run id', async () => {
    const s = await opened(setup());
    const answer = vi.spyOn(s.runs, 'submitAnswer').mockResolvedValue();
    const decide = vi.spyOn(s.runs, 'submitDecision').mockResolvedValue();
    const message = vi.spyOn(s.runs, 'sendMessage').mockResolvedValue();
    s.vm.answer('7', { id: 'q1', answers: [['Reuse it']] });
    s.vm.decide('7', { id: 'p1', allow: false, message: 'not that' });
    s.vm.sendMessage('7', 'skip it');
    expect(answer).toHaveBeenCalledWith('7', 'q1', [['Reuse it']]);
    expect(decide).toHaveBeenCalledWith('7', 'p1', false, 'not that');
    expect(message).toHaveBeenCalledWith('7', 'skip it');
  });
});

describe('the build page shows tasks and sessions from the build log, the run links and the records', () => {
  const secs = (h: number, m = 0) => Math.floor(new Date(2026, 9, 19, h, m, 0).getTime() / 1000);
  const link = (stage: string, run_id: string, started_at: number): RunLink => ({ workspace_id: 'acme-commerce', system: 'commerce', change: MOCK_BUILD_CHANGE, stage, run_id, started_at });
  const taskLink = (task: string, run_id: string, repo = 'commerce-core'): TaskLink => ({ workspace_id: 'acme-commerce', system: 'commerce', change: MOCK_BUILD_CHANGE, repo, task, run_id });
  const record = (id: string, exit: number): RunRecord => ({ id, kata: 'build', started_at: 0, isolation: 'none', steered: false, exit, turns: 7, cost_usd: 0.5 });
  const T1_ROW = { task: 'T1', repo: 'commerce-core', commits: ['aaaaaaa'], departure: null };

  /** A page opened on a change with nothing running; T1 is in the build log when `built`. */
  async function page(over: { links?: RunLink[]; taskLinks?: TaskLink[]; records?: RunRecord[]; built?: boolean; stage?: OfferStage } = {}) {
    const s = setup();
    vi.spyOn(s.transport, 'sdlcRunLinks').mockResolvedValue(over.links ?? []);
    vi.spyOn(s.transport, 'sdlcTaskLinks').mockResolvedValue(over.taskLinks ?? []);
    vi.spyOn(s.transport, 'listRuns').mockResolvedValue(over.records ?? []);
    const base = await s.transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
    const status: BuildStatus = (over.built ?? true) ? { ...base, tasks: base.tasks.map((t) => (t.id === 'T1' ? { ...t, row: T1_ROW } : t)) } : base;
    vi.spyOn(s.transport, 'sdlcBuildStatus').mockResolvedValue(status);
    return opened(s, over.stage === undefined ? {} : { stage: over.stage });
  }

  it('shows where each repository stands and what each task shows as the backend decided, from the status and live state it read (F12)', async () => {
    const s = await page({ built: false });
    // The backend says the repository stopped on T1, though nothing in the log or the host would: the page follows the backend.
    const board = vi.spyOn(s.transport, 'sdlcBuildBoard').mockResolvedValue([
      { repo: 'commerce-core', situation: { kind: 'stopped', task: 'T1', reason: 'from the backend' }, tasks: [{ id: 'T1', state: { kind: 'stopped', reason: 'from the backend' } }] },
    ]);
    await s.load();
    expect(board).toHaveBeenCalled();
    const [repos, status, going, stopped] = board.mock.calls.at(-1)!;
    expect(repos).toContain('commerce-core');
    expect(status).toEqual(s.status);
    expect(going).toEqual([]);
    expect(stopped).toEqual({});
    const area = s.vm.taskAreas().find((g) => g.repo === 'commerce-core')!;
    expect(area.situation).toEqual({ kind: 'stopped', task: 'T1', reason: 'from the backend' });
    expect(area.tasks.find((t) => t.id === 'T1')!.state).toEqual({ kind: 'stopped', reason: 'from the backend' });
  });

  it('judges the review by the standing the backend decided from the links, records, heads and document the page read (F12)', async () => {
    const s = await page({ links: [link('review', 'run-r', secs(8))], records: [record('run-r', 0)] });
    vi.spyOn(s.transport, 'sdlcBuildHeads').mockResolvedValue({ 'commerce-core': 'abc1234' });
    const standing = vi.spyOn(s.transport, 'sdlcReviewStanding').mockResolvedValue({ kind: 'stale' });
    await s.load();
    expect(standing).toHaveBeenCalledWith({
      links: [link('review', 'run-r', secs(8))],
      records: [record('run-r', 0)],
      heads: { 'commerce-core': 'abc1234' },
      scope: { workspaceId: CTX.workspaceId, system: 'commerce', change: MOCK_BUILD_CHANGE },
      document: null,
      master: MOCK_MASTER,
    });
    expect(s.vm.reviewEntry()).toBe('stale');
  });

  it('picking a task shows the session that recorded it', async () => {
    const { vm, load } = await page({
      links: [link('build:commerce-core', 'run-a', secs(8)), link('build:commerce-core', 'run-b', secs(9))],
      taskLinks: [taskLink('T1', 'run-b')],
    });
    await load();
    vm.choose({ kind: 'task', task: 'T1' });
    expect(vm.shownSessions().map((s) => s.id)).toEqual(['run-b']);
    expect(vm.shownSessions()[0]).toMatchObject({ latest: true, spec: null });
    expect(vm.sessionNote()).toBeNull();
  });

  it('a task with no known session shows its repository\'s sessions and says so', async () => {
    const { vm, load } = await page({ links: [link('build:commerce-core', 'run-a', secs(8)), link('build:commerce-core', 'run-b', secs(9))] });
    await load();
    vm.choose({ kind: 'task', task: 'T1' });
    expect(vm.shownSessions().map((s) => s.id)).toEqual(['run-a', 'run-b']);
    expect(vm.sessionNote()).toBe('This task was recorded before Kata linked tasks to runs, or on another machine. Showing every session of commerce-core.');
  });

  it('a reopened change shows each repository from the build log alone: ready ones as not started, with no stop the backend did not announce', async () => {
    const { vm, load, change } = await page({ built: false, stage: 'build-stopped', links: [link('build:commerce-core', 'run-a', secs(8))], records: [record('run-a', 1)] });
    await load();
    const g = group(vm, 'commerce-core');
    expect(g.status).toEqual({ tone: 'idle', label: 'Not started' });
    expect(g.action).toBeNull();
    expect(g.stopLine).toBeNull();
    expect(vm.view().stops).toEqual([]);
    // What the bar offers is what the plugin's answer lists for the change.
    expect(vm.view().actions).toEqual(change.offer.actions.map((a) => a.action).filter((a) => ['start-build', 'continue-build', 'another-round', 'run-review', 'declare-done'].includes(a)));
  });

  it('earlier runs fold under the latest with their start time and how they ended', async () => {
    const { vm, load } = await page({
      built: false,
      links: [link('build:commerce-core', 'run-a', secs(8)), link('build:commerce-core', 'run-b', secs(8, 30))],
      records: [record('run-a', 124), record('run-b', 1)],
    });
    await load();
    await vm.startBuild({ timeoutSecs: 5400 });
    await advance(500);
    vm.choose({ kind: 'repo', repo: 'commerce-core' });
    const [a, b, live] = vm.shownSessions();
    expect([a.id, b.id]).toEqual(['run-a', 'run-b']);
    expect([a.startedAt, b.startedAt]).toEqual(['08:00:00', '08:30:00']);
    expect(a.outcome).toContain('exit 124');
    expect(b.outcome).toContain('exit 1 ');
    expect([a.latest, b.latest, live.latest]).toEqual([false, false, true]);
    expect([a.expanded, b.expanded, live.expanded]).toEqual([false, false, false]);
    vm.toggleRun('run-a');
    expect(vm.shownSessions()[0].expanded).toBe(true);
  });

  it('a not-started change with uncommitted edits shows the files area', async () => {
    const { vm, transport, load } = await page({ built: false });
    const empty = { files: [], loc: [] };
    const listing = { files: [{ path: 'src/a.ts', oldPath: null, status: 'modified', added: 1, removed: 0, binary: false, uncommitted: true }], loc: [] };
    const read = vi.spyOn(transport, 'sdlcDiffFiles').mockImplementation((path) => Promise.resolve((path.endsWith('commerce-core') ? listing : empty) as never));
    await load();
    await advance(100);
    expect(vm.view().areas.files).toBe(true);
    read.mockResolvedValue(empty as never);
    await load();
    await advance(100);
    expect(vm.view().areas.files).toBe(false);
  });

  it('counts the changed files for the area tabs', async () => {
    const { vm, transport, load } = await page({ built: false });
    const empty = { files: [], loc: [] };
    const file = (path: string) => ({ path, oldPath: null, status: 'modified', added: 1, removed: 0, binary: false, uncommitted: true });
    const listing = { files: [file('src/a.ts'), file('src/b.ts')], loc: [] };
    vi.spyOn(transport, 'sdlcDiffFiles').mockImplementation((path) => Promise.resolve((path.endsWith('commerce-core') ? listing : empty) as never));
    await load();
    await advance(100);
    expect(vm.view().counts).toEqual({ files: 2, findings: 0 });
  });

  it('every live session stays in the view, hidden, whatever is picked', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(500);
    const idOf = (key: string) => s.vm.groups().find((g) => g.key === key)!.runs[0].id;
    const [core, portal] = [idOf('commerce-core'), idOf('customer-portal')];
    const find = (id: string) => s.vm.view().sessions.find((x) => x.id === id);
    s.vm.choose({ kind: 'repo', repo: 'commerce-core' });
    expect(find(core)?.shown).not.toBe(false);
    expect(find(portal)?.shown).toBe(false);
    s.vm.choose({ kind: 'repo', repo: 'customer-portal' });
    expect(find(portal)?.shown).not.toBe(false);
    expect(find(core)?.shown).toBe(false);
  });

  it('a repository the backend names as waiting shows what it waits for, and its task is not running', async () => {
    const { vm, load, transport } = await page({ built: false });
    vi.spyOn(transport, 'sdlcBuildState').mockResolvedValue(state({ going: ['commerce-core'], waiting: [{ repo: 'customer-portal', task: 'T3', onTask: 'T1', onRepo: 'commerce-core' }] }));
    await load();
    await advance(50);
    const portal = group(vm, 'customer-portal');
    expect(portal.status.tone === 'success').toBe(false);
    expect(portal.action).toBeNull();
  });

  const failed: RepoCheckView = { repo: 'commerce-core', view: { kind: 'failedStop', id: 'unit', output: '2 tests failed' }, summary: 'unit failed. The build stopped here.' };
  const passed: RepoCheckView = { repo: 'customer-portal', view: { kind: 'passed', hooks: [{ id: 'lint', outcome: 'passed' }] }, summary: 'The checks passed.' };

  it('a group carries the checks of its repository exactly as the plugin answered, and none for a repository it did not name', async () => {
    const { vm, load, transport } = await page({ built: false });
    const read = vi.spyOn(transport, 'sdlcChecksView').mockResolvedValue([failed, passed]);
    await load();
    await advance(100);
    expect(read).toHaveBeenCalledWith(REF);
    expect(group(vm, 'commerce-core').checks).toEqual(failed);
    expect(group(vm, 'customer-portal').checks).toEqual(passed);
    read.mockResolvedValue([passed]);
    await load();
    await advance(100);
    expect(group(vm, 'commerce-core').checks).toBeNull();
  });

  it('reads them again when the host announces the build moved, so a finished run shows its result', async () => {
    const { vm, load, transport } = await page({ built: false });
    const read = vi.spyOn(transport, 'sdlcChecksView').mockResolvedValue([]);
    await load();
    await advance(100);
    const first = read.mock.calls.length;
    read.mockResolvedValue([failed]);
    expect(await vm.startBuild({ timeoutSecs: 5400 })).toBe('started');
    await advance(500);
    expect(read.mock.calls.length).toBeGreaterThan(first);
    expect(group(vm, 'commerce-core').checks).toEqual(failed);
  });
});

describe('what the pick is and what the activity area shows for it', () => {
  const commitRows = (transport: MockTransport) =>
    (transport as unknown as { sdlc: { commitRows(t: { id: string; name: string; repo: string; dependsOn: string[] }[]): void } }).sdlc.commitRows([
      { id: 'T1', name: '', repo: 'commerce-core', dependsOn: [] },
      { id: 'T2', name: '', repo: 'customer-portal', dependsOn: [] },
    ]);

  it('picks the review by the stage alone: while it runs, then its findings, whatever was picked or gone to earlier (R2.1, D9)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    s.vm.goTo('customer-portal');
    s.vm.choose({ kind: 'task', task: 'T2' });
    expect(s.vm.pick()).toEqual({ kind: 'task', task: 'T2' });
    await drive(s.vm, s.runs, () => s.vm.stage() === 'reviewing');
    expect(s.vm.pick()).toEqual({ kind: 'review' });
    expect(s.vm.view().review.picked).toBe(true);
    expect(s.vm.shownSessions().length).toBe(1);
    expect(s.vm.shownSessions()[0].live).toBe(true);
    expect(s.vm.focusRequest()).toBeNull();
    s.vm.choose({ kind: 'repo', repo: 'commerce-core' });
    expect(s.vm.pick()).toEqual({ kind: 'repo', repo: 'commerce-core' });
    await drive(s.vm, s.runs, finished(s.vm));
    expect(s.vm.stage()).toBe('review-finished');
    expect(s.vm.pick()).toEqual({ kind: 'review' });
    expect(s.vm.view().findingsArea.review).not.toBeNull();
  });

  it('a Go to picks the repository and asks for its question to be brought into view, once per Go to', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    s.vm.choose({ kind: 'repo', repo: 'commerce-core' });
    expect(s.vm.focusRequest()).toBeNull();
    s.vm.goTo('customer-portal');
    const first = s.vm.focusRequest();
    expect(s.vm.pick()).toEqual({ kind: 'repo', repo: 'customer-portal' });
    expect(first).toMatchObject({ repo: 'customer-portal' });
    s.vm.goTo('customer-portal');
    expect(s.vm.focusRequest()!.n).toBeGreaterThan(first!.n);
    s.vm.choose({ kind: 'repo', repo: 'commerce-core' });
    expect(s.vm.focusRequest()).toBeNull();
  });

  it('keeps the picked task\'s identity when the build log is read again, so the Changes view keeps its untied files shown (R5.2)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    s.vm.choose({ kind: 'task', task: 'T2' });
    const before = s.vm.pickedTask();
    expect(before).toEqual(expect.objectContaining({ id: 'T2', repo: 'customer-portal' }));
    commitRows(s.transport);
    await advance(2500);
    expect(s.vm.pickedTask()).toBe(before);
  });

  it('a pick of the same task again is a new pick, so the Changes view starts over (T9, R5.2)', async () => {
    const s = await opened(setup());
    await s.load();
    await s.vm.startBuild({ timeoutSecs: 5400 });
    await advance(300);
    s.vm.choose({ kind: 'task', task: 'T2' });
    const first = s.vm.pickedTask();
    s.vm.choose({ kind: 'task', task: 'T2' });
    const again = s.vm.pickedTask();
    expect(again).toEqual(expect.objectContaining({ id: 'T2', repo: 'customer-portal' }));
    expect(again).not.toBe(first);
    commitRows(s.transport);
    await advance(2500);
    expect(s.vm.pickedTask()).toBe(again);
  });
});

describe('the findings area shows what the review knows at each stage (R4.3)', () => {
  const READING = 'Reading the review…';
  const NOT_RUN = 'The review runs by itself once the last task is recorded.';
  const RUNNING = 'The review is running. Its findings appear here when it ends.';
  const STALE = 'The work changed since it was reviewed.';
  const found = [
    { severity: 'high' as const, text: 'The limit is not enforced on retry', file: 'src/a.ts', line: 4 },
    { severity: null, text: 'The refusal message has no test' },
  ];
  const review = (findings = found): FindingsView => ({ notice: null, groups: [{ repo: null, findings }], findings, replaced: [], older: false, emptyText: 'Reviewed, nothing found.' });
  const departure: Departure = { repo: 'commerce-core', task: 'T2', text: 'Used the shared limiter instead of a new one' };
  const area = (reading: boolean, entry: ReviewEntry, findings = found, departures: Departure[] = [departure]) =>
    findingsAreaOf({ reading, entry, review: review(findings), departures });

  it('being read: "Reading the review…", whatever the entry and the findings', () => {
    for (const entry of ['not run', 'running', 'finished', 'stale'] as const) {
      expect(area(true, entry), entry).toMatchObject({ message: READING, review: null, staleNotice: null, departures: null });
    }
  });

  it('not run: that the review runs by itself, then the departures', () => {
    expect(area(false, 'not run')).toEqual({ message: NOT_RUN, staleNotice: null, review: null, departures: [departure], noDepartures: null });
  });

  it('running: that the review is running, then the departures', () => {
    expect(area(false, 'running')).toEqual({ message: RUNNING, staleNotice: null, review: null, departures: [departure], noDepartures: null });
  });

  it('finished with findings: the findings, most serious first as given, then the departures', () => {
    const shown = area(false, 'finished');
    expect(shown.message).toBeNull();
    expect(shown.staleNotice).toBeNull();
    expect(shown.review!.findings.map((f) => f.text)).toEqual(found.map((f) => f.text));
    expect(shown.departures).toEqual([departure]);
  });

  it('finished with none: "Reviewed, nothing found." then the departures', () => {
    const shown = area(false, 'finished', []);
    expect(shown.message).toBeNull();
    expect(shown.review!.findings).toEqual([]);
    expect(shown.review!.emptyText).toBe('Reviewed, nothing found.');
    expect(shown.departures).toEqual([departure]);
  });

  it('stale with findings: the out-of-date notice, the findings, then the departures', () => {
    const shown = area(false, 'stale');
    expect(shown.staleNotice).toBe(STALE);
    expect(shown.review!.findings).toHaveLength(2);
    expect(shown.departures).toEqual([departure]);
  });

  it('stale with none: the out-of-date notice, the empty text, then the departures', () => {
    const shown = area(false, 'stale', []);
    expect(shown.staleNotice).toBe(STALE);
    expect(shown.review!.findings).toEqual([]);
    expect(shown.review!.emptyText).toBe('Reviewed, nothing found.');
    expect(shown.departures).toEqual([departure]);
  });

  it('with no departure recorded it says "No departures from the plan."', () => {
    expect(area(false, 'finished', found, [])).toMatchObject({ departures: [], noDepartures: 'No departures from the plan.' });
    expect(area(false, 'not run', found, [])).toMatchObject({ departures: [], noDepartures: 'No departures from the plan.' });
  });

  it('showFinding sets the place with the file, the line or null, the text and a count that rises each time', () => {
    const { vm } = setup();
    vm.showFinding(found[0]);
    expect(vm.view().findingPlace).toEqual({ file: 'src/a.ts', line: 4, text: found[0].text, n: 1 });
    vm.showFinding({ severity: null, text: 'Whole file', file: 'src/b.ts' });
    expect(vm.view().findingPlace).toEqual({ file: 'src/b.ts', line: null, text: 'Whole file', n: 2 });
    vm.showFinding(found[1]);
    expect(vm.view().findingPlace!.n).toBe(2);
  });
});

/** Stands in for the change page when the layout is under test as well: the real build page and the real layout beside the preview. */
@Component({ selector: 'kata-layout-host', template: '', providers: [BuildPageViewModel, RunPreviewViewModel, BuildLayoutViewModel] })
class LayoutHost {}


describe('findings from the review document and the backend\'s rows', () => {
  const section = (number: number, reviewed_at: string, findings: { id: string; severity: 'high' | 'medium' | 'low'; text: string }[]) => ({
    number,
    reviewed_at,
    // Where each repository stands in the mock, so the review covers the work as it is.
    commits: { 'commerce-docs': '1111111', 'commerce-core': '2222222', 'customer-portal': '3333333' },
    findings: findings.map((f) => ({ ...f, file: 'src/a.ts', line: 4 })),
  });
  const document = (...reviews: ReturnType<typeof section>[]): ReviewRecord => ({ layout: 2, reviews, problems: [], master_moved: [] });
  /** The rows the backend lists for a review: most serious first, the low ones apart; the page draws them as they come. */
  const rowsFor = (findings: { id: string; severity: 'high' | 'medium' | 'low'; text: string }[]): ReviewRows => ({
    counts: (['high', 'medium', 'low'] as const).map((severity) => ({ severity, n: findings.filter((f) => f.severity === severity).length })).filter((c) => c.n > 0),
    total: findings.length,
    groups:
      findings.length === 0
        ? []
        : [
            {
              repo: 'commerce-core',
              rows: findings.filter((f) => f.severity !== 'low').map((f) => ({ key: f.id, finding: { ...f, repo: 'commerce-core' }, summary: f.text })),
              low: findings.filter((f) => f.severity === 'low').map((f) => ({ key: f.id, finding: { ...f, repo: 'commerce-core' }, summary: f.text })),
            },
          ],
  });
  async function reviewed(sections: ReturnType<typeof section>[], rows: ReviewRows, stage: OfferStage = 'build-finished') {
    const s = setup();
    vi.spyOn(s.transport, 'sdlcReviewView').mockResolvedValue({ rows, groups: [] });
    const page = await opened(s, { stage, review: document(...sections) });
    await page.load();
    await advance(300);
    return page;
  }

  it('findings come from review.md, not the run words (R14.2)', async () => {
    const { vm } = await reviewed([section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'The limit is not enforced on retry.' }])], rowsFor([{ id: 'F1', severity: 'high', text: 'The limit is not enforced on retry.' }]));
    expect(vm.findings().map((f) => [f.severity, f.text])).toEqual([['high', 'The limit is not enforced on retry.']]);
    expect(vm.older()).toBe(false);
  });

  it('findings written out of order are shown most serious first, equal ranks in the order written (R7.1)', async () => {
    const written = [
      { id: 'F1', severity: 'low' as const, text: 'a nit' },
      { id: 'F2', severity: 'medium' as const, text: 'first medium' },
      { id: 'F3', severity: 'high' as const, text: 'the bug' },
      { id: 'F4', severity: 'medium' as const, text: 'second medium' },
    ];
    const { vm } = await reviewed([section(1, '2026-10-19', written)], rowsFor(written));
    expect(vm.findings().map((f) => f.text)).toEqual(['the bug', 'first medium', 'second medium', 'a nit']);
  });

  it('a review with no findings shows reviewed, nothing found (R14.3)', async () => {
    const { vm } = await reviewed([section(1, '2026-10-19', [])], rowsFor([]));
    expect(vm.findings()).toEqual([]);
    expect(vm.view().findingsArea.review).not.toBeNull();
    expect(vm.view().findingsArea.review!.emptyText).toBe('Reviewed, nothing found.');
    expect(vm.view().review.nothingFound).toBe(true);
    expect(vm.view().review.rows).toMatchObject({ total: 0, groups: [] });
  });

  it('a second review is shown with the first one available (R15.1)', async () => {
    const first = [{ id: 'F1', severity: 'high' as const, text: 'one' }];
    const second = [{ id: 'F1', severity: 'low' as const, text: 'two' }];
    const { vm } = await reviewed([section(1, '2026-10-18', first), section(2, '2026-10-19', second)], rowsFor(second));
    expect(vm.findings().map((f) => f.text)).toEqual(['two']);
    expect(vm.view().findingsArea.review!.replaced.map((r) => r.groups.flatMap((g) => g.findings.map((f) => f.text)))).toEqual([['one']]);
    expect(vm.latestReview()).toEqual({ number: 2, findings: vm.findings(), stale: false });
  });

  it('a review whose findings failed their schema shows its problems above the findings (F6)', async () => {
    const s = setup();
    vi.spyOn(s.transport, 'sdlcReviewView').mockResolvedValue({ rows: rowsFor([]), groups: [] });
    const page = await opened(s, { stage: 'build-finished', review: { ...document(section(1, '2026-10-19', [])), problems: [{ file: 'review.md', line: 12, message: 'finding F2 has no severity' }] } });
    await page.load();
    await advance(300);
    expect(page.vm.reviewNotice()?.lines.join(' ')).toContain('finding F2 has no severity');
  });

  it('R4.1: the Review group lists the findings of the finished review as the backend gives them, with its counts and its low split', async () => {
    const found = [
      { id: 'F1', severity: 'high' as const, text: 'The upload limit is duplicated.' },
      { id: 'F2', severity: 'low' as const, text: 'A comment is stale.' },
    ];
    const { vm } = await reviewed([section(1, '2026-10-19', found)], rowsFor(found));
    const rows = vm.view().review.rows!;
    expect(rows.total).toBe(2);
    expect(rows.counts).toEqual([
      { severity: 'high', n: 1 },
      { severity: 'low', n: 1 },
    ]);
    expect(rows.groups[0].rows.map((r) => r.key)).toEqual(['F1']);
    expect(rows.groups[0].low.map((r) => r.key)).toEqual(['F2']);
    expect(rows.groups[0].rows[0].finding).toMatchObject({ id: 'F1', severity: 'high', repo: 'commerce-core' });
    expect(vm.view().review.stale).toBeNull();
    expect(vm.view().review.nothingFound).toBe(false);
  });

  it('R4.7: a review that predates the latest commits keeps its rows and sets the stale notice', async () => {
    const s = setup();
    const found = [{ id: 'F1', severity: 'high' as const, text: 'one' }];
    vi.spyOn(s.transport, 'sdlcReviewView').mockResolvedValue({ rows: rowsFor(found), groups: [] });
    const page = await opened(s, { stage: 'build-finished', review: { ...document(section(1, '2026-10-19', found)), master_moved: ['src/a.ts'] } });
    await page.load();
    await advance(300);
    const review = page.vm.view().review;
    expect(review.rows?.total).toBe(1);
    expect(review.stale).toBe('The work changed since it was reviewed.');
    expect(page.vm.latestReview()).toMatchObject({ number: 1, stale: true });
  });

  it('the same findings, in the same order and with the same counts, after leaving the page and coming back (R18.1)', async () => {
    const found = [
      { id: 'F1', severity: 'low' as const, text: 'a nit' },
      { id: 'F2', severity: 'high' as const, text: 'the bug' },
    ];
    const first = await reviewed([section(1, '2026-10-19', found)], rowsFor(found));
    const before = first.vm.view().review.rows;
    TestBed.resetTestingModule();
    const again = await reviewed([section(1, '2026-10-19', found)], rowsFor(found));
    expect(again.vm.view().review.rows).toEqual(before);
  });

  it('latestReview is null before any review has findings or words to read', () => {
    const { vm } = setup();
    expect(vm.latestReview()).toBeNull();
    expect(vm.view().review.rows).toBeNull();
  });

  it('toggleLow opens and closes the low findings of a repository', () => {
    const { vm } = setup();
    vm.toggleLow('catalog-api');
    expect(vm.view().review.openLow.has('catalog-api')).toBe(true);
    vm.toggleLow('catalog-api');
    expect(vm.view().review.openLow.has('catalog-api')).toBe(false);
  });
});


describe('the layout follows the real build page through a finish, whatever order the backend announces it in (R10.1, R10.2, R10.5, R16.1)', () => {
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };

  /** The real build page and layout over a mock transport whose announcements the test pushes; `stages` records every value the layout stage takes, `said` everything the page announced. */
  function layoutSetup() {
    const transport = new MockTransport();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: KataTransport, useValue: transport }] });
    const fixture = TestBed.createComponent(LayoutHost);
    hosts.push(fixture as unknown as ComponentFixture<Host>);
    const vm = fixture.debugElement.injector.get(BuildPageViewModel);
    const layout = fixture.debugElement.injector.get(BuildLayoutViewModel);
    const stages: (string | null)[] = [];
    TestBed.runInInjectionContext(() =>
      effect(() => {
        stages.push(vm.layoutStage());
      }),
    );
    const said: string[] = [];
    const say = vm.say.bind(vm);
    vi.spyOn(vm, 'say').mockImplementation((text: string) => {
      said.push(text);
      say(text);
    });
    let push: (e: BuildEvent) => void = () => undefined;
    vi.spyOn(transport, 'onBuildState').mockImplementation(async (cb) => {
      push = cb;
      return () => undefined;
    });
    const announce = (s: BuildState) => push({ change: keyOf(MOCK_BUILD_CHANGE), state: s, reviewWaiting: [], runs: [] });
    return { fixture, transport, vm, layout, stages, said, announce };
  }

  /** The review document the plugin left, covering the work as it stands in the mock. */
  const REVIEWED: ReviewRecord = {
    layout: 2,
    problems: [],
    master_moved: [],
    reviews: [{ number: 1, reviewed_at: '2026-10-19', commits: { 'commerce-docs': '1111111', 'commerce-core': '2222222', 'customer-portal': '3333333' }, findings: [] }],
  };

  const commitFirstTask = (transport: MockTransport) =>
    (transport as unknown as { sdlc: { commitRows(t: { id: string; name: string; repo: string; dependsOn: string[] }[]): void } }).sdlc.commitRows([
      { id: 'T1', name: '', repo: 'commerce-core', dependsOn: [] },
    ]);

  const loadLayout = async (transport: MockTransport, vm: BuildPageViewModel) => {
    const status = await transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
    const [found] = (await readAllChanges(transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
    await vm.load({ ctx: CTX, master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` }, change: found, status, done: false, review: null });
  };

  it('R10.1: a review that ends before its result is read never passes through stopped, and Changes stays on show with Review marked', async () => {
    const { vm, transport, layout, stages, announce } = layoutSetup();
    await loadLayout(transport, vm);
    commitFirstTask(transport);
    announce(state({ going: ['commerce-core', 'customer-portal'] }));
    await advance(300);
    expect(vm.layoutStage()).toBe('running');
    layout.pickMode('changes');
    announce(state({ phase: 'reviewing', going: ['review'] }));
    await advance(300);
    // The review's document is read late: the build finishes before its result is known.
    const gate = deferred();
    vi.spyOn(transport, 'sdlcReviewRecord').mockImplementation(async () => {
      await gate.promise;
      return REVIEWED;
    });
    announce(state({ phase: 'finished', going: [] }));
    await advance(300);
    // While the result is read the layout keeps the stage it had; it never passes through stopped.
    expect(stages).not.toContain('stopped');
    expect(vm.layoutStage()).toBe('running');
    gate.release();
    await advance(300);
    expect(stages).not.toContain('stopped');
    expect(vm.layoutStage()).toBe('finished');
    expect(layout.mode()).toBe('changes');
    expect(layout.suggested()).toBe('review');
  });

  it('R10.2: with the activity in focus in Watch, a finished review ends the focus and moves the page to Review', async () => {
    const { vm, transport, layout, stages, announce } = layoutSetup();
    await loadLayout(transport, vm);
    commitFirstTask(transport);
    announce(state({ going: ['commerce-core', 'customer-portal'] }));
    await advance(300);
    expect(layout.mode()).toBe('watch');
    layout.focusOn('activity');
    announce(state({ phase: 'reviewing', going: ['review'] }));
    await advance(300);
    const gate = deferred();
    vi.spyOn(transport, 'sdlcReviewRecord').mockImplementation(async () => {
      await gate.promise;
      return REVIEWED;
    });
    announce(state({ phase: 'finished', going: [] }));
    await advance(300);
    expect(stages).not.toContain('stopped');
    gate.release();
    await advance(300);
    expect(stages).not.toContain('stopped');
    expect(layout.focus()).toBeNull();
    expect(layout.mode()).toBe('review');
  });

  it('R10.5, R16.1: a finished change whose review exists only as a run opens in Review, without a move or an announcement, however late its sessions are read', async () => {
    const { vm, transport, layout, stages, said } = layoutSetup();
    const heads = await transport.sdlcBuildHeads({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE }, [MOCK_MASTER, 'commerce-core', 'customer-portal']);
    const review: RunLink = { workspace_id: 'acme-commerce', system: 'commerce', change: MOCK_BUILD_CHANGE, stage: 'review', run_id: 'review-1', started_at: 1, heads };
    const gate = deferred();
    vi.spyOn(transport, 'sdlcRunLinks').mockImplementation(async () => {
      await gate.promise;
      return [review];
    });
    vi.spyOn(transport, 'sdlcTaskLinks').mockResolvedValue([]);
    vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: 'review-1', kata: 'review', started_at: 0, isolation: 'none', steered: false, exit: 0, turns: 1, cost_usd: 0 }]);
    const status = await transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
    const [found] = (await readAllChanges(transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
    const loading = vm.load({
      ctx: CTX,
      master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` },
      change: atStage(found, 'build-finished'),
      status,
      done: false,
      review: null,
    });
    await advance(100);
    // The sessions are still being read: the page has not settled on a stage, so it has not opened and has announced nothing.
    expect(vm.layoutStage()).toBeNull();
    expect(said.filter((t) => t.startsWith('Layout:'))).toEqual([]);
    gate.release();
    await loading;
    await advance(300);
    expect(vm.layoutStage()).toBe('finished');
    expect(stages).not.toContain('stopped');
    expect(layout.mode()).toBe('review');
    expect(layout.suggested()).toBeNull();
    expect(said.filter((t) => t.startsWith('Layout:'))).toEqual([]);
  });
});

describe('the tasks area folds, filters and shows a departure with its task', () => {
  const row = (task: string, repo: string, departure: string | null = null) => ({ task, repo, commits: ['abc1234'], departure });
  const taskOf = (id: string, repo: string, finished: boolean, departure: string | null = null, dependsOn: string[] = []) => ({
    id, name: `Task ${id}`, repo, dependsOn, text: `### ${id}`, row: finished ? row(id, repo, departure) : null,
  });
  const CORE = 'commerce-core';
  const PORTAL = 'customer-portal';

  /** commerce-core: T1 to T5 finished (T1 to T3 departed), T6 to T8 open; customer-portal: T9 waits on T6. */
  const buildStatus = (departed = true): BuildStatus => ({
    hasTasks: true,
    problems: [],
    logLayouts: [],
    departures: [],
    tasks: [
      ...[1, 2, 3, 4, 5].map((n) => taskOf(`T${n}`, CORE, true, departed && n <= 3 ? `departure ${n}` : null)),
      taskOf('T6', CORE, false),
      taskOf('T7', CORE, false, null, ['T6']),
      taskOf('T8', CORE, false, null, ['T7']),
      taskOf('T9', PORTAL, false, null, ['T6']),
    ],
    repos: [
      { repo: CORE, firstUnfinished: 'T6', state: { kind: 'ready', task: 'T6' }, tasks: 8, finished: 5 },
      { repo: PORTAL, firstUnfinished: 'T9', state: { kind: 'waiting', task: 'T9', onTask: 'T6', onRepo: CORE }, tasks: 1, finished: 0 },
    ],
  });

  async function openedOn(status: BuildStatus) {
    const s = setup();
    vi.spyOn(s.transport, 'sdlcRunLinks').mockResolvedValue([]);
    vi.spyOn(s.transport, 'sdlcTaskLinks').mockResolvedValue([]);
    vi.spyOn(s.transport, 'listRuns').mockResolvedValue([]);
    vi.spyOn(s.transport, 'sdlcBuildStatus').mockResolvedValue(status);
    const [found] = (await readAllChanges(s.transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
    await s.vm.load({ ctx: CTX, master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` }, change: found, status, done: false, review: null });
    await advance(300);
    return s;
  }

  it('R1.1: a repository with 5 of 8 finished shows its progress, one fold line for the finished and its open tasks on their own lines', async () => {
    const { vm } = await openedOn(buildStatus());
    const g = group(vm, CORE);
    expect(g.progress).toEqual({ done: 5, total: 8 });
    expect(g.list.fold).toEqual({ range: 'T1–T5', done: 5, departed: 3, open: false });
    expect(g.list.rows.map((r) => r.line.id)).toEqual(['T6', 'T7', 'T8']);
  });

  it('R1.4: a task waiting on another repository is a row, never inside the fold', async () => {
    const { vm } = await openedOn(buildStatus());
    const g = group(vm, PORTAL);
    expect(g.list.fold).toBeNull();
    expect(g.list.rows.map((r) => [r.line.id, r.line.status.label])).toEqual([['T9', `Waiting for T6 in ${CORE}`]]);
  });

  it('R1.2: opening a fold lists the finished tasks, and closing it folds them again', async () => {
    const { vm } = await openedOn(buildStatus());
    vm.toggleFold(CORE);
    expect(group(vm, CORE).list.fold?.open).toBe(true);
    expect(group(vm, CORE).list.rows.map((r) => r.line.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
    vm.toggleFold(CORE);
    expect(group(vm, CORE).list.fold?.open).toBe(false);
  });

  it('R1.2: picking a finished task opens its fold', async () => {
    const { vm } = await openedOn(buildStatus());
    vm.choose({ kind: 'task', task: 'T2' });
    expect(group(vm, CORE).list.fold?.open).toBe(true);
  });

  it('R2.1: the filter starts at All and each choice holds its own count across the build', async () => {
    const { vm } = await openedOn(buildStatus());
    expect(vm.view().filter).toEqual({ value: 'all', counts: { all: 9, open: 4, departed: 3, done: 5 } });
    vm.setTaskFilter('departed');
    expect(vm.view().filter.value).toBe('departed');
    expect(group(vm, CORE).list.rows.map((r) => [r.line.id, r.showDeparture])).toEqual([['T1', true], ['T2', true], ['T3', true]]);
    vm.setTaskFilter('open');
    expect(group(vm, CORE).list.fold).toBeNull();
    expect(group(vm, CORE).list.rows.map((r) => r.line.id)).toEqual(['T6', 'T7', 'T8']);
  });

  it('R2.2: the Departed filter on a build with no departures says so', async () => {
    const { vm } = await openedOn(buildStatus(false));
    expect(vm.view().noDepartures).toBe(false);
    vm.setTaskFilter('departed');
    expect(vm.view().noDepartures).toBe(true);
  });

  it('R3.1: the picked task\'s departure is on the view, and only for a finished task that has one', async () => {
    const { vm } = await openedOn(buildStatus());
    expect(vm.view().pickedDeparture).toBeNull();
    vm.choose({ kind: 'task', task: 'T2' });
    expect(vm.view().pickedDeparture).toEqual({ task: 'T2', text: 'departure 2' });
    vm.choose({ kind: 'task', task: 'T4' });
    expect(vm.view().pickedDeparture).toBeNull();
    vm.choose({ kind: 'repo', repo: CORE });
    expect(vm.view().pickedDeparture).toBeNull();
  });

  it('R3.2: a departure from a build log in the older table layout is on the view when its task is picked', async () => {
    const status = { ...buildStatus(), logLayouts: [{ repo: CORE, layout: 1 }] };
    const { vm } = await openedOn(status);
    vm.choose({ kind: 'task', task: 'T3' });
    expect(vm.view().pickedDeparture).toEqual({ task: 'T3', text: 'departure 3' });
  });
});


describe('the build page reads the backend\'s build and starts it through the host\'s commands', () => {
  const REF = { workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };
  const keyOf = (change: string): ChangeKey => ({ workspace: { key: FOLDER.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(), name: 'ws' }, system: 'commerce', change });
  const state = (over: Partial<BuildState> = {}): BuildState => ({ phase: 'building', going: ['commerce-core'], stopped: {}, rounds: {}, waiting: [], report: null, ...over });
  const heldBy = (change: string) => [{ repo: 'commerce-core', holder: keyOf(change) }];

  /** A page opened on the mock build change, with nothing hosted by the backend yet. */
  async function opened() {
    const s = setup();
    const status = await s.transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
    const [found] = (await readAllChanges(s.transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
    const input = { ctx: CTX, master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` }, change: found, status, done: false, review: null };
    const load = () => s.vm.load(input);
    return { ...s, load, status, input };
  }

  it('the page shows the state the backend sends', async () => {
    const { vm, transport, load } = await opened();
    let push: (e: BuildEvent) => void = () => undefined;
    vi.spyOn(transport, 'onBuildState').mockImplementation(async (cb) => {
      push = cb;
      return () => undefined;
    });
    vi.spyOn(transport, 'sdlcBuildState').mockResolvedValue(state());
    await load();
    await advance(50);
    expect(vm.phase()).toBe('building');
    expect(vm.view().actions).toEqual(['cancel-build']);
    expect(group(vm, 'commerce-core')).toMatchObject({ status: { tone: 'success' }, action: 'cancel' });

    const stopped = state({
      phase: 'stopped',
      going: [],
      stopped: { 'commerce-core': { task: 'T1', reason: 'Stopped: the agent failed', held: false } },
      report: { unfinished: [{ repo: 'commerce-core', tasks: ['T1'] }], waiting: [] },
    });
    push({ change: keyOf(MOCK_BUILD_CHANGE), state: stopped, reviewWaiting: [], runs: [] });
    await advance(50);
    expect(vm.phase()).toBe('stopped');
    expect(group(vm, 'commerce-core')).toMatchObject({ status: { tone: 'error', label: 'Stopped at T1' }, action: 'continue', stopLine: 'stopped: the agent failed' });
    expect(vm.stageMessage()?.lines).toContain('commerce-core has unfinished tasks: T1');

    // Another change's announcement is not this page's.
    push({ change: keyOf('2026-11-02-other'), state: state({ phase: 'finished', going: [] }), reviewWaiting: [], runs: [] });
    await advance(50);
    expect(vm.phase()).toBe('stopped');
  });

  it('a held start shows the panel with the holder and Start build again', async () => {
    const { vm, transport, load } = await opened();
    await load();
    const form: StartForm = { timeoutSecs: 5400 };
    const start = vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'held', held: heldBy('2026-11-02-other') });
    expect(await vm.startBuild(form)).toBe('held');
    expect(vm.view().held).toMatchObject({
      repos: [{ repo: 'commerce-core', holder: '2026-11-02-other', link: ['/sdlc', 'commerce', '2026-11-02-other'] }],
      action: 'Start build again',
    });
    expect(vm.view().findingsArea.waiting).toBeNull();
    // Starting again is a fresh start of the same form; the panel goes once the build starts.
    start.mockResolvedValue({ kind: 'started', uncommitted: {} });
    await vm.startAgain();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(REF, form);
    expect(vm.view().held).toBeNull();
  });

  it('a waiting review shows the panel in the review area', async () => {
    const { vm, transport, load } = await opened();
    vi.spyOn(transport, 'sdlcReviewWaiting').mockResolvedValue(heldBy('2026-11-02-other'));
    await load();
    await advance(50);
    expect(vm.view().findingsArea.waiting).toMatchObject({
      repos: [{ repo: 'commerce-core', holder: '2026-11-02-other', link: ['/sdlc', 'commerce', '2026-11-02-other'] }],
      action: 'Start review again',
    });
    expect(vm.view().held).toBeNull();
    const review = vi.spyOn(transport, 'sdlcReviewStart').mockResolvedValue({ kind: 'started', uncommitted: {} });
    await vm.startReviewAgain();
    expect(review).toHaveBeenCalledWith(REF, []);
  });

  it('a refused start lists the plugin\'s problems for every repository', async () => {
    const { vm, transport, load } = await opened();
    await load();
    const problems = ['commerce-core: the plan is not accepted', 'customer-portal: uncommitted files: src/a.ts'];
    vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'refused', problems });
    expect(await vm.startBuild({ timeoutSecs: 60 })).toBe('refused');
    expect(vm.refusal()).toMatchObject({ problems });
    expect(vm.view().held).toBeNull();
  });

  it("a team hook that failed on starting shows the hook and its output, not a machine fault (F10)", async () => {
    const { vm, transport, load } = await opened();
    await load();
    vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({
      kind: 'failed',
      problems: ['hook deps failed with exit code 1'],
      hook: { id: 'deps', onFailure: 'stop', output: 'npm ci: lockfile out of date\n' },
    });
    expect(await vm.startBuild({ timeoutSecs: 60 })).toBe('failed');
    expect(vm.refusal()).toEqual({ reason: "The team's hook deps failed", problems: ['hook deps failed with exit code 1', 'npm ci: lockfile out of date'] });
  });

  it("a step the machine could not run names the repository the plugin names (F3)", async () => {
    const { vm, transport, load } = await opened();
    await load();
    vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'couldNotRun', output: 'hook prep could not run', repo: 'commerce-core' });
    expect(await vm.startBuild({ timeoutSecs: 60 })).toBe('couldNotRun');
    expect(vm.refusal()).toEqual({ reason: "This machine could not run the plugin's step in commerce-core", problems: ['hook prep could not run'] });
  });

  it('the round dialog shows the backend\'s plan for the picks', async () => {
    const { vm, transport, preview, load } = await opened();
    await load();
    const finding = (key: string, repo: string | null) => ({ key, repo, finding: { severity: 'high' as const, text: `Finding ${key}.`, ...(repo === null ? {} : { repo }) } });
    const offer: RoundOffer = { review: 1, repos: ['commerce-core', 'customer-portal'], findings: [finding('F1', 'commerce-core'), finding('F2', null)] };
    const picks: RoundPicks = { picked: ['F1'], assigned: {}, notes: {} };
    const groups = [{ repo: 'commerce-core', findings: [offer.findings[0]] }, { repo: null, findings: [offer.findings[1]] }];
    vi.spyOn(transport, 'sdlcRoundOffer').mockResolvedValue([offer, picks]);
    vi.spyOn(transport, 'sdlcReviewView').mockResolvedValue({ rows: { counts: [], total: 2, groups: [] }, groups });
    const plan: RoundPlan = { blocked: null, requests: [{ repo: 'commerce-core', instructions: 'Fix F1.', summary: 'commerce-core · F1' }] };
    const planned = vi.spyOn(transport, 'sdlcRoundPlan').mockResolvedValue(plan);

    void vm.openRound();
    await advance(100);
    const sent = { ...picks, notes: { 'commerce-core': '', 'customer-portal': '' } };
    expect(planned).toHaveBeenCalledWith(REF, sent);
    expect(vm.roundGroups()).toEqual(groups);
    expect(preview.plannedRound()).toEqual(plan);

    // Picking another finding asks the backend again, and what it answers is what the dialog shows.
    const blocked: RoundPlan = { blocked: 'Choose a repository for F2.', requests: [] };
    planned.mockResolvedValue(blocked);
    preview.buildForm()!.model.update((m) => ({ ...m, picked: [...m.picked, 'F2'] }));
    await advance(100);
    expect(planned).toHaveBeenLastCalledWith(REF, { ...sent, picked: ['F1', 'F2'] });
    expect(preview.plannedRound()).toEqual(blocked);
    expect(preview.canStart()).toBe(false);
  });

  it('R13.6: the round dialog starts from the picks and notes the engineer left in it, and cancelling clears them', async () => {
    const first = await opened();
    await first.load();
    const finding = (key: string) => ({ key, repo: null, finding: { severity: 'high' as const, text: `Finding ${key}.` } });
    const offer: RoundOffer = { review: 1, repos: ['commerce-core', 'customer-portal'], findings: [finding('F1'), finding('F2')] };
    vi.spyOn(first.transport, 'sdlcRoundOffer').mockResolvedValue([offer, { picked: ['F1'], assigned: {}, notes: {} }]);
    vi.spyOn(first.transport, 'sdlcReviewView').mockResolvedValue({ rows: { counts: [], total: 2, groups: [] }, groups: [] });
    const planned = vi.spyOn(first.transport, 'sdlcRoundPlan').mockResolvedValue({ blocked: null, requests: [] });

    void first.vm.openRound();
    await advance(100);
    first.preview.buildForm()!.model.update((m) => ({ ...m, picked: ['F1', 'F2'], assigned: { F2: 'commerce-core' }, notes: { ...m.notes, 'commerce-core': 'mind the tests' } }));
    await advance(100);
    // The engineer leaves with the dialog open: the page and its dialog go.
    first.host.destroy();

    const host = openHost();
    const vm = host.debugElement.injector.get(BuildPageViewModel);
    await vm.load(first.input);
    planned.mockClear();
    void vm.openRound();
    await advance(100);
    expect(planned).toHaveBeenCalledWith(REF, { picked: ['F1', 'F2'], assigned: { F2: 'commerce-core' }, notes: { 'commerce-core': 'mind the tests', 'customer-portal': '' } });

    vm.cancelPreview();
    await advance(100);
    expect(TestBed.inject(ChangeDraftStore).round(REF)).toBeNull();
  });
});

describe('moving the page from one change to another (F1)', () => {
  const SECOND_CHANGE = '2026-10-12-product-photo-upload';
  it('nothing of change A shows on change B, and A\'s transcript arriving after the move is linked to A', async () => {
    const s = setup();
    let push: (e: BuildEvent) => void = () => undefined;
    vi.spyOn(s.transport, 'onBuildState').mockImplementation(async (cb) => {
      push = cb;
      return () => undefined;
    });
    vi.spyOn(s.transport, 'sdlcBuildState').mockResolvedValue(null);
    vi.spyOn(s.transport, 'sdlcBuildRuns').mockResolvedValue([]);
    vi.spyOn(s.runs, 'open').mockResolvedValue();
    // Change A's run waits on a question; the run store is the one place its events come from.
    const aRun = signal<RunSnapshot>({ ...IDLE, state: 'awaiting', asks: [{ id: 'q1', questions: [], answers: null, at: 0 }] });
    const real = s.runs.snapshot.bind(s.runs);
    vi.spyOn(s.runs, 'snapshot').mockImplementation((id) => (id === 'a-run' ? aRun : real(id)));
    const linkRun = vi.spyOn(s.transport, 'sdlcLinkRun').mockResolvedValue();
    const inputOf = async (name: string) => ({
      ctx: { ...CTX, change: name },
      master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` },
      change: await s.transport.sdlcChangeState(FOLDER, 'commerce', name),
      status: await s.transport.sdlcBuildStatus({ workspace: FOLDER, system: 'commerce', change: name }),
      done: false,
      review: null,
    });

    await s.vm.load(await inputOf(MOCK_BUILD_CHANGE));
    push({ change: keyOf(MOCK_BUILD_CHANGE), state: state(), reviewWaiting: [], runs: [{ key: 'commerce-core', run: 'a-run' }] });
    vi.spyOn(s.transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'held', held: [{ repo: 'customer-portal', holder: keyOf('2026-11-02-other') }] });
    await s.vm.startBuild({ timeoutSecs: 60 });
    s.vm.select('commerce-core');
    await advance(100);
    // On A: its waiting question, its session and its held start show.
    expect(s.vm.waitingNotices().map((w) => w.repo)).toEqual(['commerce-core']);
    expect(s.vm.view().sessions.map((x) => x.id)).toContain('a-run');
    expect(s.vm.view().held).not.toBeNull();

    await s.vm.load(await inputOf(SECOND_CHANGE));
    s.vm.select('commerce-core');
    await advance(100);
    // On B: none of A.
    expect(s.vm.waitingNotices()).toEqual([]);
    expect(s.vm.groups()).toEqual([]);
    expect(s.vm.view().sessions.map((x) => x.id)).not.toContain('a-run');
    expect(s.vm.view().held).toBeNull();
    expect(s.vm.phase()).toBe('none');

    // A's transcript shows only now: it is linked to A, never to the change on show.
    aRun.update((snap) => ({ ...snap, events: [{ type: 'log', level: 'info', message: 'transcript: C:/runs/a-transcript.jsonl' }] }));
    await advance(100);
    expect(linkRun).toHaveBeenCalledWith(expect.objectContaining({ change: MOCK_BUILD_CHANGE, run_id: 'a-transcript', stage: 'build:commerce-core' }));
    expect(linkRun.mock.calls.filter(([l]) => l.change === SECOND_CHANGE)).toEqual([]);
  });
});

describe('the build page reads a change through its reference (R1.1, R2.2)', () => {
  const COPY_REF = { workspace: FOLDER, system: 'commerce', change: MOCK_DONE_CHANGE };

  it('build_page_reads_a_copy_change_from_its_copy', async () => {
    const s = setup();
    const status = await s.transport.sdlcBuildStatus(COPY_REF);
    const [found] = (await readAllChanges(s.transport, FOLDER)).filter((c) => c.state.change === MOCK_DONE_CHANGE);
    const repos = vi.spyOn(s.transport, 'sdlcChangeRepos');
    const heads = vi.spyOn(s.transport, 'sdlcBuildHeads');
    const read = vi.spyOn(s.transport, 'sdlcDiffFiles');
    await s.vm.load({ ctx: { ...CTX, change: MOCK_DONE_CHANGE }, masterRepo: MOCK_MASTER, change: found, status, done: true, review: null });
    await advance(100);
    // The tasks are the copy's: the finished change has every task logged.
    expect(status.tasks.length).toBeGreaterThan(0);
    expect(status.tasks.every((t) => t.row !== null)).toBe(true);
    expect(repos).toHaveBeenCalledWith(COPY_REF);
    expect(heads.mock.calls.every(([ref]) => ref.change === MOCK_DONE_CHANGE && ref.workspace === FOLDER)).toBe(true);
    expect(heads.mock.calls[0][1]).toContain(MOCK_MASTER);
    // The files are counted in the folders the backend named; the master repository's is the copy itself.
    const copy = `${FOLDER}/.ai-sdlc/copies/${MOCK_DONE_CHANGE}`;
    expect(read.mock.calls.map(([path]) => path)).toContain(copy);
    expect(s.vm.view().counts.files).toBeGreaterThan(0);
  });
});
