import type { BuildStatus } from '@bindings/BuildStatus';
import type { RepoState } from '@bindings/RepoState';
import { stopMessage } from '../../lib/sdlc';
import { BuildDriver, OUTCOME_RULES, runOutcome, type Facts, type Outcome, type RunEnd, type RunOptions, type RunTarget } from './build-driver';

interface PlanTask {
  id: string;
  repo: string;
  dependsOn?: string[];
}

interface Started {
  target: RunTarget;
  opts: RunOptions;
  end: (rows: string[], result?: Partial<RunEnd>) => Promise<void>;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** A scripted master repository: the plan's tasks, the rows committed so far, and a fake `start`. */
function world(plan: PlanTask[], initialRows: string[] = []) {
  const rows = new Set(initialRows);
  const heads: Record<string, string> = {};
  const started: Started[] = [];
  const log: string[] = [];
  const repos = [...new Set(plan.map((t) => t.repo))];

  const failures = { status: 0 };
  const status = async (): Promise<BuildStatus> => {
    if (failures.status > 0) {
      failures.status -= 1;
      throw new Error('status read failed');
    }
    const tasks = plan.map((t) => ({
      id: t.id,
      name: t.id,
      repo: t.repo,
      dependsOn: t.dependsOn ?? [],
      text: `### ${t.id}`,
      row: rows.has(t.id) ? { task: t.id, repo: t.repo, commits: [], departure: null } : null,
    }));
    const states = repos.map((repo) => {
      const mine = tasks.filter((t) => t.repo === repo);
      const first = mine.find((t) => !t.row) ?? null;
      let state: RepoState = { kind: 'done' };
      if (first) {
        const blocker = first.dependsOn.map((d) => tasks.find((t) => t.id === d)!).find((d) => !d.row);
        state = blocker
          ? { kind: 'waiting', task: first.id, onTask: blocker.id, onRepo: blocker.repo }
          : { kind: 'ready', task: first.id };
      }
      return { repo, firstUnfinished: first?.id ?? null, state, tasks: mine.length, finished: mine.filter((t) => t.row).length };
    });
    return { tasks, repos: states, departures: [], hasTasks: tasks.length > 0, problems: [], logLayouts: [] };
  };

  const start = (target: RunTarget, opts: RunOptions): Promise<RunEnd> => {
    log.push(target === 'review' ? 'review' : target.repo);
    return new Promise<RunEnd>((resolve) => {
      started.push({
        target,
        opts,
        end: async (done, result = {}) => {
          done.forEach((r) => rows.add(r));
          resolve({ exit: 0, error: null, ...result });
          await flush();
        },
      });
    });
  };

  const driver = new BuildDriver({ status, start, heads: async () => ({ ...heads }) });
  const of = (repo: string) => started.filter((s) => s.target !== 'review' && s.target.repo === repo);
  return { driver, started, log, rows, heads, of, status, failures };
}

const going = (d: BuildDriver) => [...d.going()].sort();

describe('BuildDriver', () => {
  it('independent repositories start together (R19.1)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['app', 'api']);
    expect(going(w.driver)).toEqual(['api', 'app']);
  });

  it('a waiting repository is shown as waiting and starts once its dependency has a row (R19.2)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }, { id: 'T2', repo: 'app', dependsOn: ['T1'] }]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['api']);
    expect(w.driver.stopped().has('app')).toBe(false);
    expect(w.driver.waiting()).toEqual([{ repo: 'app', task: 'T2', onTask: 'T1', onRepo: 'api' }]);
    await w.of('api')[0].end(['T1']);
    expect(w.log).toEqual(['api', 'app']);
    expect(w.driver.waiting()).toEqual([]);
    expect(w.driver.stopped().size).toBe(0);
  });

