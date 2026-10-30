import { TestBed } from '@angular/core/testing';
import type { Leftovers } from '@bindings/Leftovers';
import { render } from '../../testing/render';
import { LeftoverDialog } from './leftover-dialog';

const LEFT: Leftovers = {
  new_commits: ['docs(commerce): add context', 'chore: marker'],
  discardable: ['commerce/2026-10-18-x/intent.md', 'commerce/2026-10-18-x/spec.md', 'scratch.txt'],
  touched_dirty: ['notes.md'],
  created: [],
  product_repos_changed: ['commerce-core'],
  product_repos_unchecked: [],
};
const ENTRIES = [{ repo: 'commerce-docs', data: LEFT }];
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
    await render(LeftoverDialog, { leftovers: ENTRIES });
    await settle();
    const t = dialog()!.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('docs(commerce): add context');
    expect(t).toContain('scratch.txt');
    expect(t).toContain('notes.md');
    expect(t).toContain('changed before and during this run');
    expect(t).toContain('the run changed files in commerce-core; ai-sdlc should not write there');
  });

  it('tags a file the run created that cannot be discarded as changed during this run only', async () => {
    const row = 'intent/commerce/x/build/commerce-core.md';
    await render(LeftoverDialog, { leftovers: [{ repo: 'commerce-core', data: { ...LEFT, touched_dirty: [], created: [row] } }] });
    await settle();
    const li = [...document.body.querySelectorAll('.k-left__row')].find((e) => e.textContent!.includes(row))!;
    expect(li.textContent!.replace(/\s+/g, ' ')).toContain('changed during this run');
    expect(li.textContent).not.toContain('before and during');
    expect(boxes().map((b) => b.getAttribute('aria-label'))).not.toContain(row);
  });

  it('warns about a product repo whose status could not be read', async () => {
    const { container } = await render(LeftoverDialog, { leftovers: [{ repo: 'commerce-docs', data: { ...LEFT, product_repos_unchecked: ['billing-api'] } }] });
    const warns = [...document.body.querySelectorAll('.k-left__warn')].map((e) => e.textContent!.trim());
    expect(warns).toContain('could not check billing-api');
    expect(container).toBeTruthy();
  });

  it('gives touched files no checkbox', async () => {
    await render(LeftoverDialog, { leftovers: ENTRIES });
    await settle();
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'commerce/2026-10-18-x/intent.md', 'commerce/2026-10-18-x/spec.md', 'scratch.txt',
    ]);
  });

  it('never pre-checks an intent.md or spec.md draft', async () => {
    await render(LeftoverDialog, { leftovers: ENTRIES });
    await settle();
    expect(box('commerce/2026-10-18-x/intent.md').getAttribute('aria-checked')).toBe('false');
    expect(box('commerce/2026-10-18-x/spec.md').getAttribute('aria-checked')).toBe('false');
    expect(box('scratch.txt').getAttribute('aria-checked')).toBe('true');
  });

  it('discards only what is checked', async () => {
    const { fixture } = await render(LeftoverDialog, { leftovers: ENTRIES });
    await settle();
    const got: { repo: string; paths: string[] }[][] = [];
    fixture.componentInstance.discard.subscribe((p) => got.push(p));
    box('commerce/2026-10-18-x/intent.md').click();
    await settle();
    box('scratch.txt').click();
    await settle();
    button('Discard selected').click();
    expect(got).toEqual([[{ repo: 'commerce-docs', paths: ['commerce/2026-10-18-x/intent.md'] }]]);
  });

  it('disables Discard selected when nothing is checked', async () => {
    await render(LeftoverDialog, { leftovers: [{ repo: 'commerce-docs', data: { ...LEFT, discardable: ['commerce/x/intent.md'] } }] });
    await settle();
    expect((button('Discard selected') as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits close from Close', async () => {
    const { fixture } = await render(LeftoverDialog, { leftovers: ENTRIES });
    await settle();
    let closed = 0;
    fixture.componentInstance.close.subscribe(() => closed++);
    button('Close').click();
    expect(closed).toBe(1);
  });

  describe('for a build', () => {
    const CORE: Leftovers = { ...LEFT, new_commits: [], discardable: ['src/x.rs'], touched_dirty: [], product_repos_changed: [] };
    const MASTER: Leftovers = { ...CORE, discardable: ['notes.md', 'draft.md'] };
    const BUILD = [{ repo: 'commerce-docs', data: MASTER }, { repo: 'commerce-core', data: CORE }];
    const sections = () => Array.from(document.body.querySelectorAll('.k-left__repo'));

    it('is titled for the build and has one section per repository', async () => {
      await render(LeftoverDialog, { leftovers: BUILD, build: true });
      await settle();
      expect(dialog()!.textContent).toContain('Uncommitted edits left by the build');
      expect(sections().map((s) => s.querySelector('.k-left__repo-name')!.textContent!.trim())).toEqual(['commerce-docs', 'commerce-core']);
      expect(sections()[1].textContent).toContain('src/x.rs');
      expect(sections()[0].textContent).not.toContain('src/x.rs');
    });

    it('offers Discard selected and Keep all', async () => {
      await render(LeftoverDialog, { leftovers: BUILD, build: true });
      await settle();
      expect(button('Discard selected')).toBeTruthy();
      expect(button('Keep all')).toBeTruthy();
    });

    it('keeps a selection per repository and emits only the chosen files of each', async () => {
      const { fixture } = await render(LeftoverDialog, { leftovers: BUILD, build: true });
      await settle();
      const got: { repo: string; paths: string[] }[][] = [];
      fixture.componentInstance.discard.subscribe((p) => got.push(p));
      box('commerce-docs notes.md').click();
      await settle();
      button('Discard selected').click();
      expect(got).toEqual([[{ repo: 'commerce-docs', paths: ['draft.md'] }, { repo: 'commerce-core', paths: ['src/x.rs'] }]]);
    });

    it('emits close from Keep all', async () => {
      const { fixture } = await render(LeftoverDialog, { leftovers: BUILD, build: true });
      await settle();
      let closed = 0;
      fixture.componentInstance.close.subscribe(() => closed++);
      button('Keep all').click();
      expect(closed).toBe(1);
    });
  });
});
