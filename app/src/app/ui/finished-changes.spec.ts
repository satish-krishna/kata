import type { FinishedChange } from '@bindings/FinishedChange';
import { render } from '../../testing/render';
import { FinishedChanges } from './finished-changes';

const many = (n: number): FinishedChange[] =>
  Array.from({ length: n }, (_, i) => ({ change: `2026-09-${String(i + 1).padStart(2, '0')}-change-${i + 1}`, title: `Change ${i + 1}`, finished: i % 2 === 0 ? 'merged' : 'rejected' }));
const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ').trim();
const fold = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-expanded]')!;

describe('FinishedChanges', () => {
  it('finished section starts folded with its count', async () => {
    const { container } = await render(FinishedChanges, { finished: many(19), count: 19 });
    expect(text(fold(container))).toBe('Finished (19)');
    expect(fold(container).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-testid="finished-row"]')).toHaveLength(0);
  });

  it('unfolding lists each finished change with its mark and asks nothing', async () => {
    const finished: FinishedChange[] = [
      { change: '2026-10-12-photo-upload', title: 'Photo upload', finished: 'merged' },
      { change: '2026-10-20-dark-banner', title: 'Dark banner', finished: 'rejected' },
    ];
    const { fixture, container } = await render(FinishedChanges, { finished, count: 2 });
    fold(container).click();
    fixture.detectChanges();
    expect(fold(container).getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="finished-row"]')).map((r) => Array.from(r.children).map((e) => text(e as HTMLElement)).join(' '));
    expect(rows).toEqual(['2026-10-12-photo-upload Photo upload merged', '2026-10-20-dark-banner Dark banner rejected']);
  });

  it('a finished change opens by its name', async () => {
    const { fixture, container } = await render(FinishedChanges, { finished: many(2), count: 2 });
    const got: string[] = [];
    fixture.componentInstance.open.subscribe((c) => got.push(c));
    fold(container).click();
    fixture.detectChanges();
    container.querySelector<HTMLButtonElement>('[data-testid="finished-row"] button')!.click();
    expect(got).toEqual(['2026-09-01-change-1']);
  });

  it('no finished section without finished changes', async () => {
    const { container } = await render(FinishedChanges, { finished: [], count: 0 });
    expect(container.querySelector('button')).toBeNull();
    expect(text(container)).toBe('');
  });
});
