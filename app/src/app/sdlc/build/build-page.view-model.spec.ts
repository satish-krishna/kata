import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { Leftovers } from '@bindings/Leftovers';
import type { Participant } from '@bindings/Participant';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import { toastState } from '@spartan-ng/brain/sonner';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { givenKey, type KindGroup, type PresetRow } from '../../lib/given';
import { safetyRules, specFor, type BuildRun } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildPageViewModel, type BuildContext } from './build-page.view-model';

const FOLDER = MOCK_WORKSPACE_FOLDER;
const CTX: BuildContext = { workspaceId: 'acme-claims', folder: FOLDER, system: 'claims', change: MOCK_BUILD_CHANGE, systemRepos: [] };
const REVIEW_NAME = `sdlc-claims-${MOCK_BUILD_CHANGE}-review`;

/** Stands in for the change page, which provides the build page's view model and the preview beside its own. */
@Component({ template: '', providers: [BuildPageViewModel, RunPreviewViewModel] })
class Host {}

/** The hosts made in this test, so a time step can run the change detection that carries their view effects. */
let hosts: ComponentFixture<Host>[] = [];

/** Another host, as the change page would be if it were opened a second time. */
function openHost() {
  const fixture = TestBed.createComponent(Host);
  hosts.push(fixture);
  return fixture;
}

/** `confirm` (the default) lets the build preview confirm at once with the build's own choices, so a test about something else never meets it; `real` leaves it to the test. */
function setup(transport = new MockTransport(), preview: 'confirm' | 'real' = 'confirm') {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: KataTransport, useValue: transport }],
  });
  const host = openHost();
  const previewVm = host.debugElement.injector.get(RunPreviewViewModel);
  if (preview === 'confirm') vi.spyOn(previewVm, 'openBuild').mockImplementation(async (req) => ({ off: new Set(req.from.build ?? []), request: null }));
  return {
    host,
    preview: previewVm,
    givens: TestBed.inject(GivenStore),
    vm: host.debugElement.injector.get(BuildPageViewModel),
    transport,
    lock: TestBed.inject(LockStore),
    runner: TestBed.inject(SdlcRunner),
  };
}