  it('a repository waiting on an unrecorded task does not start (R14.2)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }, { id: 'T2', repo: 'app', dependsOn: ['T1'] }]);
    await w.driver.begin(3600);
    await flush();
    await w.of('api')[0].end([], { exit: 0 });
    expect(w.driver.stopped().get('api')).toEqual({ task: 'T1', reason: stopMessage(0, null) });
    expect(w.log).toEqual(['api']);
    expect(w.driver.waiting().map((x) => x.repo)).toEqual(['app']);
    expect(w.driver.stopped().has('app')).toBe(false);
  });

  it('alternating tasks take several runs, all started by the driver (R18.6)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'api', dependsOn: ['T1'] },
      { id: 'T3', repo: 'app', dependsOn: ['T2'] },
    ]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['app']);
    await w.of('app')[0].end(['T1']);
    expect(w.log).toEqual(['app', 'api']);
    await w.of('api')[0].end(['T2']);
    expect(w.log).toEqual(['app', 'api', 'app']);
    expect(w.of('app')).toHaveLength(2);
  });

  it('a repository never has two runs at once (R19.5)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'app' }]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['app']);
    await w.driver.continueAll();
    await flush();
    expect(w.log).toEqual(['app']);
    await w.of('app')[0].end(['T1']);
    expect(w.log).toEqual(['app', 'app']);
  });

  it('a stopped repository does not stop the others (R6.7)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'api' },
      { id: 'T3', repo: 'docs', dependsOn: ['T1'] },
    ]);
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end([], { exit: 124 });
    expect(w.driver.stopped().get('app')?.reason).toBe(stopMessage(124, null));
    expect(going(w.driver)).toEqual(['api']);
    expect(w.driver.waiting().map((x) => x.repo)).toEqual(['docs']);
    expect(w.driver.phase()).toBe('building');
  });

  it('Continue restarts only the stopped repository (R6.2)', async () => {
    const w = world(
      [
        { id: 'T1', repo: 'app' },
        { id: 'T2', repo: 'app' },
        { id: 'T3', repo: 'app' },
        { id: 'T4', repo: 'api' },
      ],
      ['T1', 'T2'],
    );
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end([], { exit: 124 });
    expect(w.driver.stopped().has('app')).toBe(true);
    expect(w.log).toEqual(['app', 'api']);
    await w.driver.continueRepo('app');
    await flush();
    expect(w.log).toEqual(['app', 'api', 'app']);
    expect(w.of('api')).toHaveLength(1);
    expect(w.driver.stopped().size).toBe(0);
    expect(w.driver.phase()).toBe('building');
  });

  it.each([
    [124, null],
    [123, null],
    [1, 'the agent crashed'],
  ])('a run that stops on its second task stays stopped and is not relaunched (R6.1, exit %s)', async (exit, error) => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'app' },
      { id: 'T3', repo: 'app' },
      { id: 'T4', repo: 'app' },
    ]);
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end(['T1', 'T2'], { exit, error });
    expect(w.driver.stopped().get('app')).toEqual({ task: 'T3', reason: stopMessage(exit, error) });
    expect(w.log).toEqual(['app']);
    expect(w.driver.going().size).toBe(0);
    expect(w.driver.phase()).toBe('stopped');
    await w.driver.continueRepo('app');
    await flush();
    expect(w.log).toEqual(['app', 'app']);
  });

  it('the build stops with the unfinished tasks by repository when nothing can run (R19.6)', async () => {
    const w = world([
      { id: 'T1', repo: 'api' },
      { id: 'T2', repo: 'api' },
      { id: 'T3', repo: 'app', dependsOn: ['T2'] },
    ]);
    await w.driver.begin(3600);
    await flush();
    await w.of('api')[0].end(['T1']);
    await w.of('api')[1].end([], { exit: 125 });
    expect(w.driver.phase()).toBe('stopped');
    expect(w.driver.report()).toEqual({
      unfinished: [
        { repo: 'api', tasks: ['T2'] },
        { repo: 'app', tasks: ['T3'] },
      ],
      waiting: [{ repo: 'app', task: 'T3', onTask: 'T2', onRepo: 'api' }],
    });
    expect(w.log).not.toContain('review');
  });

  it('the driver gives every run the time limit the engineer set (R2.6)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }, { id: 'T3', repo: 'app' }]);
    await w.driver.begin(14400);
    await flush();
    await w.of('app')[0].end(['T1']);
    expect(w.started.map((s) => s.opts.timeoutSecs)).toEqual([14400, 14400, 14400]);
  });

  it('the review starts once every task has a row and nothing is going', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
    w.heads['app'] = 'a1';
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end(['T1']);
    expect(w.log).toEqual(['app', 'api']);
    await w.of('api')[0].end(['T2']);
    expect(w.log).toEqual(['app', 'api', 'review']);
    expect(w.driver.phase()).toBe('reviewing');
    await w.started[2].end([]);
    expect(w.log.filter((l) => l === 'review')).toHaveLength(1);
    expect(w.driver.phase()).toBe('finished');
  });

  it("the review's own commit in the master does not start another review", async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    w.heads['master'] = 'm1';
    w.heads['api'] = 'h1';
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['review']);
    // The review records its findings: a docs commit in the master.
    w.heads['master'] = 'm2';
    await w.started[0].end([]);
    expect(w.log).toEqual(['review']);
    expect(w.driver.phase()).toBe('finished');
    // A later round that commits nothing is still not reviewed again: the review's commit is the new baseline.
    await w.driver.begin(3600, { repo: 'api', instructions: 'look around' });
    await flush();
    await w.started[1].end([]);
    expect(w.log).toEqual(['review', 'api']);
    expect(w.driver.phase()).toBe('finished');
  });

  it('a round with new commits starts a new review', async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    w.heads['api'] = 'h1';
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['review']);
    await w.started[0].end([]);
    expect(w.driver.phase()).toBe('finished');
    await w.driver.begin(3600, { repo: 'api', instructions: 'rename the status field to state' });
    await flush();
    expect(w.log).toEqual(['review', 'api']);
    w.heads['api'] = 'h2';
    await w.started[1].end([]);
    expect(w.log).toEqual(['review', 'api', 'review']);
    await w.started[2].end([]);
    expect(w.driver.phase()).toBe('finished');
  });

  it('a round without new commits does not review again', async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    w.heads['api'] = 'h1';
    await w.driver.begin(3600);
    await flush();
    await w.started[0].end([]);
    await w.driver.begin(3600, { repo: 'api', instructions: 'look around' });
    await flush();
    await w.started[1].end([]);
    expect(w.log).toEqual(['review', 'api']);
    expect(w.driver.phase()).toBe('finished');
  });

  it('a round on a finished repository starts it', async () => {
    const w = world([{ id: 'T1', repo: 'api' }, { id: 'T2', repo: 'app' }], ['T1', 'T2']);
    await w.driver.begin(7200, { repo: 'api', instructions: 'rename the status field to state' });
    await flush();
    expect(w.log).toEqual(['api']);
    expect(w.started[0].opts.instructions).toBe('rename the status field to state');
    expect(w.started[0].opts.timeoutSecs).toBe(7200);
    expect(w.driver.round()?.repo).toBe('api');
  });

  it('a round for a repository the plan does not name still runs (R8.1)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    await w.driver.begin(3600, { repo: 'master', instructions: 'tidy the notes' });
    await flush();
    expect(w.log).toEqual(['master']);
    expect(w.started[0].opts.instructions).toBe('tidy the notes');
    expect(w.driver.phase()).toBe('building');
  });

  it('a round for the master that fails stops the build instead of finishing it, and Continue runs it again (R6.1, R8.1)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    await w.driver.begin(3600, { repo: 'master', instructions: 'tidy the notes' });
    await flush();
    await w.started[0].end([], { exit: 124 });
    expect(w.driver.stopped().get('master')).toEqual({ task: '', reason: stopMessage(124, null) });
    expect(w.driver.phase()).toBe('stopped');
    expect(w.log).toEqual(['master']);
    await w.driver.continueRepo('master');
    await flush();
    expect(w.log).toEqual(['master', 'master']);
    expect(w.started[1].opts.instructions).toBe('tidy the notes');
    await w.started[1].end([]);
    expect(w.driver.stopped().size).toBe(0);
    expect(w.driver.round()).toBeNull();
    expect(w.driver.phase()).toBe('finished');
  });

  it('a round on a finished repository that fails stops the build, and Continue runs it again (R6.1, R8.1)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }, { id: 'T2', repo: 'app' }], ['T1', 'T2']);
    await w.driver.begin(3600, { repo: 'api', instructions: 'rename it' });
    await flush();
    await w.started[0].end([], { exit: 124 });
    expect(w.driver.phase()).toBe('stopped');
    expect(w.driver.stopped().get('api')?.reason).toBe(stopMessage(124, null));
    await w.driver.continueRepo('api');
    await flush();
    expect(w.of('api')).toHaveLength(2);
    expect(w.of('api')[1].opts.instructions).toBe('rename it');
  });

  it('a committing round for the master is reviewed again (R8.4)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }], ['T1']);
    w.heads['master'] = 'm1';
    await w.driver.begin(3600, { repo: 'master', instructions: 'tidy the notes' });
    await flush();
    w.heads['master'] = 'm2';
    await w.started[0].end([]);
    expect(w.log).toEqual(['master', 'review']);
  });

  it('a round for a waiting repository is not dropped silently (R8.3)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api', dependsOn: ['T1'] }]);
    await w.driver.begin(3600, { repo: 'api', instructions: 'rename it' });
    await flush();
    await w.started[0].end([], { exit: 1 });
    expect(w.driver.phase()).toBe('stopped');
    expect(w.driver.round()?.repo).toBe('api');
    await w.driver.continueRepo('app');
    await flush();
    await w.started[1].end(['T1']);
    expect(w.of('api')[0].opts.instructions).toBe('rename it');
  });

  it('a failed status read while other runs go does not stop the build (R6.7, R10.1)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
    await w.driver.begin(3600);
    await flush();
    w.failures.status = 1;
    await w.of('app')[0].end(['T1']);
    expect(w.driver.going().has('api')).toBe(true);
    expect(w.driver.phase()).toBe('building');
  });

  it('a failed status read with nothing else going stops the build', async () => {
    const w = world([{ id: 'T1', repo: 'app' }]);
    await w.driver.begin(3600);
    await flush();
    w.failures.status = 1;
    await w.of('app')[0].end(['T1']);
    expect(w.driver.phase()).toBe('stopped');
  });

  it('a run whose status read fails is marked stopped and is not relaunched when another run ends (R6.1)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'app' },
      { id: 'T3', repo: 'app' },
      { id: 'T4', repo: 'app' },
      { id: 'T5', repo: 'api' },
    ]);
    await w.driver.begin(3600);
    await flush();
    w.rows.add('T1');
    w.rows.add('T2');
    w.failures.status = 1;
    await w.of('app')[0].end([], { exit: 124 });
    expect(w.driver.stopped().get('app')?.reason).toContain('could not read build status');
    await w.of('api')[0].end(['T5']);
    expect(w.of('app')).toHaveLength(1);
    expect(w.driver.going().has('app')).toBe(false);
    expect(w.driver.phase()).toBe('stopped');
  });

  it('cancel all starts nothing new', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }, { id: 'T3', repo: 'app' }]);
    await w.driver.begin(3600);
    await flush();
    w.driver.cancelAll();
    expect(w.started.every((s) => s.opts.signal.aborted)).toBe(true);
    await w.of('app')[0].end(['T1'], { exit: 130 });
    await w.of('api')[0].end([], { exit: 130 });
    expect(w.log).toEqual(['app', 'api']);
    expect(w.driver.phase()).toBe('cancelled');
    expect(w.driver.going().size).toBe(0);
  });

  it('cancel stops one repository and leaves it stopped', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
    await w.driver.begin(3600);
    await flush();
    w.driver.cancel('app');
    expect(w.of('app')[0].opts.signal.aborted).toBe(true);
    expect(w.of('api')[0].opts.signal.aborted).toBe(false);
    await w.of('app')[0].end([], { exit: 130 });
    expect(w.driver.stopped().get('app')?.reason).toBe(stopMessage(130, null));
    expect(going(w.driver)).toEqual(['api']);
  });

  it.each([[0, null], [1, 'boom'], [124, null], [null, null]] as const)(
    'a repository the engineer cancelled says "Stopped: cancelled" whatever the engine exited with (exit %s)',
    async (exit, error) => {
      const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
      await w.driver.begin(3600);
      await flush();
      w.driver.cancel('app');
      await w.of('app')[0].end([], error === null ? { exit } : { exit, error });
      expect(w.driver.stopped().get('app')?.reason).toBe('Stopped: cancelled');
    },
  );

  it('a run nobody cancelled that exits 1 still says the agent failed', async () => {
    const w = world([{ id: 'T1', repo: 'app' }]);
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end([], { exit: 1 });
    expect(w.driver.stopped().get('app')?.reason).toBe('Stopped: the agent failed');
  });

  it('a cancelled repository that is now waiting is not relaunched when its dependency gets a row (R6.1)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'app', dependsOn: ['T3'] },
      { id: 'T3', repo: 'api' },
    ]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['app', 'api']);
    w.driver.cancel('app');
    await w.of('app')[0].end(['T1'], { exit: 130 });
    expect(w.driver.stopped().get('app')).toEqual({ task: 'T2', reason: stopMessage(130, null) });
    await w.of('api')[0].end(['T3']);
    expect(w.log).toEqual(['app', 'api']);
    expect(w.driver.going().has('app')).toBe(false);
  });

  it.each([
    [124, null],
    [123, null],
    [1, 'the agent crashed'],
  ])('a run that recorded every task for its repository is finished whatever its exit code (exit %s)', async (exit, error) => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'app' },
    ]);
    w.heads['app'] = 'a1';
    await w.driver.begin(3600);
    await flush();
    await w.of('app')[0].end(['T1', 'T2'], { exit, error });
    expect(w.driver.stopped().size).toBe(0);
    expect(w.driver.phase()).toBe('reviewing');
    expect(w.log).toEqual(['app', 'review']);
  });

  it('a round that recorded every task but failed stays stopped (R6.1, R8.1)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'app' },
    ]);
    await w.driver.begin(3600, { repo: 'app', instructions: 'finish it' });
    await flush();
    await w.of('app')[0].end(['T1', 'T2'], { exit: 124 });
    expect(w.driver.stopped().has('app')).toBe(true);
    expect(w.driver.phase()).toBe('stopped');
  });

  it('a round that ends cleanly with no row for its launch task stops, is not relaunched by itself, and Continue reruns it with its instructions (R8.1)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }]);
    await w.driver.begin(3600, { repo: 'app', instructions: 'finish it' });
    await flush();
    expect(w.of('app')).toHaveLength(1);
    expect(w.of('app')[0].opts.instructions).toBe('finish it');
    await w.of('app')[0].end([], { exit: 0 });
    await flush();
    expect(w.of('app')).toHaveLength(1);
    expect(w.driver.going().has('app')).toBe(false);
    expect(w.driver.stopped().get('app')).toEqual({ task: 'T1', reason: stopMessage(0, null) });
    expect(w.driver.phase()).toBe('stopped');
    expect(w.driver.round()).not.toBeNull();
    await w.driver.continueRepo('app');
    await flush();
    expect(w.of('app')).toHaveLength(2);
    expect(w.of('app')[1].opts.instructions).toBe('finish it');
  });
});

