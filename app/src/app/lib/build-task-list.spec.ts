import { filterCounts, reviewRows, taskList, type TaskLine } from './build-task-list';
import type { Finding } from './sdlc';
import { groupFindings } from './sdlc-findings';

const DONE = { tone: 'success', label: 'Done' } as const;
const RUNNING = { tone: 'success', label: 'Running' } as const;
const NOT_STARTED = { tone: 'idle', label: 'Not started' } as const;

const line = (id: string, finished: boolean, departure: string | null = null): TaskLine => ({
  id,
  name: `Task ${id}`,
  status: finished ? DONE : id === 'T6' ? RUNNING : NOT_STARTED,
  finished,
  departure,
});

// T1..T5 finished (T2 and T4 departed), T6 running, T7 and T8 not started.
const repo = (): TaskLine[] => [
  line('T1', true),
  line('T2', true, 'moved'),
  line('T3', true),
  line('T4', true, 'dropped'),
  line('T5', true),
  line('T6', false),
  line('T7', false),
  line('T8', false),
];

const ids = (v: ReturnType<typeof taskList>) => v.rows.map((r) => r.line.id);

describe('taskList', () => {
  it('all, some finished, closed: folds the finished and lists the unfinished', () => {
    const v = taskList(repo(), 'all', false, null);
    expect(v.fold).toEqual({ range: 'T1–T5', done: 5, departed: 2, open: false });
    expect(ids(v)).toEqual(['T6', 'T7', 'T8']);
    expect(v.rows.every((r) => !r.showDeparture)).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('all, some finished, picked task is among the finished: fold is open', () => {
    const v = taskList(repo(), 'all', false, 'T3');
    expect(v.fold?.open).toBe(true);
    expect(ids(v)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  });

  it('all, some finished, opened by the engineer: finished then unfinished', () => {
    const v = taskList(repo(), 'all', true, 'T7');
    expect(v.fold).toEqual({ range: 'T1–T5', done: 5, departed: 2, open: true });
    expect(ids(v)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
    expect(v.rows.every((r) => !r.showDeparture)).toBe(true);
  });

  it('all, a picked unfinished task does not open the fold', () => {
    const v = taskList(repo(), 'all', false, 'T7');
    expect(v.fold?.open).toBe(false);
    expect(ids(v)).toEqual(['T6', 'T7', 'T8']);
  });

  it('all, none finished: no fold and every task', () => {
    const tasks = [line('T1', false), line('T2', false)];
    const v = taskList(tasks, 'all', false, null);
    expect(v.fold).toBeNull();
    expect(ids(v)).toEqual(['T1', 'T2']);
    expect(v.empty).toBeNull();
  });

  it('open: the unfinished tasks and no fold', () => {
    const v = taskList(repo(), 'open', false, null);
    expect(v.fold).toBeNull();
    expect(ids(v)).toEqual(['T6', 'T7', 'T8']);
    expect(v.rows.every((r) => !r.showDeparture)).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('open: says "Nothing open." when none are unfinished', () => {
    const v = taskList([line('T1', true), line('T2', true)], 'open', false, null);
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe('Nothing open.');
  });

  it('departed: the finished tasks with a departure, shown with it', () => {
    const v = taskList(repo(), 'departed', false, null);
    expect(v.fold).toBeNull();
    expect(ids(v)).toEqual(['T2', 'T4']);
    expect(v.rows.every((r) => r.showDeparture)).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('done: the finished tasks, without departures shown', () => {
    const v = taskList(repo(), 'done', false, null);
    expect(v.fold).toBeNull();
    expect(ids(v)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(v.rows.every((r) => !r.showDeparture)).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('a single finished task reads its own id as the range', () => {
    const v = taskList([line('T1', true), line('T2', false)], 'all', false, null);
    expect(v.fold).toEqual({ range: 'T1', done: 1, departed: 0, open: false });
  });

  describe('R1.3 of 7 tasks finished', () => {
    const seven = (finished: number) => Array.from({ length: 7 }, (_, i) => line(`T${i + 1}`, i < finished));

    it('0 finished: no fold and 7 rows', () => {
      const v = taskList(seven(0), 'all', false, null);
      expect(v.fold).toBeNull();
      expect(ids(v)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    });

    it('4 finished: fold of 4 and 3 rows', () => {
      const v = taskList(seven(4), 'all', false, null);
      expect(v.fold).toEqual({ range: 'T1–T4', done: 4, departed: 0, open: false });
      expect(ids(v)).toEqual(['T5', 'T6', 'T7']);
    });

    it('7 finished: fold of 7 and no rows', () => {
      const v = taskList(seven(7), 'all', false, null);
      expect(v.fold).toEqual({ range: 'T1–T7', done: 7, departed: 0, open: false });
      expect(v.rows).toEqual([]);
    });
  });
});

describe('filterCounts', () => {
  // 15 tasks over two repositories: 9 finished, 5 of them departed, 6 unfinished.
  const first: TaskLine[] = [
    line('T1', true, 'a'),
    line('T2', true, 'b'),
    line('T3', true),
    line('T4', true),
    line('T5', true, 'c'),
    line('T6', false),
    line('T7', false),
    line('T8', false),
  ];
  const second: TaskLine[] = [
    line('T1', true, 'd'),
    line('T2', true, 'e'),
    line('T3', true),
    line('T4', true),
    line('T5', false),
    line('T6', false),
    line('T7', false),
  ];

  it('counts every repository together', () => {
    expect(filterCounts([...first, ...second])).toEqual({ all: 15, open: 6, departed: 5, done: 9 });
  });

  it('All: the fold per repository hides the finished tasks', () => {
    const v = taskList(first, 'all', false, null);
    expect(v.fold?.done).toBe(5);
    expect(ids(v)).toEqual(['T6', 'T7', 'T8']);
  });

  it('Open lists the 6 unfinished tasks with no fold', () => {
    const a = taskList(first, 'open', false, null);
    const b = taskList(second, 'open', false, null);
    expect(a.fold).toBeNull();
    expect(b.fold).toBeNull();
    expect([...ids(a), ...ids(b)]).toEqual(['T6', 'T7', 'T8', 'T5', 'T6', 'T7']);
  });

  it('Departed lists the 5 departed tasks with their departures', () => {
    const a = taskList(first, 'departed', false, null);
    const b = taskList(second, 'departed', false, null);
    expect([...ids(a), ...ids(b)]).toEqual(['T1', 'T2', 'T5', 'T1', 'T2']);
    expect([...a.rows, ...b.rows].every((r) => r.showDeparture)).toBe(true);
  });

  it('Done lists the 9 finished tasks', () => {
    const a = taskList(first, 'done', false, null);
    const b = taskList(second, 'done', false, null);
    expect([...ids(a), ...ids(b)]).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T1', 'T2', 'T3', 'T4']);
  });
});

const f = (id: string, severity: Finding['severity'], repo: string | undefined, text = `Finding ${id}.`): Finding => ({
  id,
  severity,
  text,
  ...(repo === undefined ? {} : { repo }),
});

// F1 high and F5 high; F2, F3, F6 and F8 medium; F4 and F7 low. F8 names no repository.
const REVIEW: Finding[] = [
  f('F1', 'high', 'catalog-api'),
  f('F5', 'high', 'storefront-web'),
  f('F2', 'medium', 'catalog-api'),
  f('F3', 'medium', 'catalog-api'),
  f('F6', 'medium', 'storefront-web'),
  f('F8', 'medium', undefined),
  f('F4', 'low', 'catalog-api'),
  f('F7', 'low', 'storefront-web'),
];
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('reviewRows', () => {
  const view = () => reviewRows(groupFindings(REVIEW, ['catalog-api', 'storefront-web']), REVIEW);

  it('counts the severities present, most serious first, and the total (R4.1)', () => {
    expect(view().counts).toEqual([
      { severity: 'high', n: 2 },
      { severity: 'medium', n: 4 },
      { severity: 'low', n: 2 },
    ]);
    expect(view().total).toBe(8);
  });

  it('keeps the group order, with the findings naming no repository last (R4.5)', () => {
    expect(view().groups.map((g) => g.repo)).toEqual(['catalog-api', 'storefront-web', null]);
    expect(keys(view().groups[2].rows)).toEqual(['F8']);
  });

  it('lists a group high first, then medium, and sets the low findings apart (R4.1, R4.2)', () => {
    const catalog = view().groups[0];
    expect(keys(catalog.rows)).toEqual(['F1', 'F2', 'F3']);
    expect(keys(catalog.low)).toEqual(['F4']);
  });

  it('sorts critical first and a finding with no severity after the medium ones, stable within a severity', () => {
    const list = [f('A', null, 'r'), f('B', 'medium', 'r'), f('C', 'critical', 'r'), f('D', 'medium', 'r'), f('E', 'high', 'r')];
    const v = reviewRows(groupFindings(list, ['r']), list);
    expect(keys(v.groups[0].rows)).toEqual(['C', 'E', 'B', 'D', 'A']);
    expect(v.counts).toEqual([
      { severity: 'critical', n: 1 },
      { severity: 'high', n: 1 },
      { severity: 'medium', n: 2 },
    ]);
    expect(v.total).toBe(5);
  });

  it('summarizes with the first sentence, or the whole text when there is none', () => {
    const list: Finding[] = [
      { id: 'A', severity: 'high', text: 'The limit is wrong. It also loops forever.' },
      { id: 'B', severity: 'high', text: 'No full stop here' },
      { id: 'C', severity: 'high', text: 'First line\nsecond line' },
    ];
    const rows = reviewRows(groupFindings(list, []), list).groups[0].rows;
    expect(rows.map((r) => r.summary)).toEqual(['The limit is wrong.', 'No full stop here', 'First line']);
  });

  it('keys a finding by its id, else by its place in the review as #<n>', () => {
    const list: Finding[] = [
      { severity: 'low', text: 'one', repo: 'b' },
      { severity: 'high', text: 'two', repo: 'a' },
      { id: 'F9', severity: 'high', text: 'three', repo: 'a' },
    ];
    const v = reviewRows(groupFindings(list, ['a', 'b']), list);
    expect(keys(v.groups[0].rows)).toEqual(['#2', 'F9']);
    expect(keys(v.groups[1].low)).toEqual(['#1']);
  });

  it('an empty review has no counts and no rows', () => {
    expect(reviewRows([], [])).toEqual({ counts: [], total: 0, groups: [] });
  });
});
