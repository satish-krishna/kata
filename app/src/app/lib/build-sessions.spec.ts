import type { BuildStatus } from '@bindings/BuildStatus';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { BuildStage } from './build-stage';
import { activityFor, newlyRecorded, recordOutcome, repoSessions, sessionsFor, type ActivityInput, type Pick, type SessionRef } from './build-sessions';

const scope = { workspaceId: 'w1', system: 'shop', change: 'c1' };
const link = (stage: string, runId: string, startedAt: number, over: Partial<RunLink> = {}): RunLink => ({
  workspace_id: 'w1',
  system: 'shop',
  change: 'c1',
  stage,
  run_id: runId,
  started_at: startedAt,
  ...over,
});

describe('repoSessions', () => {
  it("groups this change's build and review runs by repository, oldest first", () => {
    const links = [
      link('build:api', 'a2', 30),
      link('build:api', 'a1', 10),
      link('build:web', 'w1', 20),
      link('review', 'r2', 50),
      link('review', 'r1', 40),
      link('spec', 's1', 5),
      link('plan', 'p1', 6),
      link('build:api', 'other-ws', 1, { workspace_id: 'w2' }),
      link('build:api', 'other-sys', 2, { system: 'blog' }),
      link('build:api', 'other-change', 3, { change: 'c2' }),
    ];
    const got = repoSessions(links, scope);
    expect([...got.keys()].sort()).toEqual(['api', 'review', 'web']);
    expect(got.get('api')!.map((l) => l.run_id)).toEqual(['a1', 'a2']);
    expect(got.get('web')!.map((l) => l.run_id)).toEqual(['w1']);
    expect(got.get('review')!.map((l) => l.run_id)).toEqual(['r1', 'r2']);
  });
});

const task = (id: string, repo: string, built: boolean): TaskStatus => ({
  id,
  name: id,
  repo,
  dependsOn: [],
  text: '',
  row: built ? { task: id, repo, commits: [], departure: null } : null,
});
const status = (tasks: TaskStatus[]): BuildStatus => ({ tasks, repos: [], departures: [], hasTasks: true, problems: [], logLayouts: [] });

describe('newlyRecorded', () => {
  it("lists the repository's tasks that gained a row", () => {
    const before = status([task('T1', 'api', true), task('T2', 'api', false), task('T3', 'api', false), task('T4', 'web', false)]);
    const after = status([task('T1', 'api', true), task('T2', 'api', true), task('T3', 'api', true), task('T4', 'web', true)]);
    expect(newlyRecorded(before, after, 'api')).toEqual(['T2', 'T3']);
    expect(newlyRecorded(before, after, 'web')).toEqual(['T4']);
    expect(newlyRecorded(after, after, 'api')).toEqual([]);
    expect(newlyRecorded(before, before, 'api')).toEqual([]);
  });
});

describe('recordOutcome', () => {
  const record = (over: Partial<RunRecord>): RunRecord => ({ id: 'r', kata: 'k', started_at: 1, isolation: 'none', ...over });
  it("words an earlier run's ending", () => {
    expect(recordOutcome(null)).toBe('Outcome not recorded');
    expect(recordOutcome(record({ exit: 0, turns: 12, cost_usd: 1.5 }))).toBe('Completed · exit 0 · 12 turns · $1.50');
    expect(recordOutcome(record({ exit: 0, turns: 3 }))).toBe('Completed · exit 0 · 3 turns');
    expect(recordOutcome(record({ exit: 125, turns: 40, cost_usd: 0 }))).toBe('Stopped · exit 125 · 40 turns · $0.00');
    expect(recordOutcome(record({ exit: 1, turns: 2, cost_usd: 0.126 }))).toBe('Error · exit 1 · 2 turns · $0.13');
    expect(recordOutcome(record({}))).toBe('Error');
  });
});

describe('sessionsFor', () => {
  const s = (runId: string, startedAt: number): SessionRef => ({ runId, startedAt });
  const sessions = new Map<string, SessionRef[]>([
    ['api', [s('a1', 10), s('a2', 30)]],
    ['web', [s('w1', 20)]],
    ['review', [s('r1', 40), s('r2', 50)]],
  ]);
  const tasks = [task('T1', 'api', true), task('T2', 'api', false), task('T3', 'api', true), task('T4', 'api', true), task('T5', 'web', true)];
  const tl = (taskId: string, runId: string, repo = 'api'): TaskLink => ({
    workspace_id: 'w1',
    system: 'shop',
    change: 'c1',
    repo,
    task: taskId,
    run_id: runId,
  });
  const links = [tl('T1', 'a1'), tl('T3', 'ghost'), tl('T5', 'w1', 'web')];
  const apiAll = [s('a1', 10), s('a2', 30)];

  const cases: { name: string; pick: Pick; links: TaskLink[]; sessions: SessionRef[]; unknown: boolean }[] = [
    { name: 'repo: every session of it', pick: { kind: 'repo', repo: 'api' }, links, sessions: apiAll, unknown: false },
    { name: 'repo without sessions: none', pick: { kind: 'repo', repo: 'db' }, links, sessions: [], unknown: false },
    { name: 'review: every review session', pick: { kind: 'review' }, links, sessions: [s('r1', 40), s('r2', 50)], unknown: false },
    { name: 'task not built: every session of its repo', pick: { kind: 'task', task: 'T2' }, links, sessions: apiAll, unknown: false },
    { name: 'task not built with a link: still every session', pick: { kind: 'task', task: 'T2' }, links: [tl('T2', 'a1')], sessions: apiAll, unknown: false },
    { name: 'task built, linked to a session: that one', pick: { kind: 'task', task: 'T1' }, links, sessions: [s('a1', 10)], unknown: false },
    { name: 'task built, linked outside its repo sessions: all, unknown', pick: { kind: 'task', task: 'T3' }, links, sessions: apiAll, unknown: true },
    { name: 'task built, no link: all, unknown', pick: { kind: 'task', task: 'T4' }, links, sessions: apiAll, unknown: true },
    { name: 'several links: the run that started last', pick: { kind: 'task', task: 'T1' }, links: [tl('T1', 'a2'), tl('T1', 'a1')], sessions: [s('a2', 30)], unknown: false },
    { name: 'several links, one unknown: the latest known one', pick: { kind: 'task', task: 'T1' }, links: [tl('T1', 'ghost'), tl('T1', 'a1')], sessions: [s('a1', 10)], unknown: false },
    { name: 'link in another repo does not count', pick: { kind: 'task', task: 'T1' }, links: [tl('T1', 'w1', 'web')], sessions: apiAll, unknown: true },
    { name: 'task of another repo', pick: { kind: 'task', task: 'T5' }, links, sessions: [s('w1', 20)], unknown: false },
    { name: 'task not in the plan: nothing, unknown', pick: { kind: 'task', task: 'T9' }, links, sessions: [], unknown: true },
  ];

  it('decides every row of the pick table', () => {
    for (const c of cases) {
      expect(sessionsFor(c.pick, tasks, sessions, c.links), c.name).toEqual({ sessions: c.sessions, unknown: c.unknown });
    }
  });
});

