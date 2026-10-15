import { render } from '../../testing/render';
import { Toolbar } from './toolbar';

const base = { name: 'demo', dirty: false };
const btn = (c: HTMLElement, name: RegExp) =>
  Array.from(c.querySelectorAll('button')).find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!;
const labeled = (c: HTMLElement, label: string) => c.querySelector(`button[aria-label="${label}"]`);

describe('Toolbar', () => {
  it('links to the library route', async () => {
    const { container } = await render(Toolbar, base);
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/library');
    expect(container.querySelector('a')!.textContent).toContain('Library');
  });

  it('shows Run, not Cancel, when not running', async () => {
    const { container } = await render(Toolbar, { ...base, running: false });
    expect(btn(container, /run/i)).toBeTruthy();
    expect(btn(container, /^cancel/i)).toBeUndefined();
  });

  it('swaps Run for Cancel when running', async () => {
    const { container } = await render(Toolbar, { ...base, running: true });
    expect(btn(container, /^cancel/i)).toBeTruthy();
    expect(btn(container, /^run/i)).toBeUndefined();
  });

  it('disables Run when canRun is false', async () => {
    const { container } = await render(Toolbar, { ...base, canRun: false });
    expect(btn(container, /^run/i).disabled).toBe(true);
  });

  it('emits run when Run is clicked, and keeps exactly one primary button', async () => {
    const { fixture, container } = await render(Toolbar, base);
    let n = 0;
    fixture.componentInstance.run.subscribe(() => n++);
    btn(container, /^run/i).click();
    expect(n).toBe(1);
    expect(container.querySelectorAll('.k-btn--primary').length).toBe(1);
  });

  it('keeps the icon-only buttons labeled for the capture selectors', async () => {
    const { container } = await render(Toolbar, base);
    for (const l of ['New spec', 'Open spec', 'Save spec', 'Export bundle']) {
      const b = labeled(container, l)!;
      expect(b.classList.contains('k-iconbtn')).toBe(true);
    }
    expect(labeled(container, 'Save spec')!.getAttribute('title')).toBe('Save  Ctrl+S');
  });

  it('emits newSpec, openSpec, save and exportBundle', async () => {
    const { fixture, container } = await render(Toolbar, base);
    const got: string[] = [];
    const c = fixture.componentInstance;
    c.newSpec.subscribe(() => got.push('new'));
    c.openSpec.subscribe(() => got.push('open'));
    c.save.subscribe(() => got.push('save'));
    c.exportBundle.subscribe(() => got.push('export'));
    for (const l of ['New spec', 'Open spec', 'Save spec', 'Export bundle']) (labeled(container, l) as HTMLElement).click();
    expect(got).toEqual(['new', 'open', 'save', 'export']);
  });

  it('shows the dirty state and writes the spec name back through the model', async () => {
    const { fixture, container } = await render(Toolbar, { ...base, dirty: true });
    expect(container.querySelector('.wb-dirty--on')!.textContent).toContain('unsaved');
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Spec name"]')!;
    expect(input.value).toBe('demo');
    input.value = 'renamed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.name()).toBe('renamed');
  });
});
