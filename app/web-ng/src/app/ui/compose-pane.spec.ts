import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import { defaultSpec } from '../lib/spec';
import { seedCatalog, seedSpec } from '../lib/mock';
import { ComposePane } from './compose-pane';

/** Mount the pane over a caller-owned spec. The pane writes through the Signal Forms
 *  tree, so assertions on the stored spec read `model()`. Replaces the Svelte
 *  `spec-fixture.svelte.ts` reactive-spec helper. */
async function mount(spec: RunSpec, opts: { catalog?: CatalogEntry[]; presets?: Preset[] } = {}) {
  // form() needs an injection context, and render() configures the module itself, so build
  // the module first, make the tree inside it, then create the component directly.
  TestBed.configureTestingModule({ imports: [ComposePane] });
  const model = signal(spec);
  const tree = TestBed.runInInjectionContext(() => form(model));
  const fixture = TestBed.createComponent(ComposePane);
  fixture.componentRef.setInput('form', tree);
  fixture.componentRef.setInput('catalog', opts.catalog ?? []);
  fixture.componentRef.setInput('presets', opts.presets ?? []);
  await fixture.whenStable();
  return { fixture, container: fixture.nativeElement as HTMLElement, model };
}

function specWith(mutate: (s: RunSpec) => void = () => {}): RunSpec {
  const s = defaultSpec();
  mutate(s);
  return s;
}

const radio = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll<HTMLElement>('[role="radio"]')).find((e) => e.textContent!.trim() === name)!;
const byPlaceholder = (c: HTMLElement, p: string) =>
  Array.from(c.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).find((e) => e.placeholder === p) ?? null;
const hasCode = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('code')).some((e) => e.textContent === text);
const buttonNamed = (c: ParentNode, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent!.trim() === text)!;
const typeInto = async (
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  fixture: { whenStable(): Promise<unknown> },
) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await fixture.whenStable();
};
const numberInput = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('.k-field'))
    .find((f) => f.querySelector('.k-field__label')!.textContent!.includes(label))!
    .querySelector('input') as HTMLInputElement;

describe('ComposePane number fields (Review Focus #1)', () => {
  const cases: [string, string, (s: RunSpec) => unknown][] = [
    ['Max turns', 'leash.max_turns', (s) => s.leash.max_turns],
    ['Timeout (secs)', 'leash.timeout_secs', (s) => s.leash.timeout_secs],
    ['Max budget (USD)', 'leash.max_budget_usd', (s) => s.leash.max_budget_usd],
    ['Answer timeout', 'interactive.answer_timeout_secs', (s) => s.interactive.answer_timeout_secs],
  ];

  for (const [label, path, read] of cases) {
    it(`stores null, not 0 or NaN, when ${path} is emptied`, async () => {
      const spec = seedSpec();
      spec.leash.max_turns = 12;
      spec.leash.timeout_secs = 900;
      spec.leash.max_budget_usd = 2.5;
      spec.interactive.answer_timeout_secs = 30;
      const { container, fixture, model } = await mount(spec);
      const input = numberInput(container, label);
      expect(input.value).not.toBe('');
      await typeInto(input, '', fixture);
      expect(read(model())).toBeNull();
      expect(input.value).toBe('');
    });
  }

  it('stores the typed number', async () => {
    const { container, fixture, model } = await mount(specWith());
    await typeInto(numberInput(container, 'Max turns'), '7', fixture);
    expect(model().leash.max_turns).toBe(7);
    await typeInto(numberInput(container, 'Max budget (USD)'), '1.25', fixture);
    expect(model().leash.max_budget_usd).toBe(1.25);
  });

  it('truncates integers and rejects out-of-range values like the Svelte pane did', async () => {
    const { container, fixture, model } = await mount(specWith());
    await typeInto(numberInput(container, 'Max turns'), '3.9', fixture);
    expect(model().leash.max_turns).toBe(3);
    await typeInto(numberInput(container, 'Max turns'), '0', fixture);
    expect(model().leash.max_turns).toBeNull();
    await typeInto(numberInput(container, 'Timeout (secs)'), '0', fixture);
    expect(model().leash.timeout_secs).toBe(0);
    await typeInto(numberInput(container, 'Max budget (USD)'), '0', fixture);
    expect(model().leash.max_budget_usd).toBeNull();
  });
});

