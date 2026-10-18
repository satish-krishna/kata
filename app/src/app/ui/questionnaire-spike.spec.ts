// SPIKE — throwaway. Answers two questions about spartan's questionnaire
// before AskPanel is ported onto it. Delete before merge.
import { Component, signal } from '@angular/core';
import { form, FormField, FormRoot } from '@angular/forms/signals';
import { HlmQuestionnaireImports } from '@spartan-ng/helm/questionnaire';
import { render } from '../../testing/render';

@Component({
  selector: 'app-spike-host',
  imports: [FormRoot, FormField, HlmQuestionnaireImports],
  template: `
    <form hlmQuestionnaire [formRoot]="f" [item]="active()">
      <fieldset hlmQuestionnaireItem name="store" required [formField]="f.store">
        <legend hlmQuestionnaireTitle>Which store?</legend>
        <div hlmQuestionnaireChoices>
          <label hlmQuestionnaireChoice value="Postgres">Postgres</label>
          <label hlmQuestionnaireChoice value="SQLite">SQLite</label>
          <input hlmQuestionnaireInput aria-label="Other" />
        </div>
      </fieldset>
      <fieldset hlmQuestionnaireItem name="extras" multiple [formField]="f.extras">
        <legend hlmQuestionnaireTitle>Which extras?</legend>
        <div hlmQuestionnaireChoices>
          <label hlmQuestionnaireChoice value="Redis">Redis</label>
          <label hlmQuestionnaireChoice value="Kafka">Kafka</label>
          <input hlmQuestionnaireInput aria-label="Other" />
        </div>
      </fieldset>
      <div hlmQuestionnaireActions>
        <button hlmQuestionnaireNext>Next</button>
        <button hlmQuestionnaireSubmit>Send</button>
      </div>
    </form>
  `,
})
class SpikeHost {
  readonly active = signal<string | null>('store');
  readonly model = signal({ store: '', extras: [] as string[] });
  readonly f = form(this.model);
}

async function mount() {
  const r = await render(SpikeHost, {});
  const host = r.fixture.componentInstance;
  const q = <T extends Element>(sel: string) => r.container.querySelector(sel) as T;
  const type = async (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await r.fixture.whenStable();
  };
  const pick = async (fieldset: string, value: string) => {
    q<HTMLInputElement>(`fieldset[name=${fieldset}] input[value="${value}"]`).click();
    await r.fixture.whenStable();
  };
  // Brain stamps its own id on the input, so find it by name instead.
  const other = (fieldset: string) => q<HTMLInputElement>(`fieldset[name=${fieldset}] input[aria-label=Other]`);
  return { ...r, host, q, type, pick, other };
}

describe('SPIKE questionnaire: does Other text reach the form value?', () => {
  it('single select: typed Other text becomes the value and deselects the choice', async () => {
    const m = await mount();
    await m.pick('store', 'Postgres');
    expect(m.host.model().store).toBe('Postgres');
    await m.type(m.other('store'), '  DuckDB  ');
    expect(m.host.model().store).toBe('DuckDB');
  });

  it('single select: clearing Other leaves no answer (empty Other never sends)', async () => {
    const m = await mount();
    await m.type(m.other('store'), 'DuckDB');
    await m.type(m.other('store'), '   ');
    expect(m.host.model().store).toBe('');
  });

  it('multi select: picked choices plus Other text arrive as one list', async () => {
    const m = await mount();
    m.host.active.set('extras');
    await m.fixture.whenStable();
    await m.pick('extras', 'Redis');
    await m.pick('extras', 'Kafka');
    await m.type(m.other('extras'), 'NATS');
    expect(m.host.model().extras).toEqual(['Redis', 'Kafka', 'NATS']);
  });
});

describe('SPIKE questionnaire: can it render a settled ask?', () => {
  it('shows only the active item; the rest are hidden and inert', async () => {
    const m = await mount();
    const [store, extras] = Array.from(m.container.querySelectorAll('fieldset'));
    expect(store.hasAttribute('hidden')).toBe(false);
    expect(extras.hasAttribute('hidden')).toBe(true);
    expect(extras.hasAttribute('inert')).toBe(true);
  });

  it('writing a multi value back drops the Other text', async () => {
    const m = await mount();
    m.host.active.set('extras');
    await m.fixture.whenStable();
    await m.pick('extras', 'Redis');
    await m.type(m.other('extras'), 'NATS');
    expect(m.host.model().extras).toEqual(['Redis', 'NATS']);
    m.host.model.set({ store: '', extras: ['Redis', 'NATS'] });
    await m.fixture.whenStable();
    expect(m.other('extras').value).toBe('');
  });
});