async function handoffFor(transport: MockTransport, over: Partial<BuildHandoff> = {}): Promise<BuildHandoff> {
  const out = await transport.sdlcBuildPrepare(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, false, null, 'start');
  if (out.kind !== 'ready') throw new Error('the mock build did not prepare');
  return { start: out.start, timeoutSecs: 5400, round: null, checksDir: await transport.sdlcChecksDir(), ...over };
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
async function drive(vm: BuildPageViewModel, lock: LockStore, done: () => boolean, limitMs = 60000) {
  for (let t = 0; t < limitMs && !done(); t += 100) {
    await advance(100);
    for (const w of lock.waiting()) if (w.kind === 'answer') vm.answer(w.runId, { id: 'q1', answers: [['Reuse it']] });
  }
  await advance(200);
  expect(done()).toBe(true);
}

/** The build's participants as the backend answers them: the master and the two product repositories, each with what it owns. */
const part = (repo: string, over: Partial<Participant> = {}): Participant => ({ repo, path: `${FOLDER}/${repo}`, master: repo === MOCK_MASTER, files: [], rows: [], ...over });
const everyone = (over: Record<string, Partial<Participant>> = {}): Participant[] => [MOCK_MASTER, 'claims-core', 'customer-portal'].map((r) => part(r, over[r]));
const ROW = (repo: string) => `intent/claims/${MOCK_BUILD_CHANGE}/build/${repo}.md`;

const row = (vm: BuildPageViewModel, name: string) => vm.rows().find((r) => r.name === name)!;
const finished = (vm: BuildPageViewModel) => () => vm.phase() === 'finished' && vm.findings().length > 0;

beforeEach(() => {
  hosts = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  toastState.reset();
});

describe('the build page starts, stops and continues the same runs as the build view did', () => {
  it('starting a build prepares branches and starts every repository that does not wait (R2.1)', async () => {
    const { vm, transport, lock } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    expect(await vm.start(await handoffFor(transport), CTX)).toBe(true);
    await advance(100);
    expect(runSpec).toHaveBeenCalledTimes(2);
    const workdirs = runSpec.mock.calls.map(([spec]) => spec.workdir).sort();
    expect(workdirs).toEqual([`${FOLDER}/claims-core`, `${FOLDER}/customer-portal`]);
    expect(runSpec.mock.calls.every(([, group]) => group === `build:claims/${MOCK_BUILD_CHANGE}`)).toBe(true);
    expect(lock.active()).toMatchObject({ kind: 'build', title: 'Build', finished: false });
  });

  it('gives the build page its view: a group per repository with its heading, the review entry, the shown areas and the pick', async () => {
    const { vm, transport } = setup();
    expect(await vm.start(await handoffFor(transport), CTX)).toBe(true);
    await advance(2500);
    const view = vm.view();
    expect(view.stage).toBe('running');
    expect(view.facts.tasks).toBe('0/3 tasks');
    expect(view.actions).toEqual(['cancel-build']);
    expect(view.groups.map((g) => g.repo)).toEqual(['claims-core', 'customer-portal']);
    expect(view.groups[0]).toMatchObject({ status: { tone: 'success' }, action: 'cancel', picked: true });
    expect(view.groups[0].tasks[0].status).toEqual({ tone: 'success', label: 'Running' });
    expect(view.review.picked).toBe(false);
    expect(view.pick).toEqual({ kind: 'repo', repo: 'claims-core' });
    expect(view.areas).toEqual({ activity: true, files: true });
    expect(view.sessions.length).toBeGreaterThan(0);
    expect(view.findings).toBeNull();
    expect(view.narrow).toBe(false);
  });

  it('refuses to start while another task holds the lock, and starts nothing', async () => {
    const { vm, transport, lock } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    lock.beginBuild('Other');
    expect(await vm.start(await handoffFor(transport), CTX)).toBe(false);
    await advance(100);
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('each repository has its own row, status, task and observe pane (R19.3)', async () => {
    const { vm, transport } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await advance(1000);
    expect(vm.rows().map((r) => r.name)).toEqual(['claims-core', 'customer-portal', 'review']);
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'success', label: 'Working · T1' });
    expect(row(vm, 'customer-portal')).toMatchObject({ tone: 'success', label: 'Working · T2' });
    expect(row(vm, 'review')).toMatchObject({ tone: 'idle', label: 'Not started' });
    expect(vm.tasksLabel()).toBe('0/3 tasks');

    expect(vm.selected()).toBe('claims-core');
    expect(vm.shown().map((r) => r.spec.workdir)).toEqual([`${FOLDER}/claims-core`]);
    expect(vm.shown()[0].events.length).toBeGreaterThan(0);
    expect(vm.shown()[0].startedAt).toBe('09:00:00');
    expect(vm.action()).toBe('cancel');

    vm.select('customer-portal');
    expect(vm.shown().map((r) => r.spec.workdir)).toEqual([`${FOLDER}/customer-portal`]);
  });

  it('collapses the repository list and brings it back at the size the engineer dragged it to', () => {
    const { vm } = setup();
    expect(vm.reposOpen()).toBe(true);
    vm.layout.set([30, 70]);
    vm.toggleRepos();
    expect(vm.layout()).toEqual([0, 100]);
    expect(vm.reposOpen()).toBe(false);
    expect(vm.reposIcon()).toBe('lucidePanelLeftOpen');
    vm.toggleRepos();
    expect(vm.layout()).toEqual([30, 70]);
    expect(vm.reposIcon()).toBe('lucidePanelLeftClose');
  });

  it('reads the build log again when a run finishes a Bash call, since logging a task is a commit', async () => {
    const { vm, transport } = setup();
    const status = vi.spyOn(transport, 'sdlcBuildStatus');
    await vm.start(await handoffFor(transport), CTX);
    await advance(1000);
    const before = status.mock.calls.length;
    await advance(1500);
    expect(vm.action()).toBe('cancel');
    expect(status.mock.calls.length).toBeGreaterThan(before);
  });

  it('a repository row shows the waiting clock while its run waits (R4.1)', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await advance(2000);
    expect(lock.waiting()).toHaveLength(1);
    const waiting = row(vm, 'customer-portal');
    expect(waiting).toMatchObject({ tone: 'warning', label: 'Waiting for you' });
    expect(waiting.paused).toMatch(/^\d:\d{2} waiting \(not counted\)$/);
    expect(row(vm, 'claims-core').paused).toBeNull();

    const clockBefore = row(vm, 'customer-portal').clock;
    await advance(3000);
    expect(row(vm, 'customer-portal').clock).toBe(clockBefore);
    expect(row(vm, 'customer-portal').paused).not.toBe(waiting.paused);

    vm.answer(lock.waiting()[0].runId, { id: 'q1', answers: [['Reuse it']] });
    await advance(100);
    expect(row(vm, 'customer-portal')).toMatchObject({ tone: 'success', paused: null });
  });

  it('an agent is denied edits in every product repository of the system, even one the plan does not name (R18.5)', async () => {
    const { vm, transport } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    const ctx = { ...CTX, systemRepos: ['claims-core', 'customer-portal', 'billing-api'] };
    await vm.start(await handoffFor(transport), ctx);
    await advance(100);
    const core = runSpec.mock.calls.map(([spec]) => spec).find((s) => s.workdir === `${FOLDER}/claims-core`)!;
    const denied = (core.permissions?.deny ?? []).join('\n');
    expect(denied).toContain('/billing-api/**');
    expect(denied).toContain('/customer-portal/**');
    expect(denied).not.toContain('/claims-core/**');
  });

  it('a repository the backend does not report as checked out stops with an error and never runs in a guessed folder (R2.4)', async () => {
    const { vm, transport, runner } = setup();
    vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone().filter((p) => p.repo !== 'claims-core'));
    const runInRepo = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 0, error: null };
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    expect(runInRepo.mock.calls.some(([t]) => t.repo === 'claims-core')).toBe(false);
    expect(row(vm, 'claims-core').tone).toBe('error');
    expect(row(vm, 'claims-core').label).toContain('claims-core');
  });

  it('a repository the backend does not name is stopped with the R2.4 message alone, not as an agent failure (R2.4)', async () => {
    const { vm, transport, runner } = setup();
    vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone().filter((p) => p.repo !== 'claims-core'));
    vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 0, error: null };
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'error', label: 'Stopped: claims-core is not checked out in this workspace' });
    expect(row(vm, 'claims-core').label).not.toContain('the agent failed');
  });

  it('names the work clock against the time limit', async () => {
    const { vm, transport } = setup();
    await vm.start(await handoffFor(transport, { timeoutSecs: 5400 }), CTX);
    await advance(3000);
    expect(row(vm, 'claims-core').clock).toMatch(/^work 0:00:0\d of 1:30:00$/);
  });

  it.each([
    [124, null, 'Stopped: reached the time limit'],
    [130, null, 'Stopped: cancelled'],
    [123, null, 'Stopped: nobody answered'],
    [1, 'boom', 'Stopped: the agent failed · boom'],
  ])('a stopped repository shows its reason and Continue, and keeps its commits (R6.1), exit %s', async (exit, error, message) => {
    const { vm, transport, runner } = setup();
    const discard = vi.spyOn(transport, 'sdlcDiscard');
    vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit, error };
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    expect(vm.phase()).toBe('stopped');
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'error', label: message });
    expect(row(vm, 'customer-portal')).toMatchObject({ tone: 'error', label: message });
    vm.select('claims-core');
    expect(vm.action()).toBe('continue');
    expect(discard).not.toHaveBeenCalled();
  });

  it('Continue runs the stopped repository again and reopens the build', async () => {
    const { vm, transport, runner, lock } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    expect(lock.active()).toBeNull();
    vm.select('claims-core');
    await vm.continueRun();
    await advance(500);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][4]).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
    expect(lock.active()).toMatchObject({ kind: 'build', finished: false });
    expect(row(vm, 'claims-core').label).toBe('Working · T1');
  });

  it('a repository with several runs shows the latest in full and each earlier one as a line that can be opened', async () => {
    const { vm, transport, runner } = setup();
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.select('claims-core');
    await vm.continueRun();
    await advance(500);
    const [earlier, latest] = vm.shown();
    expect(vm.shown()).toHaveLength(2);
    expect(earlier).toMatchObject({ latest: false, expanded: false });
    expect(earlier.outcome).toMatch(/^[A-Z]/);
    expect(latest).toMatchObject({ latest: true });
    vm.toggleRun(earlier.id);
    expect(vm.shown()[0].expanded).toBe(true);
    vm.toggleRun(earlier.id);
    expect(vm.shown()[0].expanded).toBe(false);
  });

  it('Continue after the branches were settled is refused with the problems when a build log fails the check, and starts nothing (R8.1)', async () => {
    const { vm, transport, runner } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 124, error: null };
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.select('claims-core');
    const problem = { file: 'build/app.md', line: 14, message: 'entry T1 is recorded twice, first on line 7' };
    prepare.mockResolvedValueOnce({ kind: 'refused', message: 'A build log does not pass the check', problems: [problem] });
    await vm.continueRun();
    await advance(500);
    expect(prepare.mock.calls[1][6]).toBe('continue');
    expect(vm.refusal()).toEqual({ reason: 'A build log does not pass the check', problems: [problem] });
    expect(run).toHaveBeenCalledTimes(2);
    vm.closeRefusal();
    expect(vm.refusal()).toBeNull();
  });

  it('Continue after the branches were settled asks before going on top of leftovers, and starts nothing until confirmed (R6.4)', async () => {
    const { vm, transport, runner } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.select('claims-core');
    prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
    await vm.continueRun();
    await advance(500);
    expect(vm.leftoverPrompt()).toEqual({ lines: ['claims-core: src/new.rs'] });
    expect(prepare.mock.calls[1][4]).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);

    await vm.confirmContinue();
    await advance(500);
    expect(vm.leftoverPrompt()).toBeNull();
    expect(prepare.mock.calls.at(-1)![4]).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('the confirmation covers only the run it was given for: another repository is not told to skip asking (R6.4)', async () => {
    const { vm, transport, runner } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    vi.spyOn(transport, 'sdlcSnapshot').mockResolvedValue({ head: 'abc', dirty: {} });
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.select('claims-core');
    prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
    await vm.continueRun();
    await vm.confirmContinue();
    await advance(100);
    const told = (repo: string) => run.mock.calls.filter(([t]) => t.repo === repo).at(-1)![1].task;
    expect(told('claims-core')).toContain('already confirmed');

    vm.select('customer-portal');
    await vm.continueRun();
    await advance(100);
    expect(run).toHaveBeenCalledTimes(4);
    expect(told('customer-portal')).not.toContain('already confirmed');
  });

  it('a first-handoff confirmation covers the named repository once, not its later runs or the review (R6.4)', async () => {
    const { vm, transport, runner, lock } = setup();
    const run = vi.spyOn(runner, 'runInRepo');
    await vm.start(await handoffFor(transport, { continueOnLeftovers: ['claims-core'] }), CTX);
    await drive(vm, lock, finished(vm));
    const told = (pick: (t: { repo?: string; kind: string }) => boolean) => run.mock.calls.filter(([t]) => pick(t)).map(([, spec]) => spec.task);
    expect(told((t) => t.repo === 'claims-core' && t.kind === 'repo')[0]).toContain('already confirmed');
    expect(told((t) => t.repo === 'customer-portal')[0]).not.toContain('already confirmed');
    expect(told((t) => t.kind === 'review')[0]).not.toContain('already confirmed');
  });

  it('declining the leftovers starts nothing (R6.4)', async () => {
    const { vm, transport, runner } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 124, error: null };
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.select('claims-core');
    prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
    await vm.continueRun();
    vm.cancelContinue();
    await advance(500);
    expect(vm.leftoverPrompt()).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Continue while other repositories still run asks about the stopped repository\'s uncommitted edits first (R6.4, R6.7)', async () => {
    const { vm, transport, runner } = setup();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone({ 'claims-core': { files: ['src/half.rs'] } }));
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (target.kind === 'repo' && target.repo === 'claims-core' && run.mock.calls.length <= 2) {
        link.onRun?.('fake-claims-core');
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    expect(vm.phase()).toBe('building');
    vm.select('claims-core');
    expect(vm.action()).toBe('continue');
    const calls = run.mock.calls.length;

    await vm.continueRun();
    await advance(100);
    expect(vm.leftoverPrompt()).toEqual({ lines: ['claims-core: src/half.rs'] });
    expect(run).toHaveBeenCalledTimes(calls);
    expect(prepare).toHaveBeenCalledTimes(1);

    await vm.confirmContinue();
    await advance(100);
    expect(vm.leftoverPrompt()).toBeNull();
    expect(run).toHaveBeenCalledTimes(calls + 1);
  });

  it('the review starts by itself and its findings are shown most serious first (R8.2)', async () => {
    const { vm, transport, lock } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));
    const names = runSpec.mock.calls.map(([spec]) => spec.name);
    expect(names.filter((n) => n === REVIEW_NAME)).toHaveLength(1);
    expect(runSpec.mock.calls.find(([spec]) => spec.name === REVIEW_NAME)![0].workdir).toBe(`${FOLDER}/${MOCK_MASTER}`);
    expect(vm.findings().map((f) => f.text)).toEqual([
      'The upload limit is duplicated in claims-core and customer-portal.',
      'The refusal message has no test.',
    ]);
    expect(row(vm, 'review')).toMatchObject({ tone: 'success', label: 'Finished' });
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'success', label: 'Finished · 1/1' });
    expect(vm.tasksLabel()).toBe('3/3 tasks');
    expect(lock.active()).toBeNull();
  });

  describe('findings from the review document', () => {
    const section = (number: number, reviewed_at: string, findings: { id: string; severity: 'high' | 'medium' | 'low'; text: string }[]) => ({
      number,
      reviewed_at,
      commits: { 'claims-core': 'aaaaaaa' },
      findings: findings.map((f) => ({ ...f, file: 'src/a.ts', line: 4 })),
    });
    /** What the format program reports about the review document; none unless a test sets it. */
    let documentProblems: { file: string; line: number; message: string }[] = [];
    beforeEach(() => {
      documentProblems = [];
    });
    /** The review document as the plugin leaves it: no review until the review run starts, then `reviews`. */
    const withDocument = (transport: MockTransport, ...reviews: ReturnType<typeof section>[]) => {
      let reviewed = false;
      const runSpec = transport.runSpec.bind(transport);
      vi.spyOn(transport, 'runSpec').mockImplementation((...args: Parameters<MockTransport['runSpec']>) => {
        if (args[0].name === REVIEW_NAME) reviewed = true;
        return runSpec(...args);
      });
      return vi.spyOn(transport, 'sdlcReviewRecord').mockImplementation(async () => ({ layout: 2, reviews: reviewed ? reviews : [], problems: reviewed ? documentProblems : [], master_moved: [] }));
    };
    const shown = (vm: BuildPageViewModel) => () => vm.phase() === 'finished' && vm.reviewShown();

    it('findings come from review.md, not the run words (R14.2)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'The limit is not enforced on retry.' }]));
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.findings().map((f) => [f.severity, f.text])).toEqual([['high', 'The limit is not enforced on retry.']]);
      expect(vm.older()).toBe(false);
    });

    it('a review with no findings shows reviewed, nothing found (R14.3)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', []));
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.findings()).toEqual([]);
      expect(vm.emptyText()).toBe('Reviewed, nothing found.');
    });

    it('a second review is shown with the first one available (R15.1)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(
        transport,
        section(1, '2026-10-18', [{ id: 'F1', severity: 'high', text: 'one' }]),
        section(2, '2026-10-19', [{ id: 'F1', severity: 'low', text: 'two' }]),
      );
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.findings().map((f) => f.text)).toEqual(['two']);
      expect(vm.replaced().map((r) => [r.label, r.findings.map((f) => f.text)])).toEqual([['Review 1 of 2026-10-18', ['one']]]);
    });

    it('a review run that leaves no review document says the review did not record its findings (F14)', async () => {
      const { vm, transport, lock } = setup();
      vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(null);
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.findings()).toEqual([]);
      expect(vm.emptyText()).toBe('The review did not record its findings');
      expect(vm.older()).toBe(false);
    });

    it('a review run that adds no section does not show the previous review as current (F14)', async () => {
      const { vm, transport, lock } = setup();
      vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue({
        layout: 2,
        reviews: [section(1, '2026-10-18', [{ id: 'F1', severity: 'high', text: 'one' }])],
        problems: [],
        master_moved: [],
      });
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.findings()).toEqual([]);
      expect(vm.emptyText()).toBe('The review did not record its findings');
    });

    it('a review whose findings failed their schema shows its problems above the findings (F6)', async () => {
      const { vm, transport, lock } = setup();
      documentProblems = [{ file: 'build/review.md', line: 12, message: 'finding F1 has no file' }];
      withDocument(transport, section(1, '2026-10-19', []));
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.reviewNotice()).toEqual({
        tone: 'warning',
        text: 'This document does not follow the layout',
        lines: ['line 12: finding F1 has no file'],
      });
    });

    /** Stands in for the check of what the review run left in the master repository. */
    const verifying = (transport: MockTransport, flagged: string[]) => {
      return vi.spyOn(transport, 'sdlcReviewVerify').mockResolvedValue(flagged);
    };

    it('a review run that also changed plugin/ names the file and is not the current review (F7)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'one' }]));
      const verify = verifying(transport, ['plugin/format/check.mjs']);
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(verify).toHaveBeenCalledWith(expect.any(String), 'claims', MOCK_BUILD_CHANGE, '0'.repeat(40), expect.anything());
      expect(vm.reviewNotice()?.tone).toBe('warning');
      expect(vm.reviewNotice()?.lines).toEqual(['plugin/format/check.mjs']);
      expect(vm.findings()).toEqual([]);
      expect(vm.emptyText()).toBe('The review did not record its findings');
    });

    /** A master whose tree holds `now` when the review run ends and `before` when it starts; the check gets the starting tree to compare with. */
    const treeCheck = (transport: MockTransport, before: Record<string, string>, now: Record<string, string>) => {
      const snapshot = transport.sdlcSnapshot.bind(transport);
      vi.spyOn(transport, 'sdlcSnapshot').mockImplementation(async (path) => ({ ...(await snapshot(path)), dirty: before }));
      return vi.spyOn(transport, 'sdlcReviewVerify').mockImplementation((...args: unknown[]) => {
        const start = (args[4] ?? {}) as Record<string, string>;
        return Promise.resolve(Object.keys(now).filter((file) => start[file] !== now[file]));
      });
    };

    it('a stray file left dirty before the review run does not hide a correctly recorded review (F18)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'one' }]));
      treeCheck(transport, { 'notes/stray.md': 'aaaa' }, { 'notes/stray.md': 'aaaa' });
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.reviewNotice()).toBeNull();
      expect(vm.findings().map((f) => f.text)).toEqual(['one']);
    });

    it('a file the review run left dirty is still flagged beside one that was dirty before (F18)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'one' }]));
      treeCheck(transport, { 'notes/stray.md': 'aaaa' }, { 'notes/stray.md': 'aaaa', 'plugin/format/check.mjs': 'bbbb' });
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(vm.reviewNotice()?.lines).toEqual(['plugin/format/check.mjs']);
      expect(vm.findings()).toEqual([]);
    });

    it('a review run that touched only the review document is the current review (F7)', async () => {
      const { vm, transport, lock } = setup();
      withDocument(transport, section(1, '2026-10-19', [{ id: 'F1', severity: 'high', text: 'one' }]));
      const verify = verifying(transport, []);
      await vm.start(await handoffFor(transport), CTX);
      await drive(vm, lock, shown(vm));
      expect(verify).toHaveBeenCalled();
      expect(vm.reviewNotice()).toBeNull();
      expect(vm.findings().map((f) => f.text)).toEqual(['one']);
    });
  });

  it('a round that adds commits is reviewed again and the old findings are marked replaced (R8.4)', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));

    const heads = vi.spyOn(transport, 'sdlcBuildHeads');
    heads.mockResolvedValueOnce({ 'claims-core': 'aaaaaaa' });
    heads.mockResolvedValue({ 'claims-core': 'bbbbbbb' });
    const runSpec = vi.spyOn(transport, 'runSpec');
    const next = openHost().debugElement.injector.get(BuildPageViewModel);
    const round = { instructions: 'rename the status field to state', repo: 'claims-core' };
    await next.start(await handoffFor(transport, { round }), CTX);
    await drive(next, lock, finished(next));
    const specs = runSpec.mock.calls.map(([spec]) => spec);
    expect(specs.filter((s) => s.name === REVIEW_NAME)).toHaveLength(1);
    expect(specs[0].task).toContain('rename the status field to state');
    expect(next.findings()).toHaveLength(2);
    expect(next.replaced()).toHaveLength(1);
    expect(next.replaced()[0].findings).toHaveLength(2);
    expect(next.replaced()[0].label).toBe('Review 1 of 2026-10-19');
  });

  it('a round that adds no commits is not reviewed again', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));

    const runSpec = vi.spyOn(transport, 'runSpec');
    const next = openHost().debugElement.injector.get(BuildPageViewModel);
    const round = { instructions: 'look at the logging', repo: 'claims-core' };
    await next.start(await handoffFor(transport, { round }), CTX);
    await drive(next, lock, () => next.phase() === 'finished');
    expect(runSpec.mock.calls.map(([spec]) => spec.name)).not.toContain(REVIEW_NAME);
    expect(next.replaced()).toEqual([]);
  });

  it('the build stops and lists what is left', async () => {
    const { vm, transport, runner, lock } = setup();
    const task = (id: string, name: string, repo: string, dependsOn: string[], done: boolean) => ({
      id, name, repo, dependsOn, text: `### ${id}`, row: done ? { task: id, repo, commits: ['abc1234'], departure: null } : null,
    });
    const status: BuildStatus = {
      hasTasks: true,
      problems: [], logLayouts: [],
      departures: [],
      tasks: [task('T1', 'one', 'claims-core', [], false), task('T2', 'two', 'customer-portal', [], true), task('T3', 'three', 'customer-portal', ['T1'], false)],
      repos: [
        { repo: 'claims-core', firstUnfinished: 'T1', state: { kind: 'ready', task: 'T1' }, tasks: 1, finished: 0 },
        { repo: 'customer-portal', firstUnfinished: 'T3', state: { kind: 'waiting', task: 'T3', onTask: 'T1', onRepo: 'claims-core' }, tasks: 2, finished: 1 },
      ],
    };
    vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(status);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 124, error: null };
    });
    const finish = vi.spyOn(runner, 'finishBuild').mockResolvedValue();
    const h = await handoffFor(transport);
    await vm.start(h, CTX);
    await advance(500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vm.phase()).toBe('stopped');
    expect(vm.report()).toEqual({
      unfinished: [
        { repo: 'claims-core', tasks: ['T1'] },
        { repo: 'customer-portal', tasks: ['T3'] },
      ],
      waiting: [{ repo: 'customer-portal', task: 'T3', onTask: 'T1', onRepo: 'claims-core' }],
    });
    expect(vm.rows().find((r) => r.name === 'customer-portal')).toMatchObject({ tone: 'idle', label: 'Waiting for T1 in claims-core' });
    expect(finish).toHaveBeenCalledWith(h.start);
    expect(lock.active()).toBeNull();
  });

  describe('a round for the master repository', () => {
    const doneTask = (id: string, repo: string) => ({
      id, name: id, repo, dependsOn: [], text: `### ${id}`, row: { task: id, repo, commits: ['abc1234'], departure: null },
    });
    const allDone: BuildStatus = {
      hasTasks: true,
      problems: [], logLayouts: [],
      departures: [],
      tasks: [doneTask('T1', 'claims-core'), doneTask('T2', 'customer-portal')],
      repos: [
        { repo: 'claims-core', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
        { repo: 'customer-portal', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
      ],
    };
    const round = { instructions: 'tidy the notes', repo: MOCK_MASTER };

    it('has a row, shows why it stopped and Continue runs it again (R6.1, R8.1)', async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(allDone);
      const targets: string[] = [];
      const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
        targets.push(target.kind === 'review' ? 'review' : target.repo);
        link.onRun?.(`fake-${targets.length}`);
        return targets.length === 1 ? { exit: 124, error: null } : { exit: 0, error: null };
      });
      await vm.start(await handoffFor(transport, { round }), CTX);
      await advance(500);
      expect(targets).toEqual([MOCK_MASTER]);
      expect(vm.phase()).toBe('stopped');
      expect(row(vm, MOCK_MASTER)).toMatchObject({ tone: 'error', label: 'Stopped: reached the time limit' });
      vm.select(MOCK_MASTER);
      expect(vm.action()).toBe('continue');
      expect(vm.shown()).toHaveLength(1);

      await vm.continueRun();
      await advance(500);
      expect(targets.slice(0, 2)).toEqual([MOCK_MASTER, MOCK_MASTER]);
      expect(run.mock.calls[1][1].task).toContain('tidy the notes');
      expect(run.mock.calls[1][0].path).toBe(`${FOLDER}/${MOCK_MASTER}`);
    });

    it('shows its row while it waits to start and after it ran', async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(allDone);
      vi.spyOn(runner, 'runInRepo').mockImplementation(async (_target, _spec, link) => {
        link.onRun?.('fake-master');
        return { exit: 0, error: null };
      });
      await vm.start(await handoffFor(transport, { round }), CTX);
      await advance(500);
      expect(row(vm, MOCK_MASTER)).toMatchObject({ tone: 'success', label: 'Finished' });
    });

    it('a round that commits there is reviewed again, from heads that include the master (R8.4)', async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(allDone);
      const heads = vi.spyOn(transport, 'sdlcBuildHeads');
      heads.mockImplementation(async (_folder, repos) => Object.fromEntries(repos.map((r) => [r, r === MOCK_MASTER && run.mock.calls.length > 0 ? 'm2' : 'm1'])));
      const targets: string[] = [];
      const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
        targets.push(target.kind === 'review' ? 'review' : target.repo);
        link.onRun?.(`fake-${targets.length}`);
        return { exit: 0, error: null };
      });
      await vm.start(await handoffFor(transport, { round }), CTX);
      await advance(500);
      expect(heads.mock.calls.every(([, repos]) => repos.includes(MOCK_MASTER))).toBe(true);
      expect(targets).toEqual([MOCK_MASTER, 'review']);
    });
  });

  it('Cancel build cancels every run and starts none', async () => {
    const { vm, transport } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    const cancel = vi.spyOn(transport, 'cancelRun');
    const discard = vi.spyOn(transport, 'sdlcDiscard');
    await vm.start(await handoffFor(transport), CTX);
    await advance(600);
    expect(vm.active()).toBe(true);
    vm.cancelBuild();
    await advance(1000);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(runSpec).toHaveBeenCalledTimes(2);
    expect(vm.phase()).toBe('cancelled');
    expect(vm.active()).toBe(false);
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'error', label: 'Stopped: cancelled' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('Cancel on one repository cancels only its run', async () => {
    const { vm, transport } = setup();
    const cancel = vi.spyOn(transport, 'cancelRun');
    await vm.start(await handoffFor(transport), CTX);
    await advance(600);
    vm.select('claims-core');
    vm.cancelRun();
    await advance(600);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'error', label: 'Stopped: cancelled' });
    expect(row(vm, 'customer-portal').tone).not.toBe('error');
  });

  it('Another round on a finished repository, then Cancel, shows Stopped and Continue runs the round again with its instructions (B1)', async () => {
    const { vm, transport, runner } = setup();
    const doneTask = (id: string, repo: string) => ({
      id, name: id, repo, dependsOn: [], text: `### ${id}`, row: { task: id, repo, commits: ['abc1234'], departure: null },
    });
    vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue({
      hasTasks: true,
      problems: [], logLayouts: [],
      departures: [],
      tasks: [doneTask('T1', 'claims-core'), doneTask('T2', 'customer-portal')],
      repos: [
        { repo: 'claims-core', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
        { repo: 'customer-portal', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
      ],
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(TestBed.inject(RunStore), 'cancelRun').mockImplementation(async () => release());
    const targets: string[] = [];
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
      targets.push(target.kind === 'review' ? 'review' : target.repo);
      link.onRun?.(`fake-${targets.length}`);
      if (targets.length > 1) return { exit: 0, error: null };
      await gate;
      return { exit: 130, error: null };
    });
    const round = { instructions: 'rename the status field', repo: 'claims-core' };
    await vm.start(await handoffFor(transport, { round }), CTX);
    await advance(300);
    vm.select('claims-core');
    vm.cancelRun();
    await advance(500);
    expect(targets).toEqual(['claims-core']);
    expect(vm.phase()).toBe('stopped');
    expect(row(vm, 'claims-core')).toMatchObject({ tone: 'error', label: 'Stopped: cancelled' });
    vm.select('claims-core');
    expect(vm.action()).toBe('continue');

    await vm.continueRun();
    await advance(500);
    expect(targets.slice(0, 2)).toEqual(['claims-core', 'claims-core']);
    expect(run.mock.calls[1][1].task).toContain('rename the status field');
  });

  describe('Continue asks about what its own repository left, wherever it was written (R6.4, R6.6)', () => {
    const doneTask = (id: string, repo: string) => ({
      id, name: id, repo, dependsOn: [], text: `### ${id}`, row: { task: id, repo, commits: ['abc1234'], departure: null },
    });
    const allDone: BuildStatus = {
      hasTasks: true,
      problems: [], logLayouts: [],
      departures: [],
      tasks: [doneTask('T1', 'claims-core'), doneTask('T2', 'customer-portal')],
      repos: [
        { repo: 'claims-core', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
        { repo: 'customer-portal', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
      ],
    };
    const coreDonePortalReady: BuildStatus = {
      hasTasks: true,
      problems: [], logLayouts: [],
      departures: [],
      tasks: [doneTask('T1', 'claims-core'), { id: 'T2', name: 'two', repo: 'customer-portal', dependsOn: [], text: '### T2', row: null }],
      repos: [
        { repo: 'claims-core', firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 },
        { repo: 'customer-portal', firstUnfinished: 'T2', state: { kind: 'ready', task: 'T2' }, tasks: 1, finished: 0 },
      ],
    };

    /** The first run of `stopper` stops at once; every other repository's run is held (never ends) when `hold` is set. */
    function stopFirstRunOf(runner: SdlcRunner, stopper: string, hold: boolean) {
      const seen: string[] = [];
      const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
        const key = target.kind === 'review' ? 'review' : target.repo;
        seen.push(key);
        link.onRun?.(`fake-${seen.length}`);
        if (key === stopper) return seen.filter((k) => k === key).length === 1 ? { exit: 124, error: null } : { exit: 0, error: null };
        if (hold) await new Promise<void>(() => undefined);
        return { exit: 0, error: null };
      });
      return run;
    }
    const told = (run: ReturnType<typeof stopFirstRunOf>, repo: string) => run.mock.calls.filter(([t]) => t.kind === 'repo' && t.repo === repo).at(-1)![1].task;

    it('a stopped master round that left edits goes through the confirmation while other runs go, like any repository (B2)', async () => {
      const { vm, transport, runner } = setup();
      const asked = vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone({ [MOCK_MASTER]: { files: ['notes/half.md'] } }));
      const run = stopFirstRunOf(runner, MOCK_MASTER, true);
      await vm.start(await handoffFor(transport, { round: { instructions: 'tidy the notes', repo: MOCK_MASTER } }), CTX);
      await advance(500);
      expect(vm.phase()).toBe('building');
      vm.select(MOCK_MASTER);
      expect(vm.action()).toBe('continue');
      const calls = run.mock.calls.length;

      await vm.continueRun();
      expect(asked).toHaveBeenLastCalledWith(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, MOCK_MASTER);
      expect(vm.leftoverPrompt()).toEqual({ lines: [`${MOCK_MASTER}: notes/half.md`] });
      expect(run).toHaveBeenCalledTimes(calls);

      await vm.confirmContinue();
      await advance(100);
      expect(run).toHaveBeenCalledTimes(calls + 1);
      expect(told(run, MOCK_MASTER)).toContain('already confirmed');
    });

    it("a stopped master round that left edits goes through the confirmation after the build ended, and the backend is told the round is the master's (B2)", async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(allDone);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      const run = stopFirstRunOf(runner, MOCK_MASTER, false);
      await vm.start(await handoffFor(transport, { round: { instructions: 'tidy the notes', repo: MOCK_MASTER } }), CTX);
      await advance(500);
      expect(vm.phase()).toBe('stopped');
      vm.select(MOCK_MASTER);
      prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: MOCK_MASTER, files: ['notes/half.md'] }] });

      await vm.continueRun();
      expect(prepare.mock.calls[1][4]).toBe(false);
      expect(prepare.mock.calls[1][5]).toBe(MOCK_MASTER);
      expect(vm.leftoverPrompt()).toEqual({ lines: [`${MOCK_MASTER}: notes/half.md`] });
      expect(run).toHaveBeenCalledTimes(1);

      await vm.confirmContinue();
      await advance(100);
      expect(prepare.mock.calls.at(-1)![4]).toBe(true);
      expect(prepare.mock.calls.at(-1)![5]).toBe(MOCK_MASTER);
      expect(told(run, MOCK_MASTER)).toContain('already confirmed');
    });

    it("an unsaved row in a repository's build log is shown as that repository's leftover and its run is told it was confirmed (B3)", async () => {
      const { vm, transport, runner } = setup();
      const asked = vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone({ 'claims-core': { rows: [ROW('claims-core')] } }));
      const run = stopFirstRunOf(runner, 'claims-core', true);
      await vm.start(await handoffFor(transport), CTX);
      await advance(500);
      vm.select('claims-core');
      expect(vm.action()).toBe('continue');
      const calls = run.mock.calls.length;

      await vm.continueRun();
      expect(asked).toHaveBeenLastCalledWith(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, 'claims-core');
      expect(vm.leftoverPrompt()).toEqual({ lines: [`claims-core: ${ROW('claims-core')}`] });
      expect(run).toHaveBeenCalledTimes(calls);

      await vm.confirmContinue();
      await advance(100);
      expect(run).toHaveBeenCalledTimes(calls + 1);
      expect(told(run, 'claims-core')).toContain('already confirmed');
    });

    it('a round on a finished repository that stopped with edits asks on Continue while other runs go (B4)', async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(coreDonePortalReady);
      const asked = vi.spyOn(transport, 'sdlcBuildParticipants').mockResolvedValue(everyone({ 'claims-core': { files: ['src/half.rs'] } }));
      const run = stopFirstRunOf(runner, 'claims-core', true);
      await vm.start(await handoffFor(transport, { round: { instructions: 'rename the status field', repo: 'claims-core' } }), CTX);
      await advance(500);
      expect(vm.phase()).toBe('building');
      vm.select('claims-core');
      expect(vm.action()).toBe('continue');
      const calls = run.mock.calls.length;

      await vm.continueRun();
      expect(asked).toHaveBeenLastCalledWith(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, 'claims-core');
      expect(vm.leftoverPrompt()).toEqual({ lines: ['claims-core: src/half.rs'] });
      expect(run).toHaveBeenCalledTimes(calls);

      await vm.confirmContinue();
      await advance(100);
      expect(run).toHaveBeenCalledTimes(calls + 1);
      expect(told(run, 'claims-core')).toContain('rename the status field');
    });

    it('a round on a finished repository that stopped with edits asks on Continue after the build ended (B4)', async () => {
      const { vm, transport, runner } = setup();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(allDone);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      const run = stopFirstRunOf(runner, 'claims-core', false);
      await vm.start(await handoffFor(transport, { round: { instructions: 'rename the status field', repo: 'claims-core' } }), CTX);
      await advance(500);
      expect(vm.phase()).toBe('stopped');
      vm.select('claims-core');
      prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/half.rs'] }] });

      await vm.continueRun();
      expect(prepare.mock.calls[1][5]).toBe('claims-core');
      expect(vm.leftoverPrompt()).toEqual({ lines: ['claims-core: src/half.rs'] });
      expect(run).toHaveBeenCalledTimes(1);

      await vm.confirmContinue();
      await advance(100);
      expect(run).toHaveBeenCalledTimes(2);
      expect(told(run, 'claims-core')).toContain('already confirmed');
    });
  });
});