describe('ComposePane model selector', () => {
  it('shows the free-text field for a loaded pinned (custom) id', async () => {
    const { container } = await mount(specWith((s) => (s.model.id = 'claude-opus-4-8')));
    expect(byPlaceholder(container, 'claude-opus-4-8')!.value).toBe('claude-opus-4-8');
  });

  it('stays in custom mode after clearing a loaded pinned id', async () => {
    const { container, fixture, model } = await mount(specWith((s) => (s.model.id = 'claude-opus-4-8')));
    await typeInto(byPlaceholder(container, 'claude-opus-4-8')!, '', fixture);
    expect(byPlaceholder(container, 'claude-opus-4-8')).not.toBeNull();
    expect(model().model.id).toBeNull();
  });

  it('shows no free-text field for an alias id', async () => {
    const { container } = await mount(specWith((s) => (s.model.id = 'opus')));
    expect(byPlaceholder(container, 'claude-opus-4-8')).toBeNull();
  });

  it('stores an alias when its segment is picked and opens the field for custom', async () => {
    const { container, fixture, model } = await mount(specWith());
    radio(container, 'sonnet').click();
    await fixture.whenStable();
    expect(model().model.id).toBe('sonnet');
    radio(container, 'custom').click();
    await fixture.whenStable();
    expect(model().model.id).toBeNull();
    expect(byPlaceholder(container, 'claude-opus-4-8')).not.toBeNull();
  });
});

const ALLOW_PLACEHOLDER = 'Read\nGrep\nBash(git *)';

describe('ComposePane permissions: rule visibility', () => {
  it('hides the rule editors under bypass', async () => {
    const { container } = await mount(specWith());
    expect(byPlaceholder(container, ALLOW_PLACEHOLDER)).toBeNull();
  });

  it('shows the rule editors under prompt', async () => {
    const { container, fixture } = await mount(specWith());
    radio(container, 'prompt').click();
    await fixture.whenStable();
    expect(byPlaceholder(container, ALLOW_PLACEHOLDER)).not.toBeNull();
  });

  it('drops blank lines when parsing rules', async () => {
    const { container, fixture, model } = await mount(specWith((s) => (s.permissions.mode = 'prompt')));
    await typeInto(byPlaceholder(container, ALLOW_PLACEHOLDER)!, 'Read\n\n  Grep  \n', fixture);
    expect(model().permissions.allow).toEqual(['Read', 'Grep']);
  });

  it('clears entered rules when the mode flips back to bypass', async () => {
    const { container, fixture, model } = await mount(
      specWith((s) => {
        s.permissions.mode = 'prompt';
        s.permissions.allow = ['Read'];
        s.permissions.deny = ['Bash(rm *)'];
      }),
    );
    radio(container, 'bypass').click();
    await fixture.whenStable();
    expect(model().permissions.mode).toBe('bypass');
    expect(model().permissions.allow).toEqual([]);
    expect(model().permissions.deny).toEqual([]);
  });

  it('leaves rules alone when the mode is set to prompt', async () => {
    const { container, fixture, model } = await mount(
      specWith((s) => {
        s.permissions.mode = 'prompt';
        s.permissions.allow = ['Read'];
      }),
    );
    radio(container, 'prompt').click();
    await fixture.whenStable();
    expect(model().permissions.allow).toEqual(['Read']);
  });
});

const ASK_WARNING = /needs an operator/i;

describe('ComposePane permissions: the ask/interactive warning', () => {
  it('shows no warning under bypass', async () => {
    const { container } = await mount(specWith());
    expect(container.textContent).not.toMatch(ASK_WARNING);
  });

  it('warns when prompt + ask has interactive off', async () => {
    const { container, fixture } = await mount(specWith());
    radio(container, 'prompt').click();
    await fixture.whenStable();
    expect(container.textContent).toMatch(ASK_WARNING);
  });

  it('shows no warning when unmatched is deny', async () => {
    const { container, fixture } = await mount(specWith((s) => (s.permissions.mode = 'prompt')));
    radio(container, 'deny').click();
    await fixture.whenStable();
    expect(container.textContent).not.toMatch(ASK_WARNING);
  });

  it('shows no warning when interactive is already on', async () => {
    const { container } = await mount(
      specWith((s) => {
        s.permissions.mode = 'prompt';
        s.interactive.enabled = true;
      }),
    );
    expect(container.textContent).not.toMatch(ASK_WARNING);
  });

  it('enables interactive from the fix button and dismisses the warning', async () => {
    const { container, fixture, model } = await mount(specWith((s) => (s.permissions.mode = 'prompt')));
    buttonNamed(container, 'Enable interactive').click();
    await fixture.whenStable();
    expect(model().interactive.enabled).toBe(true);
    expect(container.textContent).not.toMatch(ASK_WARNING);
  });
});

