import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { Toolbar } from './toolbar';

const base = { name: 'demo', dirty: false };
const routes = [provideRouter([{ path: 'library', children: [] }])];
const btn = (c: HTMLElement, name: RegExp) =>
  Array.from(c.querySelectorAll('button')).find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!;
const labeled = (c: HTMLElement, label: string) => c.querySelector(`button[aria-label="${label}"]`);

describe('Toolbar', () => {
  it('links to the library route', async () => {
    const { container } = await render(Toolbar, base, routes);
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/library');
    expect(container.querySelector('a')!.textContent).toContain('Library');
  });

  it('shows Run, not Cancel, when not running', async () => {
    const { container } = await render(Toolbar, { ...base, running: false }, routes);
    expect(btn(container, /run/i)).toBeTruthy();
    expect(btn(container, /^cancel/i)).toBeUndefined();
  });

  it('swaps Run for Cancel when running', async () => {
    const { container } = await render(Toolbar, { ...base, running: true }, routes);
    expect(btn(container, /^cancel/i)).toBeTruthy();
    expect(btn(container, /^run/i)).toBeUndefined();
  });

  it('disables Run when canRun is false', async () => {
    const { container } = await render(Toolbar, { ...base, canRun: false }, routes);
    expect(btn(container, /^run/i).disabled).toBe(true);
  });

  it('emits run when Run is clicked, and keeps exactly one primary button', async () => {
    const { fixture, container } = await render(Toolbar, base, routes);
    let n = 0;
    fixture.componentInstance.run.subscribe(() => n++);
    btn(container, /^run/i).click();
    expect(n).toBe(1);
    expect(container.querySelectorAll('.k-btn--primary').length).toBe(1);
  });

  it('keeps the icon-only buttons labeled for the capture selectors', async () => {
    const { container } = await render(Toolbar, base, routes);
    for (const l of ['New spec', 'Open spec', 'Save spec', 'Export bundle']) {
      const b = labeled(container, l)!;
      expect(b.classList.contains('k-iconbtn')).toBe(true);
    }
    expect(labeled(container, 'Save spec')!.getAttribute('title')).toBe('Save  Ctrl+S');
  });

  it('emits newSpec, openSpec, save and exportBundle', async () => {
    const { fixture, container } = await render(Toolbar, base, routes);
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
    const { fixture, container } = await render(Toolbar, { ...base, dirty: true }, routes);
    expect(container.querySelector('.wb-dirty--on')!.textContent).toContain('unsaved');
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Spec name"]')!;
    expect(input.value).toBe('demo');
    input.value = 'renamed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.name()).toBe('renamed');
  });

  it('shows a workbench mode badge that emits switchMode', async () => {
    const { fixture, container } = await render(Toolbar, base, routes);
    const badge = labeled(container, 'Switch mode (workbench)') as HTMLButtonElement;
    expect(badge.textContent?.trim()).toBe('workbench');
    let n = 0;
    fixture.componentInstance.switchMode.subscribe(() => n++);
    badge.click();
    expect(n).toBe(1);
  });

  it('disables the mode badge while running or when modeSwitchDisabled is set', async () => {
    const disabled = async (inputs: Record<string, unknown>) => {
      TestBed.resetTestingModule();
      const { container } = await render(Toolbar, { ...base, ...inputs }, routes);
      return (labeled(container, 'Switch mode (workbench)') as HTMLButtonElement).disabled;
    };
    expect(await disabled({ running: true })).toBe(true);
    expect(await disabled({ modeSwitchDisabled: true })).toBe(true);
    expect(await disabled({})).toBe(false);
  });

  it('navigates in-app on the Library link instead of reloading the document', async () => {
    const { fixture, container } = await render(Toolbar, base, routes);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/library');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    await fixture.whenStable();
    expect(ev.defaultPrevented).toBe(true);
    expect(TestBed.inject(Router).url).toBe('/library');
  });
});