describe('activityFor', () => {
  const scope = { workspaceId: 'w1', system: 'shop', change: 'c1' };
  const api: Pick = { kind: 'repo', repo: 'api' };
  const input = (over: Partial<ActivityInput> = {}): ActivityInput => ({
    stage: 'running',
    chosen: null,
    firstRepo: 'api',
    status: status([task('T1', 'api', false)]),
    live: [],
    taskLinks: [],
    scope,
    ...over,
  });
  const chosen = (pick: Pick, stage: BuildStage, goTo: { repo: string; n: number } | null = null) => ({ pick, stage, seq: 1, goTo });

  it('has no pick before the build log was read', () => {
    expect(activityFor(input({ status: null })).pick).toBeNull();
    expect(activityFor(input({ status: null, chosen: chosen(api, 'running') })).pick).toBeNull();
  });

  it('defaults to the first repository while the build runs, and to the review when there is no repository', () => {
    expect(activityFor(input()).pick).toEqual(api);
    expect(activityFor(input({ firstRepo: null })).pick).toEqual({ kind: 'review' });
  });

  it('defaults to the review at reviewing, review-finished and done', () => {
    for (const stage of ['reviewing', 'review-finished', 'done'] as const) {
      expect(activityFor(input({ stage })).pick, stage).toEqual({ kind: 'review' });
    }
  });

  it('keeps what the engineer picked while the build runs', () => {
    for (const stage of ['running', 'running-one-stopped', 'stopped', 'cancelled'] as const) {
      expect(activityFor(input({ stage, chosen: chosen({ kind: 'task', task: 'T1' }, stage) })).pick, stage).toEqual({ kind: 'task', task: 'T1' });
    }
  });

  it('drops a pick made at an earlier stage when the stage moves to the review, but keeps one made at this stage', () => {
    for (const stage of ['reviewing', 'review-finished', 'done'] as const) {
      expect(activityFor(input({ stage, chosen: chosen(api, 'running') })).pick, stage).toEqual({ kind: 'review' });
      expect(activityFor(input({ stage, chosen: chosen(api, stage) })).pick, stage).toEqual(api);
    }
  });

  it('carries a Go to as the pick and the focus request while it stands, and drops both with it', () => {
    const goTo = { repo: 'web', n: 3 };
    const got = activityFor(input({ chosen: chosen({ kind: 'repo', repo: 'web' }, 'running', goTo) }));
    expect(got.pick).toEqual({ kind: 'repo', repo: 'web' });
    expect(got.focus).toBe(goTo);
    expect(activityFor(input({ stage: 'reviewing', chosen: chosen({ kind: 'repo', repo: 'web' }, 'running', goTo) })).focus).toBeNull();
    expect(activityFor(input({ chosen: chosen(api, 'running') })).focus).toBeNull();
  });

  describe('the tasks a live run recorded', () => {
    const before = status([task('T1', 'api', false), task('T2', 'api', false)]);
    const now = status([task('T1', 'api', true), task('T2', 'api', false), task('T5', 'web', true)]);
    const live = [{ runId: 'a2', repo: 'api', before }];
    const tl = (taskId: string, runId: string, repo = 'api'): TaskLink => ({ workspace_id: 'w1', system: 'shop', change: 'c1', repo, task: taskId, run_id: runId });

    it('links a task recorded while its repository run is live to that run, at once', () => {
      const got = activityFor(input({ status: now, live }));
      expect(got.newLinks).toEqual([tl('T1', 'a2')]);
      expect(got.taskLinks).toEqual([tl('T1', 'a2')]);
    });

    it('does not link a task that was already recorded when the run started, or one of another repository', () => {
      const started = status([task('T1', 'api', true), task('T2', 'api', false), task('T5', 'web', false)]);
      expect(activityFor(input({ status: now, live: [{ runId: 'a2', repo: 'api', before: started }] })).newLinks).toEqual([]);
    });

    it('does not link a task twice to the same run', () => {
      const got = activityFor(input({ status: now, live, taskLinks: [tl('T1', 'a2')] }));
      expect(got.newLinks).toEqual([]);
      expect(got.taskLinks).toEqual([tl('T1', 'a2')]);
    });

    it('links nothing without a live run or without the change in scope', () => {
      expect(activityFor(input({ status: now })).newLinks).toEqual([]);
      expect(activityFor(input({ status: now, live, scope: null })).newLinks).toEqual([]);
    });
  });
});
