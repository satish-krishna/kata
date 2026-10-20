import type { BuildStatus } from '@bindings/BuildStatus';
import type { RepoState } from '@bindings/RepoState';
import { stopMessage } from '../../lib/sdlc';
import { BuildDriver, type RunEnd, type RunOptions, type RunTarget } from './build-driver';

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
    return { tasks, repos: states, departures: [], hasTasks: tasks.length > 0 };
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
});
