import type { RunSpec } from '@bindings/RunSpec';
import { render } from '../../testing/render';
import { seedCatalog } from '../lib/mock';
import { defaultSpec } from '../lib/spec';
import { KitChecklist } from './kit-checklist';

const names = (c: HTMLElement) => Array.from(c.querySelectorAll('.k-kit__name')).map((e) => e.textContent);

describe('KitChecklist', () => {
  it('groups and sorts skills then plugins', async () => {
    const { container } = await render(KitChecklist, { spec: defaultSpec(), entries: seedCatalog });
    expect(names(container)).toEqual(['doc-writer', 'perf-profiler', 'triage-flaky-test', 'github-tools', 'sentry']);
  });

  it('filters by name or description with the search box', async () => {
    const { container, fixture } = await render(KitChecklist, { spec: defaultSpec(), entries: seedCatalog });
    const q = container.querySelector<HTMLInputElement>('input[aria-label="Search kit"]')!;
    q.value = 'stack trace';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(names(container)).toEqual(['sentry']);
  });

  it('emits a toggled clone and never mutates the input spec', async () => {
    const spec = defaultSpec();
    const frozen = structuredClone(spec);
    const { container, fixture } = await render(KitChecklist, { spec, entries: seedCatalog });
    const emitted: RunSpec[] = [];
    fixture.componentInstance.specChange.subscribe((s) => emitted.push(s));
    container.querySelector<HTMLElement>('.k-kit [role="checkbox"]')!.click();
    await fixture.whenStable();
    expect(emitted.length).toBe(1);
    expect(emitted[0].skills).toEqual(['doc-writer']);
    expect(spec).toEqual(frozen);
  });

  it('toggling a plugin off emits a spec without it, original untouched', async () => {
    const spec = defaultSpec();
    spec.plugins['sentry'] = { mcp: null, env: [] };
    const { container, fixture } = await render(KitChecklist, { spec, entries: seedCatalog });
    const emitted: RunSpec[] = [];
    fixture.componentInstance.specChange.subscribe((s) => emitted.push(s));
    const row = Array.from(container.querySelectorAll('.k-kit')).find((r) => r.textContent!.includes('sentry'))!;
    row.querySelector<HTMLElement>('[role="checkbox"]')!.click();
    await fixture.whenStable();
    expect(emitted[0].plugins).toEqual({});
    expect(Object.keys(spec.plugins)).toEqual(['sentry']);
  });

  it('shows plugin detail and writes env passthrough names as a clone', async () => {
    const spec = defaultSpec();
    spec.plugins['github-tools'] = { mcp: true, env: [] };
    const { container, fixture } = await render(KitChecklist, { spec, entries: seedCatalog });
    expect(container.querySelector('.k-kit__provides')!.textContent).toContain('skill:pr-review');
    const emitted: RunSpec[] = [];
    fixture.componentInstance.specChange.subscribe((s) => emitted.push(s));
    const env = container.querySelector<HTMLInputElement>('.k-kit__detail input[placeholder="GITHUB_TOKEN, GH_HOST"]')!;
    env.value = 'A, B ,';
    env.dispatchEvent(new Event('change', { bubbles: true }));
    expect(emitted[0].plugins['github-tools']!.env).toEqual(['A', 'B']);
    expect(spec.plugins['github-tools']!.env).toEqual([]);
  });

  it('toggles when the row text is clicked, not just the box', async () => {
    const { container, fixture } = await render(KitChecklist, { spec: defaultSpec(), entries: seedCatalog });
    const emitted: RunSpec[] = [];
    fixture.componentInstance.specChange.subscribe((s) => emitted.push(s));
    container.querySelector<HTMLElement>('.k-kit__name')!.click();
    await fixture.whenStable();
    expect(emitted.length).toBe(1);
  });

  it('marks selected rows', async () => {
    const spec = defaultSpec();
    spec.skills = ['doc-writer'];
    const { container } = await render(KitChecklist, { spec, entries: seedCatalog });
    expect(container.querySelectorAll('.k-kit--selected').length).toBe(1);
  });
});
