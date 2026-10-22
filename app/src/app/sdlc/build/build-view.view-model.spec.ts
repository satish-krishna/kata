import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { Participant } from '@bindings/Participant';
import { toastState } from '@spartan-ng/brain/sonner';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
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
  const out = await transport.sdlcBuildPrepare(FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, false, null, 'start');
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

/** The build's participants as the backend answers them: the master and the two product repositories, each with what it owns. */
const part = (repo: string, over: Partial<Participant> = {}): Participant => ({ repo, path: `${FOLDER}/${repo}`, master: repo === MOCK_MASTER, files: [], rows: [], ...over });
const everyone = (over: Record<string, Partial<Participant>> = {}): Participant[] => [MOCK_MASTER, 'claims-core', 'customer-portal'].map((r) => part(r, over[r]));
const ROW = (repo: string) => `intent/claims/${MOCK_BUILD_CHANGE}/build/${repo}.md`;

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
    expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
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
    const shown = (vm: BuildViewModel) => () => vm.phase() === 'finished' && vm.reviewShown();

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
    expect(next.replaced()[0].label).toBe('Review 1 of 2026-10-19');
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
    expect(lock.active()).toMatchObject({ kind: 'build', finished: true });
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