describe('the build\'s choices in the build view', () => {
  const GITHUB = 'personal:tool-server:github';
  const KEY = `claims/${MOCK_BUILD_CHANGE}`;
  const dbKey = (repo: string) => givenKey(`project:tool-server:${repo}-db`, `${FOLDER}/${repo}`);
  const previewReady = (preview: RunPreviewViewModel) => vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
  const flat = (groups: KindGroup[]): PresetRow[] => groups.flatMap((k) => k.groups.flatMap((g) => g.rows.flatMap((e) => [e.row, ...e.followers])));
  const limit = (preview: RunPreviewViewModel) => preview.settings().find((s) => s.label === 'Time limit');

  /** Both repositories' first runs stop at the time limit, so Continue is offered; the third run goes the real way. */
  const stopFirstTwo = (runner: SdlcRunner) => {
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    return run;
  };

  it('project items are listed and applied per repository (R11.2)', async () => {
    const { vm, transport, runner } = setup();
    const run = stopFirstTwo(runner);
    const choices = { off: new Set([GITHUB, dbKey('claims-core')]) };
    await vm.start(await handoffFor(transport, { choices }), CTX);
    await advance(500);
    const given = (repo: string) => run.mock.calls.map(([, spec]) => spec).find((s) => s.workdir === `${FOLDER}/${repo}`)!.given!;
    // Switching claims-core's project tool server off reaches claims-core's run and not customer-portal's.
    expect(given('claims-core').tool_servers).toEqual([GITHUB, 'project:tool-server:claims-core-db']);
    expect(given('customer-portal').tool_servers).toEqual([GITHUB]);
  });

  it('a build preview lists each repository\'s project hooks locked and applies its tool servers per repository (R11.5)', async () => {
    const { vm, transport, runner, preview } = setup(new MockTransport(), 'real');
    const settings = await transport.sdlcSettings();
    const sectionOf = (repo: string) => {
      const run: BuildRun = {
        target: { repo },
        timeoutSecs: 5400,
        instructions: null,
        workspaceFolder: FOLDER,
        masterRepo: MOCK_MASTER,
        systemRepos: ['claims-core', 'customer-portal'],
        checksDir: '/checks',
        continueOnLeftovers: false,
      };
      const spec = specFor('build', null, { folder: FOLDER, system: 'claims', change: MOCK_BUILD_CHANGE }, settings, [], run);
      return { title: repo, repo, spec, workdir: spec.workdir };
    };
    const opened = preview.openBuild({
      title: 'Start build',
      kind: 'start',
      sections: [sectionOf('claims-core'), sectionOf('customer-portal')],
      from: { session: new Set(), job: null, build: null },
      limitSecs: 5400,
    });
    await previewReady(preview);
    for (const title of ['claims-core', 'customer-portal']) {
      const rows = flat(preview.sections()!.find((s) => s.title === title)!.groups);
      const hooks = rows.filter((r) => r.item.kind === 'hook');
      expect(hooks.length).toBeGreaterThan(0);
      for (const hook of hooks) expect(hook.locked).toMatchObject({ kind: 'build' });
      expect(rows.some((r) => r.item.id === `project:tool-server:${title}-db`)).toBe(true);
      expect(rows.some((r) => r.item.id === `project:tool-server:${title === 'claims-core' ? 'customer-portal' : 'claims-core'}-db`)).toBe(false);
    }

    preview.toggle(dbKey('claims-core'), true);
    preview.start();
    const result = (await opened)!;
    expect(result.off).toEqual(new Set([dbKey('claims-core')]));

    const run = stopFirstTwo(runner);
    await vm.start(await handoffFor(transport, { choices: { off: result.off } }), CTX);
    await advance(500);
    const given = (repo: string) => run.mock.calls.map(([, spec]) => spec).find((s) => s.workdir === `${FOLDER}/${repo}`)!.given!;
    expect(given('claims-core').tool_servers).toEqual(['project:tool-server:claims-core-db']);
    expect(given('customer-portal').tool_servers).toEqual([]);
    // The kind of run is kept beside the build's choices.
    expect(given('claims-core')).toMatchObject({ build: true, required_plugins: ['ai-sdlc'], hooks: [] });
  });

  it('the review section lists the master repository\'s project items (R11.3)', async () => {
    const { vm, transport, lock } = setup();
    const runSpec = vi.spyOn(transport, 'runSpec');
    const choices = { off: new Set([dbKey(MOCK_MASTER)]) };
    await vm.start(await handoffFor(transport, { choices }), CTX);
    await drive(vm, lock, finished(vm));
    const specs = runSpec.mock.calls.map(([spec]) => spec);
    // The master's project item is given to the review, which runs in the master, and to no product repository's run.
    expect(specs.find((s) => s.name === REVIEW_NAME)!.given!.tool_servers).toEqual([`project:tool-server:${MOCK_MASTER}-db`]);
    for (const s of specs.filter((x) => x.name !== REVIEW_NAME)) expect(s.given!.tool_servers).toEqual([]);
  });

  it('each repository\'s run shows its own given view (R13.2)', async () => {
    const { vm, transport } = setup();
    // The scripted engine records nothing of what a run was given, so every run reports its own project item the way the real one does.
    const folders = new Map<string, string>();
    const runSpec = transport.runSpec.bind(transport);
    vi.spyOn(transport, 'runSpec').mockImplementation(async (spec, group) => {
      const id = await runSpec(spec, group);
      folders.set(id, spec.workdir.split('/').pop()!);
      return id;
    });
    const listen = transport.onRunEvent.bind(transport);
    vi.spyOn(transport, 'onRunEvent').mockImplementation((cb) =>
      listen((runId, ev) => {
        cb(runId, ev);
        const repo = folders.get(runId);
        if (repo === undefined || ev.type === 'run.given') return;
        cb(runId, {
          type: 'run.given',
          items: [{ id: `project:tool-server:${repo}-db`, kind: 'tool-server', source: 'project', name: `${repo}-db`, detail: '', off: false, status: 'given' }],
          settings: {},
          env: [],
          warnings: [],
        } as never);
      }),
    );
    await vm.start(await handoffFor(transport), CTX);
    await advance(1500);
    const idsOf = (repo: string) => vm.groups().find((g) => g.key === repo)!.runs.flatMap((r) => r.given?.items.map((i) => i.id) ?? []);
    expect(idsOf('claims-core')).toContain('project:tool-server:claims-core-db');
    expect(idsOf('claims-core')).not.toContain('project:tool-server:customer-portal-db');
    expect(idsOf('customer-portal')).toContain('project:tool-server:customer-portal-db');
    expect(idsOf('customer-portal')).not.toContain('project:tool-server:claims-core-db');
  });

  it('continuing one stopped repository opens its preview pre-set to the build\'s choices, and what is changed there is the build\'s from then on (R12.1, R17.3, R7.1)', async () => {
    const { vm, transport, runner, preview, givens } = setup(new MockTransport(), 'real');
    const off = new Set([GITHUB, dbKey('claims-core')]);
    givens.setBuild(KEY, { off });
    const run = stopFirstTwo(runner);
    await vm.start(await handoffFor(transport, { choices: { off } }), CTX);
    await advance(500);
    vm.select('claims-core');
    const going = vm.continueRun();
    await previewReady(preview);

    // Pre-set and marked as the build's, in the shared rows and in the repository's own section.
    expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
    expect(preview.sections()!.map((s) => s.title)).toEqual(['claims-core']);
    expect(flat(preview.sections()![0].groups).find((r) => r.item.id === 'project:tool-server:claims-core-db')).toMatchObject({ off: true, mark: 'build' });
    // The limits are the build's, read-only; the safety rules are listed.
    expect(preview.buildForm()).toBeNull();
    expect(limit(preview)).toEqual({ label: 'Time limit', value: '1 h 30 min', source: "the build's" });
    expect(preview.safetyRules()).toEqual(safetyRules('repo'));
    expect(run).toHaveBeenCalledTimes(2);

    preview.toggle(GITHUB, false);
    preview.start();
    await going;
    await advance(500);
    // The change is the build's now, and the repository's next run is given it.
    expect(givens.build(KEY)!.off).toEqual(new Set([dbKey('claims-core')]));
    expect(run.mock.calls[2][1].given!.tool_servers).toEqual(['project:tool-server:claims-core-db']);
  });

  it('cancelling the continue preview starts nothing and keeps the build\'s choices', async () => {
    const { vm, transport, runner, preview, givens } = setup(new MockTransport(), 'real');
    givens.setBuild(KEY, { off: new Set([GITHUB]) });
    const run = stopFirstTwo(runner);
    await vm.start(await handoffFor(transport, { choices: { off: new Set([GITHUB]) } }), CTX);
    await advance(500);
    vm.select('claims-core');
    const going = vm.continueRun();
    await previewReady(preview);
    preview.toggle(GITHUB, false);
    preview.cancel();
    await going;
    await advance(500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(givens.build(KEY)!.off).toEqual(new Set([GITHUB]));
  });
});

const LEFT: Leftovers = { new_commits: [], discardable: ['src/x.rs'], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };

/** claims-core has an unfinished task and customer-portal waits for it, however many runs end. */
const UNFINISHED: BuildStatus = {
  hasTasks: true,
  problems: [],
  logLayouts: [],
  departures: [],
  tasks: [
    { id: 'T1', name: 'one', repo: 'claims-core', dependsOn: [], text: '### T1', row: null },
    { id: 'T2', name: 'two', repo: 'customer-portal', dependsOn: ['T1'], text: '### T2', row: null },
  ],
  repos: [
    { repo: 'claims-core', firstUnfinished: 'T1', state: { kind: 'ready', task: 'T1' }, tasks: 1, finished: 0 },
    { repo: 'customer-portal', firstUnfinished: 'T2', state: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'claims-core' }, tasks: 1, finished: 0 },
  ],
};

