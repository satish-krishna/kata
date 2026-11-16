import type { TaskView } from '../lib/task-view';
import { render } from '../../testing/render';
import { TasksView } from './tasks-view';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'T1', name: 'Refuse an eleventh photo', repo: 'commerce-core', depends_on: [], uses: [], files: [], covers: [], supports: [],
  test: null, compile: null, sections: [], text: '### T1', line: 1, row: null, ...over,
});
const meta = (container: HTMLElement) => container.querySelector('.k-task__meta')?.textContent?.replace(/\s+/g, ' ').trim();

describe('TasksView meta line', () => {
  it('names the test command after the dependencies when the task has one', async () => {
    const t = task({ test: ['cargo', 'test', 't1'] });
    const { container } = await render(TasksView, { tasks: [t], picked: t });
    expect(meta(container)).toBe('T1 · commerce-core · depends on none · test: cargo test t1');
  });

  it('names the compile command too when the task has one', async () => {
    const t = task({ test: ['cargo', 'test', 't1'], compile: ['cargo', 'check'] });
    const { container } = await render(TasksView, { tasks: [t], picked: t });
    expect(meta(container)).toBe('T1 · commerce-core · depends on none · test: cargo test t1 · compile: cargo check');
  });

  it('says nothing about a command when the task has none', async () => {
    const t = task();
    const { container } = await render(TasksView, { tasks: [t], picked: t });
    expect(meta(container)).toBe('T1 · commerce-core · depends on none');
  });
});
