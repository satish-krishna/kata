import { render } from '../../testing/render';
import type { Question } from '../lib/events';
import { AskSummary } from './ask-summary';

const text: Question = { kind: 'text', header: 'Name', question: 'What name?' };
const select: Question = {
  kind: 'select',
  header: 'Store',
  question: 'Which store?',
  multi_select: true,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
};

const mount = (questions: Question[], answers: string[][]) => render(AskSummary, { questions, answers });

describe('AskSummary', () => {
  it('shows a text answer', async () => {
    const { container } = await mount([text], [['done']]);
    expect(container.querySelector('.k-ask__answer')?.textContent?.trim()).toBe('done');
  });

  it('shows (no answer) for an empty text answer', async () => {
    const { container } = await mount([text], [['']]);
    expect(container.querySelector('.k-ask__answer--empty')?.textContent?.trim()).toBe('(no answer)');
  });

  it('lists listed choices and marks typed ones as Other', async () => {
    const { container } = await mount([select], [['SQLite', 'DuckDB']]);
    const t = container.textContent ?? '';
    expect(t).toContain('SQLite');
    expect(t).not.toContain('Postgres');
    expect(t).toMatch(/Other\s*DuckDB/);
    expect(container.querySelector('.k-ask__other-answer')?.textContent?.trim()).toBe('DuckDB');
  });

  it('shows (skipped) for a select with no answer', async () => {
    const { container } = await mount([select], [[]]);
    expect(container.textContent).toContain('(skipped)');
  });

  it('survives answers shorter than questions', async () => {
    const { container } = await mount([text, select], [['x']]);
    expect(container.querySelectorAll('.k-ask__q').length).toBe(2);
    expect(container.textContent).toContain('(skipped)');
  });

  it('survives answers shorter than questions for text', async () => {
    const { container } = await mount([text, text], [['x']]);
    expect(container.querySelectorAll('.k-ask__q').length).toBe(2);
    expect(container.querySelector('.k-ask__answer--empty')?.textContent?.trim()).toBe('(no answer)');
  });

  it('renders no form controls', async () => {
    const { container } = await mount([text, select], [['x'], ['SQLite', 'Other']]);
    expect(container.querySelector('input, button, textarea, form')).toBeNull();
  });
});