/** A build whose runs really run, so each leaves `LEFT` behind, and are then reported as out of time: the build stops with its leftovers on show. */
async function stoppedWithLeftovers() {
  const ctx = setup();
  const { vm, transport, runner, lock } = ctx;
  vi.spyOn(transport, 'sdlcLeftovers').mockResolvedValue(LEFT);
  vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(UNFINISHED);
  const discard = vi.spyOn(transport, 'sdlcDiscard');
  const real = runner.runInRepo.bind(runner);
  const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
    await real(target, spec, link);
    return { exit: 124, error: null };
  });
  await vm.start(await handoffFor(transport), CTX);
  await drive(vm, lock, () => vm.phase() === 'stopped' && runner.leftovers() !== null);
  return { ...ctx, run, discard };
}

it('the lock is released once the build is settled and taken again by Continue', async () => {
  const { vm, runner, lock } = await stoppedWithLeftovers();
  // The build is over, but the leftovers are still on show: the page keeps the lock until the engineer has chosen.
  expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
  runner.closeLeftovers();
  await advance(300);
  expect(runner.leftovers()).toBeNull();
  expect(lock.active()).toBeNull();

  vm.select('claims-core');
  await vm.continueRun();
  await advance(100);
  expect(lock.active()).toMatchObject({ kind: 'build', finished: false });
});

