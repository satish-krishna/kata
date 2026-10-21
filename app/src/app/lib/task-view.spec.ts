import type { ParsedTask } from '@bindings/ParsedTask';
import type { TaskStatus } from '@bindings/TaskStatus';
import { linkRequirements, neededBy, shownSections, taskRecord, withRows } from './task-view';

const plan = (id: string, dependsOn: string[], sections: ParsedTask['sections'] = []): ParsedTask => ({
  id, name: `Task ${id}`, repo: 'kata', depends_on: dependsOn, uses: [], files: [], covers: [], supports: [], sections, text: `### ${id}`, line: 1,
});
const status = (id: string, row: TaskStatus['row']): TaskStatus => ({ id, name: `Task ${id}`, repo: 'kata', dependsOn: [], text: `### ${id}`, row });

describe('withRows', () => {
  it('gives each planned task the row the build status holds for it, and none to a task it does not list', () => {
    const row = { task: 'T1', repo: 'kata', commits: ['abc1234'], departure: null };
    const got = withRows([plan('T1', []), plan('T2', ['T1']), plan('T3', [])], [status('T1', row), status('T2', null)]);
    expect(got.map((t) => [t.id, t.row])).toEqual([['T1', row], ['T2', null], ['T3', null]]);
  });
});

describe('shownSections', () => {
  it('keeps every section but Depends on, in order, with the unlabeled lead first', () => {
    const task = plan('T1', [], [
      { title: '', body: 'Read this first.' },
      { title: 'Depends on', body: 'none' },
      { title: 'Files', body: 'a.rs' },
      { title: 'Notes', body: 'careful' },
    ]);
    expect(shownSections(task).map((s) => s.title)).toEqual(['', 'Files', 'Notes']);
  });
});

describe('neededBy', () => {
  const tasks = [plan('T31', []), plan('T18', []), plan('T32', ['T18']), plan('T33', ['T18', 'T32']), plan('T34', ['T33'])];

  it('lists the tasks whose Depends on names the task, in plan order', () => {
    expect(neededBy(tasks, 'T18')).toEqual(['T32', 'T33']);
    expect(neededBy(tasks, 'T32')).toEqual(['T33']);
    expect(neededBy(tasks, 'T33')).toEqual(['T34']);
  });

  it('is empty for a task nothing depends on, or an id the plan does not have', () => {
    expect(neededBy(tasks, 'T34')).toEqual([]);
    expect(neededBy(tasks, 'T31')).toEqual([]);
    expect(neededBy(tasks, 'T99')).toEqual([]);
  });
});

describe('taskRecord', () => {
  it('reads a task with no row as not built yet', () => {
    expect(taskRecord({ row: null })).toEqual({ kind: 'unbuilt', label: 'Not built yet', text: null });
  });

  it('reads a row with no departure as built as planned', () => {
    const row = { task: 'T1', repo: 'kata', commits: ['abc1234'], departure: null };
    expect(taskRecord({ row })).toEqual({ kind: 'planned', label: 'As planned', text: null });
  });

  it('reads a row with a departure as differing from the plan, carrying the departure text', () => {
    const row = { task: 'T1', repo: 'kata', commits: ['abc1234'], departure: 'Used a Map, not an array.' };
    expect(taskRecord({ row })).toEqual({ kind: 'differs', label: 'Differs from plan', text: 'Used a Map, not an array.' });
  });
});

describe('linkRequirements', () => {
  it('turns requirement and scenario ids into links to #req-<id>', () => {
    expect(linkRequirements('covers R7.7 and supports R10')).toBe('covers [R7.7](#req-R7.7) and supports [R10](#req-R10)');
  });

  it('leaves code spans, fenced code and longer words alone', () => {
    expect(linkRequirements('`R7` is code, so is\n```\nR8\n```\nand AR9 or R9x are words')).toBe('`R7` is code, so is\n```\nR8\n```\nand AR9 or R9x are words');
  });
});
