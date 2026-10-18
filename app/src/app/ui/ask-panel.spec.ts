import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
const confirm: Question = { kind: 'confirm', header: 'Go', question: 'Proceed?' };
const text: Question = { kind: 'text', header: 'Name', question: 'Name?' };

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
  const type = async (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await r.fixture.whenStable();
  };
  const items = () => Array.from(root.querySelectorAll('fieldset'));
  const active = () => items().find((f) => !f.hasAttribute('hidden'))!;
  // Choices are located by value inside the active item; brain overwrites every id.
  const pick = async (value: string) =>
    click(Array.from(active().querySelectorAll<HTMLInputElement>('input')).find((i) => i.value === value)!);
  const free = () => active().querySelector<HTMLInputElement>('input[hlmQuestionnaireInput]');
  const press = async (el: Element, key: string) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await r.fixture.whenStable();
  };
  // The error text always renders; brain toggles `hidden`, so visibility is the hidden attribute.
  const errorEl = () => active().querySelector<HTMLElement>('[hlmQuestionnaireError]')!;
  return { ...r, answer, btn, maybeBtn, send, click, type, items, active, pick, free, press, errorEl };
}

describe('AskPanel - free text', () => {
  it('offers a free-text answer on every select question', async () => {
    const m = await mount([single]);
    expect(m.container.querySelectorAll('label[hlmQuestionnaireChoice]').length).toBe(2);
    const other = m.container.querySelector<HTMLInputElement>('input[aria-label="Other answer"]')!;
    expect(other.getAttribute('placeholder')).toBe('Other — type your own answer');
  });

  it('does not offer free text on a confirm question', async () => {
    const m = await mount([confirm]);
    expect(m.container.querySelector('input[hlmQuestionnaireInput]')).toBeNull();
  });

  it('an empty free-text answer never sends', async () => {
    const m = await mount([single]);
    await m.type(m.free()!, '   ');
    expect(m.errorEl().hasAttribute('hidden')).toBe(true);
    await m.click(m.send());
    expect(m.answer).not.toHaveBeenCalled();
    expect(m.errorEl().hasAttribute('hidden')).toBe(false);
  });

  it('single-select: typed text replaces the choice', async () => {
    const m = await mount([single]);
    await m.pick('SQLite');
    await m.type(m.free()!, 'DuckDB');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['DuckDB']] });
  });

  it('single-select: picking a listed choice after typing clears the text', async () => {
    const m = await mount([single]);
    await m.type(m.free()!, 'DuckDB');
    await m.pick('SQLite');
    expect(m.free()!.value).toBe('');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['SQLite']] });
  });

  it('multi-select: typed text joins the ticked options', async () => {
    const m = await mount([multi]);
    await m.pick('Postgres');
    await m.type(m.free()!, 'DuckDB');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['Postgres', 'DuckDB']] });
  });

  it('multi-select: a ticked label typed again is sent once', async () => {
    const m = await mount([multi]);
    await m.pick('Postgres');
    await m.type(m.free()!, 'Postgres');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['Postgres']] });
  });

  it('a select with no options offers only free text', async () => {
    const m = await mount([{ ...single, options: undefined }]);
    expect(m.container.querySelector('label[hlmQuestionnaireChoice]')).toBeNull();
    expect(m.container.querySelectorAll('input[hlmQuestionnaireInput]').length).toBe(1);
    await m.click(m.send());
    expect(m.answer).not.toHaveBeenCalled();
    await m.type(m.free()!, 'x');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['x']] });
  });

  it('labels with quotes and markup are sent exactly', async () => {
    const label = 'He said "<b>&';
    const m = await mount([{ ...single, options: [{ label }, { label: 'Other' }] }]);
    expect(m.container.querySelector('b')).toBeNull();
    expect(m.container.textContent).toContain(label);
    await m.pick(label);
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [[label]] });
  });
});

describe('AskPanel - text and confirm', () => {
  it('sends typed text for a text question', async () => {
    const m = await mount([text]);
    await m.click(m.send());
    expect(m.answer).not.toHaveBeenCalled();
    expect(m.errorEl().hasAttribute('hidden')).toBe(false);
    expect(m.errorEl().textContent?.trim()).toBe('Type an answer to continue.');
    await m.type(m.container.querySelector<HTMLInputElement>('input[aria-label="Name?"]')!, 'kata');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['kata']] });
  });

  it('confirm defaults to Yes/No', async () => {
    const m = await mount([confirm]);
    await m.pick('No');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['No']] });
  });

  it('settled: shows the answered banner and the summary, no form', async () => {
    const m = await mount([text], [['kata']]);
    expect(m.container.querySelector('.k-ask--answered')).not.toBeNull();
    expect(m.container.textContent).toContain('answered · run resumed');
    expect(m.container.querySelector('app-ask-summary')).not.toBeNull();
    expect(m.container.querySelector('form')).toBeNull();
    expect(m.container.querySelector('.k-ask__foot')).toBeNull();
  });
});

