import { render } from '../../testing/render';
import type { AskRecord, Question } from '../lib/events';
import { AskPanel } from './ask-panel';

const single: Question = {
  kind: 'select',
  header: 'Store',
  question: 'Which store?',
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
};
const multi: Question = { ...single, header: 'Stores', multi_select: true };

function rec(questions: Question[], answers: string[][] | null = null): AskRecord {
  return { id: 'a1', questions, answers, at: 0 };
}

async function mount(questions: Question[], answers: string[][] | null = null) {
  const r = await render(AskPanel, { ask: rec(questions, answers) });
  const answer = vi.fn();
  r.fixture.componentInstance.answer.subscribe(answer);
  const root = r.container;
  const maybeBtn = (re: RegExp) =>
    Array.from(root.querySelectorAll('button')).find((b) => re.test(b.textContent ?? '')) ?? null;
  const btn = (re: RegExp) => maybeBtn(re)!;
  const send = () => btn(/^\s*Send answer · resume\s*$/);
  const click = async (el: HTMLElement) => {
    el.click();
    await r.fixture.whenStable();
  };
  const type = async (el: HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await r.fixture.whenStable();
  };
  const textbox = () => root.querySelector('textarea') as HTMLTextAreaElement | null;
  return { ...r, answer, btn, maybeBtn, send, click, type, textbox };
}

describe('AskPanel - Other option', () => {
  it('offers an Other row on every select question', async () => {
    const m = await mount([single]);
    expect(m.maybeBtn(/Other/)).not.toBeNull();
  });

  it('does not offer Other on a confirm question', async () => {
    const m = await mount([{ kind: 'confirm', header: 'Go', question: 'Proceed?' }]);
    expect(m.maybeBtn(/Other/)).toBeNull();
  });

  it('keeps send disabled while Other is picked but empty', async () => {
    const m = await mount([single]);
    await m.click(m.btn(/Other/));
    expect(m.send().disabled).toBe(true);
  });

  it('single-select: the typed text replaces the choice', async () => {
    const m = await mount([single]);
    await m.click(m.btn(/Postgres/));
    await m.click(m.btn(/Other/));
    await m.type(m.textbox()!, '  DuckDB  ');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['DuckDB']] });
  });

  it('single-select: picking a listed option after Other drops the typed text', async () => {
    const m = await mount([single]);
    await m.click(m.btn(/Other/));
    await m.type(m.textbox()!, 'DuckDB');
    await m.click(m.btn(/SQLite/));
    expect(m.textbox()).toBeNull();
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['SQLite']] });
  });

  it('multi-select: the typed text joins the ticked options', async () => {
    const m = await mount([multi]);
    await m.click(m.btn(/Postgres/));
    await m.click(m.btn(/Other/));
    await m.type(m.textbox()!, 'DuckDB');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['Postgres', 'DuckDB']] });
  });

  it('multi-select: typing an already-ticked label does not send it twice', async () => {
    const m = await mount([multi]);
    await m.click(m.btn(/Postgres/));
    await m.click(m.btn(/Other/));
    await m.type(m.textbox()!, 'Postgres');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['Postgres']] });
  });

  it('answered view shows a custom answer as a selected Other row', async () => {
    const m = await mount([single], [['DuckDB']]);
    expect(m.container.textContent).toContain('DuckDB');
    expect(m.btn(/Other/).classList.contains('k-ask__opt--selected')).toBe(true);
  });

  it('answered view omits the Other row when every answer was a listed option', async () => {
    const m = await mount([single], [['SQLite']]);
    expect(m.maybeBtn(/Other/)).toBeNull();
  });
});

describe('AskPanel - text and confirm', () => {
  it('sends typed text for a text question', async () => {
    const m = await mount([{ kind: 'text', header: 'Name', question: 'Name?' }]);
    expect(m.send().disabled).toBe(true);
    await m.type(m.textbox()!, 'kata');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['kata']] });
  });

  it('confirm defaults to Yes/No and selects one', async () => {
    const m = await mount([{ kind: 'confirm', header: 'Go', question: 'Proceed?' }]);
    await m.click(m.btn(/^\s*No\s*$/));
    expect(m.btn(/^\s*No\s*$/).classList.contains('k-ask__confirm-btn--selected')).toBe(true);
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['No']] });
  });

  it('shows the answered banner and hides the footer', async () => {
    const m = await mount([{ kind: 'text', header: 'Name', question: 'Name?' }], [['kata']]);
    expect(m.container.querySelector('.k-ask--answered')).not.toBeNull();
    expect(m.container.textContent).toContain('answered · run resumed');
    expect(m.container.querySelector('.k-ask__foot')).toBeNull();
  });
});

describe('AskPanel - Other autofocus', () => {
  const two: Question[] = [single, { ...single, header: 'Cache', question: 'Which cache?' }];
  const others = (root: HTMLElement) => Array.from(root.querySelectorAll('button')).filter((b) => /Other/.test(b.textContent ?? ''));
  const boxes = (root: HTMLElement) => Array.from(root.querySelectorAll('textarea'));

  it('focuses the box just opened, not the last in DOM order', async () => {
    const m = await mount(two);
    await m.click(others(m.container)[1]);
    await m.click(others(m.container)[0]);
    const [q1] = boxes(m.container);
    expect(document.activeElement).toBe(q1);
  });

  it('focuses the new box when one closes and another opens', async () => {
    const m = await mount(two);
    await m.click(others(m.container)[0]);
    await m.click(m.container.querySelectorAll('.k-ask__q')[0].querySelector('.k-ask__opt') as HTMLElement);
    await m.click(others(m.container)[1]);
    const [q2] = boxes(m.container);
    expect(boxes(m.container).length).toBe(1);
    expect(document.activeElement).toBe(q2);
  });

  it('does not move focus while typing', async () => {
    const m = await mount(two);
    await m.click(others(m.container)[0]);
    await m.click(others(m.container)[1]);
    const [q1] = boxes(m.container);
    q1.focus();
    await m.type(q1, 'abc');
    expect(document.activeElement).toBe(q1);
  });
});