describe('runOutcome', () => {
  const stop: Outcome = { kind: 'stop' };
  const held: Outcome = { kind: 'stop', held: true };
  const finished: Outcome = { kind: 'finished' };
  const carryOn: Outcome = { kind: 'continue' };
  const impossible = 'impossible';

  /** Every combination, with its outcome written out by hand: nothing here is derived from the code's table. */
  const cases: [Facts['kind'], boolean, boolean, boolean, Facts['stateAfter'], Outcome | typeof impossible][] = [
    // kind, cancelled, failed, recorded, stateAfter, outcome
    ['task', false, false, true, 'ready', carryOn],
    ['task', false, false, true, 'waiting', carryOn],
    ['task', false, false, true, 'done', finished],
    ['task', false, false, true, 'unknown', impossible],
    ['task', false, false, false, 'ready', stop],
    ['task', false, false, false, 'waiting', carryOn],
    ['task', false, false, false, 'done', impossible],
    ['task', false, false, false, 'unknown', held],
    ['task', false, true, true, 'ready', stop],
    ['task', false, true, true, 'waiting', stop],
    ['task', false, true, true, 'done', finished],
    ['task', false, true, true, 'unknown', impossible],
    ['task', false, true, false, 'ready', stop],
    ['task', false, true, false, 'waiting', stop],
    ['task', false, true, false, 'done', impossible],
    ['task', false, true, false, 'unknown', held],
    ['task', true, false, true, 'ready', stop],
    ['task', true, false, true, 'waiting', stop],
    ['task', true, false, true, 'done', finished],
    ['task', true, false, true, 'unknown', impossible],
    ['task', true, false, false, 'ready', stop],
    ['task', true, false, false, 'waiting', stop],
    ['task', true, false, false, 'done', impossible],
    ['task', true, false, false, 'unknown', held],
    ['task', true, true, true, 'ready', stop],
    ['task', true, true, true, 'waiting', stop],
    ['task', true, true, true, 'done', finished],
    ['task', true, true, true, 'unknown', impossible],
    ['task', true, true, false, 'ready', stop],
    ['task', true, true, false, 'waiting', stop],
    ['task', true, true, false, 'done', impossible],
    ['task', true, true, false, 'unknown', held],
    ['round', false, false, true, 'ready', carryOn],
    ['round', false, false, true, 'waiting', carryOn],
    ['round', false, false, true, 'done', finished],
    // Reachable only when the round launched on the task "" (the master, or a repository with every task recorded): recorded is then true without a status read (R6.1: hold until the status is read again).
    ['round', false, false, true, 'unknown', held],
    // R8.1: the unfinished task is built first, and no row means the round was not carried out; the round stays pending so Continue reruns it with its instructions
    ['round', false, false, false, 'ready', stop],
    // R8.1: the unfinished task is built first, and no row means the round was not carried out; the round stays pending so Continue reruns it with its instructions (the repository is blocked on another repository, and a stop at its current task keeps it from relaunching by itself)
    ['round', false, false, false, 'waiting', stop],
    // A launch task that is not "" and has no row cannot leave the repository done (R8.1: the unfinished task is built first); a launch task "" is recorded.
    ['round', false, false, false, 'done', impossible],
    // R6.1: the status could not be read, so the stop holds until it is read again.
    ['round', false, false, false, 'unknown', held],
    ['round', false, true, true, 'ready', stop],
    ['round', false, true, true, 'waiting', stop],
    ['round', false, true, true, 'done', stop],
    // Reachable only when the round launched on the task "" (the master, or a repository with every task recorded): recorded is then true without a status read (R6.1: hold until the status is read again).
    ['round', false, true, true, 'unknown', held],
    // R6.1, R8.1: a failed round with no row for its launch task stops, and Continue reruns it
    ['round', false, true, false, 'ready', stop],
    // R6.1, R8.1: a failed round with no row for its launch task stops, and Continue reruns it (the repository is blocked on another repository, and a stop at its current task keeps it from relaunching by itself)
    ['round', false, true, false, 'waiting', stop],
    // A launch task that is not "" and has no row cannot leave the repository done (R8.1: the unfinished task is built first); a launch task "" is recorded.
    ['round', false, true, false, 'done', impossible],
    // R6.1: the status could not be read, so the stop holds until it is read again.
    ['round', false, true, false, 'unknown', held],
    ['round', true, false, true, 'ready', stop],
    ['round', true, false, true, 'waiting', stop],
    ['round', true, false, true, 'done', stop],
    // Reachable only when the round launched on the task "" (the master, or a repository with every task recorded): recorded is then true without a status read (R6.1: hold until the status is read again).
    ['round', true, false, true, 'unknown', held],
    // R6.1, R8.1: a cancelled round stops, and Continue reruns it with its instructions
    ['round', true, false, false, 'ready', stop],
    // R6.1, R8.1: a cancelled round stops, and Continue reruns it with its instructions (the repository is blocked on another repository, and a stop at its current task keeps it from relaunching by itself)
    ['round', true, false, false, 'waiting', stop],
    // A launch task that is not "" and has no row cannot leave the repository done (R8.1: the unfinished task is built first); a launch task "" is recorded.
    ['round', true, false, false, 'done', impossible],
    // R6.1: the status could not be read, so the stop holds until it is read again.
    ['round', true, false, false, 'unknown', held],
    ['round', true, true, true, 'ready', stop],
    ['round', true, true, true, 'waiting', stop],
    ['round', true, true, true, 'done', stop],
    // Reachable only when the round launched on the task "" (the master, or a repository with every task recorded): recorded is then true without a status read (R6.1: hold until the status is read again).
    ['round', true, true, true, 'unknown', held],
    // R6.1, R8.1: a cancelled round stops, and Continue reruns it with its instructions
    ['round', true, true, false, 'ready', stop],
    // R6.1, R8.1: a cancelled round stops, and Continue reruns it with its instructions (the repository is blocked on another repository, and a stop at its current task keeps it from relaunching by itself)
    ['round', true, true, false, 'waiting', stop],
    // A launch task that is not "" and has no row cannot leave the repository done (R8.1: the unfinished task is built first); a launch task "" is recorded.
    ['round', true, true, false, 'done', impossible],
    // R6.1: the status could not be read, so the stop holds until it is read again.
    ['round', true, true, false, 'unknown', held],
  ];

  const label = (f: Facts) =>
    `${f.kind} cancelled=${f.cancelled} failed=${f.failed} recorded=${f.recorded} stateAfter=${f.stateAfter}`;
  const factsOf = ([kind, cancelled, failed, recorded, stateAfter]: (typeof cases)[number]): Facts => ({ kind, cancelled, failed, recorded, stateAfter });

  it('the table has one row for every combination of the facts', () => {
    expect(cases).toHaveLength(64);
    expect(new Set(cases.map((c) => label(factsOf(c)))).size).toBe(64);
    expect(OUTCOME_RULES.size).toBe(64);
  });

  it.each(cases.map((c) => [label(factsOf(c)), c] as const))('%s', (_name, c) => {
    const want = c[5];
    if (want === impossible) expect(() => runOutcome(factsOf(c))).toThrow();
    else expect(runOutcome(factsOf(c))).toEqual(want);
  });
});

