import type { ChangedFile } from '@bindings/ChangedFile';
import { render } from '../../testing/render';
import { DiffBar } from './diff-bar';

const FILE: ChangedFile = { path: 'src/store.rs', oldPath: 'src/storage.rs', status: 'renamed', binary: false, added: 3, removed: 3, uncommitted: true };
const text = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim();
const named = (c: HTMLElement, n: string) => Array.from(c.querySelectorAll('button')).find((b) => text(b) === n);

describe('DiffBar', () => {
  it('shows the status with a label, the path, the old to new names and the uncommitted tag', async () => {
    const { container } = await render(DiffBar, { file: FILE, layout: 'side', showLayout: true });
    const t = text(container);
    expect(t).toContain('Renamed');
    expect(container.querySelector('.k-status__dot')).not.toBeNull();
    expect(t).toContain('src/store.rs');
    expect(t).toContain('src/storage.rs → src/store.rs');
    expect(t).toContain('Uncommitted');
  });

  it('emits previous and next change', async () => {
    const { container, fixture } = await render(DiffBar, { file: FILE, layout: 'side', showLayout: true });
    const seen: string[] = [];
    fixture.componentInstance.previous.subscribe(() => seen.push('previous'));
    fixture.componentInstance.next.subscribe(() => seen.push('next'));
    named(container, 'Previous change')!.click();
    named(container, 'Next change')!.click();
    expect(seen).toEqual(['previous', 'next']);
  });

  it('writes the layout choice back and hides it when the layout is locked', async () => {
    const { container, fixture } = await render(DiffBar, { file: FILE, layout: 'side', showLayout: true });
    named(container, 'Inline')!.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.layout()).toBe('inline');
    fixture.componentRef.setInput('showLayout', false);
    await fixture.whenStable();
    expect(named(container, 'Inline')).toBeUndefined();
  });

  it('shows an empty bar when no file is open', async () => {
    const { container } = await render(DiffBar, { file: null, layout: 'side', showLayout: true });
    expect(text(container)).not.toContain('src/');
    expect(named(container, 'Next change')!.disabled).toBe(true);
  });
});