describe('no leftover is discarded without the engineer\'s choice', () => {
  it('continuing the stopped repository on top of its leftovers discards nothing', async () => {
    const { vm, transport, runner, run, discard } = await stoppedWithLeftovers();
    runner.closeLeftovers();
    await advance(300);
    vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/x.rs'] }] });
    vm.select('claims-core');
    await vm.continueRun();
    expect(vm.leftoverPrompt()).toEqual({ lines: ['claims-core: src/x.rs'] });
    await vm.confirmContinue();
    await advance(300);
    expect(run).toHaveBeenCalledTimes(2);
    expect(discard).not.toHaveBeenCalled();
  });

  it('asking for a round discards nothing', async () => {
    const { vm, transport, runner, run, discard } = await stoppedWithLeftovers();
    runner.closeLeftovers();
    await advance(300);
    const round = { instructions: 'tidy up the logging', repo: 'claims-core' };
    expect(await vm.start(await handoffFor(transport, { round }), CTX)).toBe(true);
    await advance(300);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1].task).toContain('tidy up the logging');
    expect(discard).not.toHaveBeenCalled();
  });

  it('leaving the page with leftovers on show discards nothing', async () => {
    const { host, runner, discard } = await stoppedWithLeftovers();
    expect(runner.leftovers()).not.toBeNull();
    hosts = hosts.filter((h) => h !== host);
    host.destroy();
    await advance(300);
    expect(discard).not.toHaveBeenCalled();
  });
});