describe('BuildDriver outcomes', () => {
  it('cancelling a round on a finished repository stops it with Continue, never finishing or reviewing (B1)', async () => {
    const w = world([{ id: 'T1', repo: 'api' }, { id: 'T2', repo: 'app' }], ['T1', 'T2']);
    await w.driver.begin(3600, { repo: 'app', instructions: 'rename it' });
    await flush();
    w.driver.cancel('app');
    await w.of('app')[0].end([], { exit: 130 });
    expect(w.driver.stopped().get('app')?.reason).toBe(stopMessage(130, null));
    expect(w.driver.phase()).toBe('stopped');
    expect(w.log).toEqual(['app']);
    expect(w.driver.round()).not.toBeNull();
    await w.driver.continueRepo('app');
    await flush();
    expect(w.of('app')).toHaveLength(2);
    expect(w.of('app')[1].opts.instructions).toBe('rename it');
  });

  it('a cancel that reaches a repository with no run going does not mark its next run cancelled (B7)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'api', dependsOn: ['T1'] },
      { id: 'T3', repo: 'api' },
    ]);
    await w.driver.begin(3600);
    await flush();
    expect(w.log).toEqual(['app']);
    w.driver.cancel('api');
    await w.of('app')[0].end(['T1']);
    expect(w.log).toEqual(['app', 'api']);
    expect(w.of('api')[0].opts.signal.aborted).toBe(false);
    await w.of('api')[0].end(['T2']);
    expect(w.driver.stopped().size).toBe(0);
    expect(w.log).toEqual(['app', 'api', 'api']);
  });

  it('a round that blocks on another repository keeps its instructions for the relaunch (R6.2)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'api' },
      { id: 'T3', repo: 'app', dependsOn: ['T2'] },
    ]);
    await w.driver.begin(3600, { repo: 'app', instructions: 'another round' });
    await flush();
    expect(w.of('app')[0].opts.instructions).toBe('another round');
    await w.of('app')[0].end(['T1']);
    expect(w.driver.waiting().map((x) => x.repo)).toEqual(['app']);
    expect(w.driver.round()).not.toBeNull();
    expect(w.of('app')).toHaveLength(1);
    await w.of('api')[0].end(['T2']);
    await flush();
    expect(w.of('app')).toHaveLength(2);
    expect(w.of('app')[1].opts.instructions).toBe('another round');
  });
});

