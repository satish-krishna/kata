import type { TaskStatus } from '@bindings/TaskStatus';
import { render } from '../../testing/render';
import { BuildLogTable } from './build-log-table';

const task = (id: string, repo: string, dependsOn: string[], row: TaskStatus['row'] = null): TaskStatus =>
  ({ id, name: `Task ${id}`, repo, dependsOn, text: `### ${id}`, row });

const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('tbody tr')).map((r) => text(r));

describe('BuildLogTable', () => {
  it('lists tasks with repository, dependencies, commits and departure', async () => {
    const { container } = await render(BuildLogTable, {
      tasks: [
        task('T1', 'claims-core', [], { task: 'T1', repo: 'claims-core', commits: ['a111111', 'b222222'], departure: null }),
        task('T2', 'customer-portal', ['T1'], { task: 'T2', repo: 'customer-portal', commits: ['c333333'], departure: 'used the shared client' }),
        task('T3', 'claims-core', ['T1', 'T2']),
      ],
    });
    expect(text(container.querySelector('h2')!)).toBe('Build log');
    const got = rows(container);
    expect(got.length).toBe(3);
    expect(got[0]).toContain('T1');
    expect(got[0]).toContain('claims-core');
    expect(got[0]).toContain('a111111');
    expect(got[0]).toContain('b222222');
    expect(got[1]).toContain('T2');
    expect(got[1]).toContain('customer-portal');
    expect(got[1]).toContain('T1');
    expect(got[1]).toContain('c333333');
    expect(got[1]).toContain('used the shared client');
    expect(got[2]).toContain('T1, T2');
    expect(got[2]).not.toContain('a111111');
    expect(container.querySelector('tbody tr td:first-child')!.classList.contains('k-mono')).toBe(true);
    expect(text(container)).not.toContain('No tasks built yet.');
  });

  it('says so when no task has a row', async () => {
    const { container } = await render(BuildLogTable, { tasks: [task('T1', 'claims-core', []), task('T2', 'claims-core', ['T1'])] });
    expect(rows(container).length).toBe(2);
    expect(text(container)).toContain('No tasks built yet.');
  });

  it('says so when the plan has no tasks', async () => {
    const { container } = await render(BuildLogTable, { tasks: [] });
    expect(rows(container).length).toBe(0);
    expect(text(container)).toContain('No tasks built yet.');
  });
});