describe('the build page shows tasks and sessions from the build log, the run links and the records', () => {
  const secs = (h: number, m = 0) => Math.floor(new Date(2026, 9, 19, h, m, 0).getTime() / 1000);
  const link = (stage: string, run_id: string, started_at: number): RunLink => ({ workspace_id: 'acme-claims', system: 'claims', change: MOCK_BUILD_CHANGE, stage, run_id, started_at });
  const taskLink = (task: string, run_id: string, repo = 'claims-core'): TaskLink => ({ workspace_id: 'acme-claims', system: 'claims', change: MOCK_BUILD_CHANGE, repo, task, run_id });
  const record = (id: string, exit: number): RunRecord => ({ id, kata: 'build', started_at: 0, isolation: 'none', exit, turns: 7, cost_usd: 0.5 });
  const T1_ROW = { task: 'T1', repo: 'claims-core', commits: ['aaaaaaa'], departure: null };

  /** A page opened on a change with nothing running; T1 is in the build log when `built`. */
  async function opened(over: { links?: RunLink[]; taskLinks?: TaskLink[]; records?: RunRecord[]; built?: boolean } = {}) {
    const s = setup();
    vi.spyOn(s.transport, 'sdlcRunLinks').mockResolvedValue(over.links ?? []);
    vi.spyOn(s.transport, 'sdlcTaskLinks').mockResolvedValue(over.taskLinks ?? []);
    vi.spyOn(s.transport, 'listRuns').mockResolvedValue(over.records ?? []);
    const status = await s.transport.sdlcBuildStatus(FOLDER, 'claims', MOCK_BUILD_CHANGE);
    if (over.built ?? true) status.tasks = status.tasks.map((t) => (t.id === 'T1' ? { ...t, row: T1_ROW } : t));
    const [change] = (await s.transport.sdlcChanges(`${FOLDER}/${MOCK_MASTER}`, 'claims')).filter((c) => c.change === MOCK_BUILD_CHANGE);
    const load = () => s.vm.load({ ctx: CTX, master: { repo: MOCK_MASTER, path: `${FOLDER}/${MOCK_MASTER}` }, change, status, done: false, review: null });
    return { ...s, load, status };
  }
  const states = (vm: BuildPageViewModel, repo: string) => Object.fromEntries(vm.taskAreas().find((g) => g.repo === repo)!.tasks.map((t) => [t.id, t.state.kind]));

  it('a committed row shows its task done and the next one running without a click', async () => {
    const { vm, transport } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await advance(300);
    expect(states(vm, 'customer-portal')).toEqual({ T2: 'running', T3: 'not-started' });
    const sdlc = (transport as unknown as { sdlc: { commitRows(t: { id: string; name: string; repo: string; dependsOn: string[] }[]): void } }).sdlc;
    sdlc.commitRows([
      { id: 'T1', name: '', repo: 'claims-core', dependsOn: [] },
      { id: 'T2', name: '', repo: 'customer-portal', dependsOn: [] },
    ]);
    await advance(2500);
    expect(states(vm, 'customer-portal')).toEqual({ T2: 'done', T3: 'running' });
  });

  it('picking a task shows the session that recorded it', async () => {
    const { vm, load } = await opened({
      links: [link('build:claims-core', 'run-a', secs(8)), link('build:claims-core', 'run-b', secs(9))],
      taskLinks: [taskLink('T1', 'run-b')],
    });
    await load();
    vm.choose({ kind: 'task', task: 'T1' });
    expect(vm.shownSessions().map((s) => s.id)).toEqual(['run-b']);
    expect(vm.shownSessions()[0]).toMatchObject({ latest: true, spec: null });
    expect(vm.sessionNote()).toBeNull();
  });

  it('a task with no known session shows its repository\'s sessions and says so', async () => {
    const { vm, load } = await opened({ links: [link('build:claims-core', 'run-a', secs(8)), link('build:claims-core', 'run-b', secs(9))] });
    await load();
    vm.choose({ kind: 'task', task: 'T1' });
    expect(vm.shownSessions().map((s) => s.id)).toEqual(['run-a', 'run-b']);
    expect(vm.sessionNote()).toBe('This task was recorded before Kata linked tasks to runs, or on another machine. Showing every session of claims-core.');
  });

  it('earlier runs fold under the latest with their start time and how they ended', async () => {
    const { vm, transport, load } = await opened({
      built: false,
      links: [link('build:claims-core', 'run-a', secs(8)), link('build:claims-core', 'run-b', secs(8, 30))],
      records: [record('run-a', 124), record('run-b', 1)],
    });
    await load();
    await vm.start(await handoffFor(transport), CTX);
    await advance(500);
    vm.choose({ kind: 'repo', repo: 'claims-core' });
    const [a, b, live] = vm.shownSessions();
    expect([a.id, b.id]).toEqual(['run-a', 'run-b']);
    expect([a.startedAt, b.startedAt]).toEqual(['08:00:00', '08:30:00']);
    expect(a.outcome).toContain('exit 124');
    expect(b.outcome).toContain('exit 1 ');
    expect([a.latest, b.latest, live.latest]).toEqual([false, false, true]);
    expect([a.expanded, b.expanded, live.expanded]).toEqual([false, false, false]);
    expect(live.spec).not.toBeNull();
    vm.toggleRun('run-a');
    expect(vm.shownSessions()[0].expanded).toBe(true);
  });

  it('a run\'s end links the tasks it recorded', async () => {
    const { vm, transport, lock } = setup();
    const linkTasks = vi.spyOn(transport, 'sdlcLinkTasks');
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, () => linkTasks.mock.calls.some(([l]) => l.some((x) => x.repo === 'claims-core')));
    const id = vm.groups().find((g) => g.key === 'claims-core')!.runs[0].id;
    expect(linkTasks).toHaveBeenCalledWith([taskLink('T1', id)]);
  });

  it('a not-started change with uncommitted edits shows the files area', async () => {
    const { vm, transport, load } = await opened({ built: false });
    const empty = { files: [], loc: [] };
    const listing = { files: [{ path: 'src/a.ts', oldPath: null, status: 'modified', added: 1, removed: 0, binary: false, uncommitted: true }], loc: [] };
    const read = vi.spyOn(transport, 'sdlcDiffFiles').mockImplementation((path) => Promise.resolve((path.endsWith('claims-core') ? listing : empty) as never));
    await load();
    await advance(100);
    expect(vm.view().areas.files).toBe(true);
    read.mockResolvedValue(empty as never);
    await load();
    await advance(100);
    expect(vm.view().areas.files).toBe(false);
  });
});
