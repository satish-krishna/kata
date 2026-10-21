import type { ChangedFile } from '@bindings/ChangedFile';
import { render } from '../../testing/render';
import { RepoFileList, type RepoFileGroup } from './repo-file-list';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, oldPath: null, status: 'modified', binary: false, added: 2, removed: 1, uncommitted: false, ...over,
});
const GROUPS: RepoFileGroup[] = [
  {
    repo: 'claims-intent',
    expanded: true,
    files: [
      file('a.md', { status: 'added', added: 4, removed: 0 }),
      file('b.md', { uncommitted: true }),
      file('c.png', { status: 'deleted', binary: true, added: 0, removed: 0 }),
      file('d.md', { status: 'renamed', oldPath: 'e.md' }),
      file('f.md', { status: 'untracked', uncommitted: true }),
    ],
  },
  { repo: 'claims-core', expanded: false, files: [file('src/x.rs')] },
];
const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('RepoFileList', () => {
  it('lists each repository with its file count and expands only the open ones', async () => {
    const { container } = await render(RepoFileList, { groups: GROUPS, selected: null });
    const heads = Array.from(container.querySelectorAll('[data-repo]'));
    expect(heads.map((h) => text(h))).toEqual(['claims-intent 5', 'claims-core 1']);
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(container.querySelectorAll('[data-file]')).toHaveLength(5);
  });

  it('names each status letter, marks uncommitted files and shows line counts or bin', async () => {
    const { container } = await render(RepoFileList, { groups: GROUPS, selected: null });
    const rows = Array.from(container.querySelectorAll('[data-file]'));
    expect(rows.map((r) => r.querySelector('[data-status]')!.textContent!.trim())).toEqual(['A', 'M', 'D', 'R', 'U']);
    expect(rows.map((r) => text(r.querySelector('.sr-only')))).toEqual(['Added', 'Modified', 'Deleted', 'Renamed', 'Untracked']);
    expect(rows.map((r) => r.querySelector('[data-uncommitted]') !== null)).toEqual([false, true, false, false, true]);
    expect(text(rows[0].querySelector('[data-lines]'))).toBe('+4 −0');
    expect(text(rows[2].querySelector('[data-lines]'))).toBe('bin');
  });

  it('emits the toggled repository and the picked file, and marks the selected one', async () => {
    const { container, fixture } = await render(RepoFileList, { groups: GROUPS, selected: { repo: 'claims-intent', path: 'b.md' } });
    const toggled: string[] = [];
    const picked: unknown[] = [];
    fixture.componentInstance.toggle.subscribe((r) => toggled.push(r));
    fixture.componentInstance.select.subscribe((s) => picked.push(s));
    (container.querySelectorAll('[data-repo]')[1] as HTMLElement).click();
    (container.querySelectorAll('[data-file]')[0] as HTMLElement).click();
    expect(toggled).toEqual(['claims-core']);
    expect(picked).toEqual([{ repo: 'claims-intent', path: 'a.md' }]);
    expect(container.querySelectorAll('[data-file]')[1].getAttribute('aria-current')).toBe('true');
  });
});
