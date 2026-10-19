import { TestBed } from '@angular/core/testing';
import type { Leftovers } from '@bindings/Leftovers';
import { render } from '../../testing/render';
import { LeftoverDialog } from './leftover-dialog';

const LEFT: Leftovers = {
  new_commits: ['docs(claims): add context', 'chore: marker'],
  discardable: ['claims/2026-10-18-x/intent.md', 'claims/2026-10-18-x/spec.md', 'scratch.txt'],
  touched_dirty: ['notes.md'],
  product_repos_changed: ['claims-core'],
};
const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim().startsWith(label))!;
const boxes = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const box = (path: string) => boxes().find((b) => b.getAttribute('aria-label') === path)!;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

describe('LeftoverDialog', () => {
  it('renders nothing without leftovers', async () => {
    await render(LeftoverDialog, { leftovers: null });
    expect(dialog()).toBeNull();
  });

  it('lists commits that landed, discardable files, touched files and the product-repo warning', async () => {
    await render(LeftoverDialog, { leftovers: LEFT });
    await settle();
    const t = dialog()!.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('docs(claims): add context');
    expect(t).toContain('scratch.txt');
    expect(t).toContain('notes.md');
    expect(t).toContain('changed before and during this run');
    expect(t).toContain('the run changed files in claims-core; ai-sdlc should not write there');
  });

  it('gives touched files no checkbox', async () => {
    await render(LeftoverDialog, { leftovers: LEFT });
    await settle();
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'claims/2026-10-18-x/intent.md', 'claims/2026-10-18-x/spec.md', 'scratch.txt',
    ]);
  });

  it('never pre-checks an intent.md or spec.md draft', async () => {
    await render(LeftoverDialog, { leftovers: LEFT });
    await settle();
    expect(box('claims/2026-10-18-x/intent.md').getAttribute('aria-checked')).toBe('false');
    expect(box('claims/2026-10-18-x/spec.md').getAttribute('aria-checked')).toBe('false');
    expect(box('scratch.txt').getAttribute('aria-checked')).toBe('true');
  });

  it('discards only what is checked', async () => {
    const { fixture } = await render(LeftoverDialog, { leftovers: LEFT });
    await settle();
    const got: string[][] = [];
    fixture.componentInstance.discard.subscribe((p) => got.push(p));
    box('claims/2026-10-18-x/intent.md').click();
    await settle();
    box('scratch.txt').click();
    await settle();
    button('Discard selected').click();
    expect(got).toEqual([['claims/2026-10-18-x/intent.md']]);
  });

  it('disables Discard selected when nothing is checked', async () => {
    await render(LeftoverDialog, { leftovers: { ...LEFT, discardable: ['claims/x/intent.md'] } });
    await settle();
    expect((button('Discard selected') as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits close from Close', async () => {
    const { fixture } = await render(LeftoverDialog, { leftovers: LEFT });
    await settle();
    let closed = 0;
    fixture.componentInstance.close.subscribe(() => closed++);
    button('Close').click();
    expect(closed).toBe(1);
  });
});
