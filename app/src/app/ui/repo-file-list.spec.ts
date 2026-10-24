import { render } from '../../testing/render';
import { RepoFileList, type RepoFile, type RepoFileGroup } from './repo-file-list';

const file = (path: string, over: Partial<RepoFile> = {}): RepoFile => ({
  path, oldPath: null, status: 'modified', binary: false, added: 2, removed: 1, uncommitted: false, tasks: [], left: false, ...over,
});
const GROUPS: RepoFileGroup[] = [
  {
    repo: 'claims-intent',
    branch: 'change/2026-10-19-ai-sdlc-part-2',
    base: 'main',
    expanded: true, untied: null, untiedShown: false,
    files: [
      file('a.md', { status: 'added', added: 4, removed: 0 }),
      file('b.md', { uncommitted: true }),
      file('c.png', { status: 'deleted', binary: true, added: 0, removed: 0 }),
      file('d.md', { status: 'renamed', oldPath: 'e.md' }),
      file('f.md', { status: 'untracked', uncommitted: true }),
    ],
  },
  { repo: 'claims-core', branch: 'change/2026-10-19-ai-sdlc-part-2', base: null, expanded: false, untied: null, untiedShown: false, files: [file('src/deep/x.rs'), file('.github/ci.yml')] },
];
const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('RepoFileList', () => {
  it('lists each repository with its file count and expands only the open ones', async () => {
    const { container } = await render(RepoFileList, { groups: GROUPS, selected: null });
    const heads = Array.from(container.querySelectorAll('[data-repo]'));
    expect(heads.map((h) => text(h))).toEqual(['claims-intent 5 change/… → main', 'claims-core 2 change/…']);
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(container.querySelectorAll('[data-file]')).toHaveLength(5);
  });

  it('shows each repository branch against its base, shortened, with the whole of it in a title', async () => {
    const { container } = await render(RepoFileList, { groups: GROUPS, selected: null });
    const branches = Array.from(container.querySelectorAll('[data-branch]'));
    expect(branches.map((b) => text(b))).toEqual(['change/… → main', 'change/…']);
    expect(branches.map((b) => b.getAttribute('title'))).toEqual(['change/2026-10-19-ai-sdlc-part-2 → main', 'change/2026-10-19-ai-sdlc-part-2']);
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

  it('puts the file name on one line and its folder on a second, and gives a root file no folder line', async () => {
    const open: RepoFileGroup[] = [GROUPS[0], { ...GROUPS[1], expanded: true }];
    const { container } = await render(RepoFileList, { groups: open, selected: null });
    const rows = Array.from(container.querySelectorAll('[data-file="src/deep/x.rs"], [data-file=".github/ci.yml"]'));
    expect(rows.map((r) => text(r.querySelector('[data-name]')))).toEqual(['x.rs', 'ci.yml']);
    expect(rows.map((r) => text(r.querySelector('[data-folder]')))).toEqual(['src/deep', '.github']);
    expect(container.querySelector('[data-file="a.md"] [data-folder]')).toBeNull();
    expect(text(container.querySelector('[data-file="a.md"] [data-name]'))).toBe('a.md');
  });

  it('keeps the whole path as the accessible name and out of the truncated lines', async () => {
    const open: RepoFileGroup[] = [{ ...GROUPS[1], expanded: true }];
    const { container } = await render(RepoFileList, { groups: open, selected: null });
    const row = container.querySelector('[data-file="src/deep/x.rs"]')!;
    expect(text(row.querySelector('[data-fullpath]'))).toBe('src/deep/x.rs');
    expect(row.querySelector('[data-fullpath]')!.classList.contains('sr-only')).toBe(true);
    expect(row.querySelector('[data-name]')!.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('[data-folder]')!.getAttribute('aria-hidden')).toBe('true');
    expect(row.getAttribute('title')).toBe('src/deep/x.rs');
    expect(row.querySelector('[data-folder] bdi')).not.toBeNull();
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

  it('shows the task ids of a tied file, a quiet label on an untied one and the stopped run on a file it left', async () => {
    const tied = file('a.md', { tasks: ['T1', 'T2'] });
    const left = file('b.md', { uncommitted: true, left: true });
    const groups: RepoFileGroup[] = [{ ...GROUPS[0], files: [tied, left] }];
    const { container } = await render(RepoFileList, { groups, selected: null });
    expect(text(container.querySelector('[data-file="a.md"] [data-tasks]'))).toBe('T1, T2');
    expect(container.querySelector('[data-file="a.md"] [data-untied]')).toBeNull();
    expect(text(container.querySelector('[data-file="b.md"] [data-untied]'))).toBe('not tied to a task');
    expect(text(container.querySelector('[data-file="b.md"] [data-left]'))).toBe('left by the stopped run');
    expect(container.querySelector('[data-file="a.md"] [data-left]')).toBeNull();
  });

  it('counts the untied files, lists them on request and says so once for a single file', async () => {
    const one: RepoFileGroup = { ...GROUPS[0], files: [file('a.md', { tasks: ['T1'] })], untied: [file('b.md')] };
    const { container, fixture } = await render(RepoFileList, { groups: [one], selected: null });
    const asked: string[] = [];
    fixture.componentInstance.showUntied.subscribe((r) => asked.push(r));
    expect(text(container.querySelector('[data-untied-line] > span'))).toBe('1 file in claims-intent is not tied to a task');
    expect(container.querySelectorAll('[data-file]')).toHaveLength(1);
    (container.querySelector('[data-untied-line] button') as HTMLElement).click();
    expect(asked).toEqual(['claims-intent']);
    fixture.componentRef.setInput('groups', [{ ...one, untiedShown: true }]);
    fixture.detectChanges();
    expect(Array.from(container.querySelectorAll('[data-file]')).map((r) => r.getAttribute('data-file'))).toEqual(['a.md', 'b.md']);
    expect(container.querySelector('[data-untied-line] button')).toBeNull();
  });
});
