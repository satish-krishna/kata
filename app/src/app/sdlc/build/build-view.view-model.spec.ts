import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BuildStatus } from '@bindings/BuildStatus';
import { toastState } from '@spartan-ng/brain/sonner';
import { LockStore } from '../../core/lock/lock.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

const FOLDER = MOCK_WORKSPACE_FOLDER;
const CTX: BuildContext = { workspaceId: 'acme-claims', folder: FOLDER, system: 'claims', change: MOCK_BUILD_CHANGE, systemRepos: [] };
const REVIEW_NAME = `sdlc-claims-${MOCK_BUILD_CHANGE}-review`;

function setup(transport = new MockTransport()) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), BuildViewModel, { provide: KataTransport, useValue: transport }],
  });
  return {
    vm: TestBed.inject(BuildViewModel),
    transport,
    lock: TestBed.inject(LockStore),
    runner: TestBed.inject(SdlcRunner),
  };
}

async function handoffFor(transport: MockTransport, over: Partial<BuildHandoff> = {}): Promise<BuildHandoff> {
  const out = await transport.sdlcBuildPrepare(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, false);
  if (out.kind !== 'ready') throw new Error('the mock build did not prepare');
  return { start: out.start, timeoutSecs: 5400, round: null, checksDir: await transport.sdlcChecksDir(), ...over };
}

/** Advances the fake clock in small steps, flushing effects between them, the way a running app would. */
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
    TestBed.tick();
  }
};

/** Runs the build to its end, answering every question the agents ask, until `done` holds. */
async function drive(vm: BuildViewModel, lock: LockStore, done: () => boolean, limitMs = 60000) {
  for (let t = 0; t < limitMs && !done(); t += 100) {
    await advance(100);
    for (const w of lock.waiting()) if (w.kind === 'answer') vm.answer(w.runId, { id: 'q1', answers: [['Reuse it']] });
  }
  await advance(200);
  expect(done()).toBe(true);
}

const row = (vm: BuildViewModel, name: string) => vm.rows().find((r) => r.name === name)!;
const finished = (vm: BuildViewModel) => () => vm.phase() === 'finished' && vm.findings().length > 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  toastState.reset();
});

describe('BuildViewModel', () => {
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
    expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
    vm.select('claims-core');
    await vm.continueRun();
    await advance(500);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][4]).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
    expect(lock.active()).toMatchObject({ kind: 'build', finished: false });
    expect(row(vm, 'claims-core').label).toBe('Working · T1');
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
    vi.spyOn(transport, 'sdlcSnapshot').mockResolvedValue({ head: 'abc', dirty: { 'src/half.rs': 'x1' } });
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
    expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
  });

  it('Close releases the lock', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));
    await vm.close();
    expect(lock.active()).toBeNull();
  });

  it('a round that adds commits is reviewed again and the old findings are marked replaced (R8.4)', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));
    await vm.close();

    const heads = vi.spyOn(transport, 'sdlcBuildHeads');
    heads.mockResolvedValueOnce({ 'claims-core': 'aaaaaaa' });
    heads.mockResolvedValue({ 'claims-core': 'bbbbbbb' });
    const runSpec = vi.spyOn(transport, 'runSpec');
    const next = TestBed.runInInjectionContext(() => new BuildViewModel());
    const round = { instructions: 'rename the status field to state', repo: 'claims-core' };
    await next.start(await handoffFor(transport, { round }), CTX);
    await drive(next, lock, finished(next));
    const specs = runSpec.mock.calls.map(([spec]) => spec);
    expect(specs.filter((s) => s.name === REVIEW_NAME)).toHaveLength(1);
    expect(specs[0].task).toContain('rename the status field to state');
    expect(next.findings()).toHaveLength(2);
    expect(next.replaced()).toHaveLength(1);
    expect(next.replaced()[0].findings).toHaveLength(2);
    expect(next.replaced()[0].at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('a round that adds no commits is not reviewed again', async () => {
    const { vm, transport, lock } = setup();
    await vm.start(await handoffFor(transport), CTX);
    await drive(vm, lock, finished(vm));
    await vm.close();

    const runSpec = vi.spyOn(transport, 'runSpec');
    const next = TestBed.runInInjectionContext(() => new BuildViewModel());
    const round = { instructions: 'look at the logging', repo: 'claims-core' };
    await next.start(await handoffFor(transport, { round }), CTX);
    await drive(next, lock, () => next.phase() === 'finished');
    expect(runSpec.mock.calls.map(([spec]) => spec.name)).not.toContain(REVIEW_NAME);
    expect(next.replaced()).toEqual([]);
  });

  it('the build stops and lists what is left', async () => {
    const { vm, transport, runner, lock } = setup();
    const task = (id: string, name: string, repo: string, dependsOn: string[], done: boolean) => ({
      id, name, repo, dependsOn, row: done ? { task: id, repo, commits: ['abc1234'], departure: null } : null,
    });
    const status: BuildStatus = {
      hasTasks: true,
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
    expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
  });

  describe('a round for the master repository', () => {
    const doneTask = (id: string, repo: string) => ({
      id, name: id, repo, dependsOn: [], row: { task: id, repo, commits: ['abc1234'], departure: null },
    });
    const allDone: BuildStatus = {
      hasTasks: true,
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
});