describe('AskPanel - stepping', () => {
  const two: Question[] = [single, { ...single, header: 'Cache', question: 'Which cache?' }];

  it('shows one question at a time', async () => {
    const m = await mount(two);
    const [a, b] = m.items();
    expect(a.hasAttribute('hidden')).toBe(false);
    expect(b.hasAttribute('hidden')).toBe(true);
    expect(m.container.querySelector('[hlmQuestionnaireProgress]')).not.toBeNull();
  });

  it('shows no progress for a single question', async () => {
    const m = await mount([single]);
    expect(m.container.querySelector('[hlmQuestionnaireProgress]')).toBeNull();
  });

  it('Next moves to the next question; Send appears on the last', async () => {
    const m = await mount(two);
    const visible = (re: RegExp) => !m.btn(re).hasAttribute('hidden');
    expect(visible(/Next/)).toBe(true);
    expect(visible(/Send answer/)).toBe(false);
    await m.pick('Postgres');
    await m.click(m.btn(/Next/));
    expect(m.items()[1].hasAttribute('hidden')).toBe(false);
    expect(visible(/Send answer/)).toBe(true);
  });

  it('a required question refuses Next until answered', async () => {
    const m = await mount(two);
    expect(m.errorEl().hasAttribute('hidden')).toBe(true);
    await m.click(m.btn(/Next/));
    expect(m.items()[0].hasAttribute('hidden')).toBe(false);
    expect(m.errorEl().hasAttribute('hidden')).toBe(false);
    // Skip is not offered on a required question and does nothing if clicked.
    expect(m.btn(/Skip/).hasAttribute('hidden')).toBe(true);
    await m.click(m.btn(/Skip/));
    expect(m.items()[0].hasAttribute('hidden')).toBe(false);
    expect(m.answer).not.toHaveBeenCalled();
  });

  it('an optional question can be skipped', async () => {
    const m = await mount([{ ...single, optional: true }, { ...single, header: 'Cache', question: 'Which cache?' }]);
    expect(m.btn(/Skip/).hasAttribute('hidden')).toBe(false);
    await m.click(m.btn(/Skip/));
    await m.pick('SQLite');
    await m.click(m.send());
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [[], ['SQLite']] });
  });

  it('Skip on the last optional question sends', async () => {
    const m = await mount([{ ...single, optional: true }]);
    await m.click(m.btn(/Skip/));
    await Promise.resolve();
    await m.fixture.whenStable();
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [[]] });
  });

  it('Enter in a filled answer on the last step sends', async () => {
    const m = await mount([text]);
    const input = m.container.querySelector<HTMLInputElement>('input[aria-label="Name?"]')!;
    await m.type(input, 'kata');
    await m.press(input, 'Enter');
    expect(m.answer).toHaveBeenCalledWith({ id: 'a1', answers: [['kata']] });
  });

  it('a number key picks a choice', async () => {
    const m = await mount([single]);
    await m.press(m.active(), '2');
    expect(Array.from(m.active().querySelectorAll<HTMLInputElement>('input')).find((i) => i.value === 'SQLite')!.checked).toBe(true);
  });

  it('a pending ask takes focus', async () => {
    const m = await mount([single]);
    expect(m.container.querySelector('form')!.contains(document.activeElement)).toBe(true);
  });

  it('an already-settled ask takes no focus', async () => {
    await mount([single], [['SQLite']]);
    expect(document.activeElement).toBe(document.body);
  });
});

@Component({
  selector: 'app-two-panels-host',
  imports: [AskPanel],
  template: `
    <app-ask-panel [ask]="a()" (answer)="gotA.push($event)" />
    <app-ask-panel [ask]="b()" (answer)="gotB.push($event)" />
  `,
})
class TwoPanelsHost {
  readonly a = signal({ ...rec([single]), id: 'a-id' });
  readonly b = signal({ ...rec([single]), id: 'b-id' });
  readonly gotA: unknown[] = [];
  readonly gotB: unknown[] = [];
}

describe('AskPanel - isolation', () => {
  it('two panels do not share fields', async () => {
    TestBed.configureTestingModule({ imports: [TwoPanelsHost] });
    const fixture = TestBed.createComponent(TwoPanelsHost);
    await fixture.whenStable();
    const [panelA, panelB] = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('app-ask-panel'));
    const choice = (panel: Element, value: string) =>
      Array.from(panel.querySelectorAll<HTMLInputElement>('input')).find((i) => i.value === value)!;
    expect(choice(panelB, 'Postgres')).not.toBe(choice(panelA, 'Postgres'));
    choice(panelA, 'Postgres').click();
    await fixture.whenStable();
    expect(choice(panelA, 'Postgres').checked).toBe(true);
    expect(choice(panelB, 'Postgres').checked).toBe(false);
    (panelA.querySelector('button[type=submit]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.gotA).toEqual([{ id: 'a-id', answers: [['Postgres']] }]);
    expect(fixture.componentInstance.gotB).toEqual([]);
  });
});