describe('the build\'s choices', () => {
  it('runs the build starts by itself get the build\'s choices and no preview, the review included (R11.1)', async () => {
    const w = world([
      { id: 'T1', repo: 'app' },
      { id: 'T2', repo: 'api', dependsOn: ['T1'] },
    ]);
    const choices = { off: new Set(['personal:tool-server:github']) };
    await w.driver.begin(3600, undefined, choices);
    await flush();
    // The ready repository starts at once; the one that waited starts as it becomes ready; the review follows by itself.
    await w.of('app')[0].end(['T1']);
    await w.of('api')[0].end(['T2']);
    await flush();
    expect(w.log).toEqual(['app', 'api', 'review']);
    expect(w.started).toHaveLength(3);
    for (const s of w.started) expect(s.opts.choices).toBe(choices);
    // The driver's only way out to a run is `start`; no other dependency was needed to launch any of them.
    expect(Object.keys(w.started[0].opts).sort()).toEqual(['choices', 'signal', 'timeoutSecs']);
  });

  it('new choices given for a continued repository reach its next run and the review after it (R12.1)', async () => {
    const w = world([{ id: 'T1', repo: 'app' }, { id: 'T2', repo: 'api' }]);
    const first = { off: new Set(['personal:tool-server:github']) };
    await w.driver.begin(3600, undefined, first);
    await flush();
    await w.of('app')[0].end([], { exit: 1 });
    expect(w.driver.stopped().has('app')).toBe(true);
    const second = { off: new Set<string>() };
    w.driver.setChoices(second);
    await w.driver.continueRepo('app');
    await flush();
    expect(w.of('app')[1].opts.choices).toBe(second);
    await w.of('app')[1].end(['T1']);
    await w.of('api')[0].end(['T2']);
    await flush();
    expect(w.started.at(-1)!.target).toBe('review');
    expect(w.started.at(-1)!.opts.choices).toBe(second);
    // A run that was already going keeps the choices it started with.
    expect(w.of('api')[0].opts.choices).toBe(first);
  });

  it('without choices a run is given the empty set', async () => {
    const w = world([{ id: 'T1', repo: 'app' }]);
    await w.driver.begin(3600);
    await flush();
    expect([...w.of('app')[0].opts.choices.off]).toEqual([]);
  });
});