describe('ComposePane permissions: auto mode', () => {
  it('offers auto as a third permission mode', async () => {
    const { container } = await mount(specWith());
    expect(radio(container, 'auto')).toBeTruthy();
  });

  it('shows the ask editor under prompt', async () => {
    const { container, fixture } = await mount(specWith());
    radio(container, 'prompt').click();
    await fixture.whenStable();
    expect(hasCode(container, 'permissions.ask')).toBe(true);
  });

  it('shows the ask editor under auto', async () => {
    const { container, fixture } = await mount(specWith());
    radio(container, 'auto').click();
    await fixture.whenStable();
    expect(hasCode(container, 'permissions.ask')).toBe(true);
  });

  it('hides the unmatched field under auto and shows it under prompt', async () => {
    const { container, fixture } = await mount(specWith());
    radio(container, 'auto').click();
    await fixture.whenStable();
    expect(hasCode(container, 'permissions.unmatched')).toBe(false);
    radio(container, 'prompt').click();
    await fixture.whenStable();
    expect(hasCode(container, 'permissions.unmatched')).toBe(true);
  });

  it('clears allow, deny, and ask when switching to bypass', async () => {
    const { container, fixture, model } = await mount(
      specWith((s) => {
        s.permissions.mode = 'prompt';
        s.permissions.allow = ['Read'];
        s.permissions.deny = ['Bash(rm *)'];
        s.permissions.ask = ['Bash(git push *)'];
      }),
    );
    radio(container, 'bypass').click();
    await fixture.whenStable();
    expect(model().permissions.mode).toBe('bypass');
    expect(model().permissions.allow).toEqual([]);
    expect(model().permissions.deny).toEqual([]);
    expect(model().permissions.ask).toEqual([]);
  });
});

describe('ComposePane interactive: the answer timeout', () => {
  it('shows the answer timeout with interactive off', async () => {
    const { container, model } = await mount(specWith((s) => (s.interactive.enabled = false)));
    expect(model().interactive.enabled).toBe(false);
    expect(container.textContent).toContain('Answer timeout');
  });
});

describe('ComposePane bindings, kit and presets', () => {
  it('binds the task textarea (rows=3) to the spec', async () => {
    const { container, fixture, model } = await mount(specWith());
    const task = container.querySelector<HTMLTextAreaElement>('textarea[rows="3"]')!;
    await typeInto(task, 'do it', fixture);
    expect(model().task).toBe('do it');
  });

  it('counts the selected kit and writes a toggle back through the form', async () => {
    const { container, fixture, model } = await mount(specWith(), { catalog: seedCatalog });
    expect(container.textContent).toContain('0 selected');
    container.querySelector<HTMLElement>('.wb-kit [role="checkbox"]')!.click();
    await fixture.whenStable();
    expect(model().skills.length + Object.keys(model().plugins).length).toBe(1);
    expect(container.textContent).toContain('1 selected');
  });

  it('inserts a preset into the context and shows the placeholder again', async () => {
    // jsdom has neither ResizeObserver (CDK overlay positioning) nor scrollIntoView (select highlight).
    Element.prototype.scrollIntoView ??= () => {};
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const { container, fixture, model } = await mount(
      specWith((s) => (s.context = 'base')),
      { presets: [{ name: 'Terse', body: 'Be terse.' }] },
    );
    const trigger = container.querySelector<HTMLElement>('button[aria-label="Insert context preset"]')!;
    expect(trigger.textContent).toContain('Insert preset…');
    trigger.click();
    await fixture.whenStable();
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('hlm-select-item')).find((i) =>
      i.textContent!.includes('Terse'),
    )!;
    item.click();
    await fixture.whenStable();
    expect(model().context).toBe('base\n\nBe terse.');
    expect(container.querySelector('.wb-presets')!.textContent).toContain('Insert preset…');
  });

  it('emits pickWorkdir and gates Save as preset on non-blank context', async () => {
    const { container, fixture, model } = await mount(specWith());
    const save = buttonNamed(container, 'Save as preset');
    expect(save.disabled).toBe(true);
    let picks = 0;
    fixture.componentInstance.pickWorkdir.subscribe(() => picks++);
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent!.includes('Browse'))!
      .click();
    expect(picks).toBe(1);
    const context = container.querySelector('.wb-presets')!.previousElementSibling as HTMLTextAreaElement;
    await typeInto(context, 'ctx', fixture);
    expect(model().context).toBe('ctx');
    expect(save.disabled).toBe(false);
  });

  it('opens the name dialog and emits savePreset with the context body', async () => {
    const { container, fixture } = await mount(specWith((s) => (s.context = 'body text')));
    const saved: { name: string; body: string }[] = [];
    fixture.componentInstance.savePreset.subscribe((p) => saved.push(p));
    buttonNamed(container, 'Save as preset').click();
    await fixture.whenStable();
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Save as preset"]')!;
    expect(input).not.toBeNull();
    await typeInto(input, 'My preset', fixture);
    buttonNamed(document.body, 'Save').click();
    await fixture.whenStable();
    expect(saved).toEqual([{ name: 'My preset', body: 'body text' }]);
  });
});
