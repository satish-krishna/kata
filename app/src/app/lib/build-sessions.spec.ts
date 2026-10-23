import type { BuildStatus } from '@bindings/BuildStatus';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import type { TaskStatus } from '@bindings/TaskStatus';
import { newlyRecorded, recordOutcome, repoSessions, sessionsFor, type Pick, type SessionRef } from './build-sessions';

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
