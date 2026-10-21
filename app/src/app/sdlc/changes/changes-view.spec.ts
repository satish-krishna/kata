import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { FilePair } from '@bindings/FilePair';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { DiffEditor } from '../../ui/diff-editor/diff-editor';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { ChangesView } from './changes-view';

const INPUTS = { folder: MOCK_WORKSPACE_FOLDER, masterRepo: MOCK_MASTER, system: 'claims', change: MOCK_BUILD_CHANGE, turns: 0, banner: null };
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (c: HTMLElement) => (c.textContent ?? '').replace(/\s+/g, ' ');
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

async function mount(transport = new MockTransport(), inputs: Record<string, unknown> = {}) {
  const out = await render(ChangesView, { ...INPUTS, ...inputs }, [{ provide: KataTransport, useValue: transport }]);
  await settle();
  const container = out.container;
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  const button = (name: string) => buttons().find((b) => norm(b.textContent) === name || b.getAttribute('aria-label') === name);
  const fileRows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('app-repo-file-list [data-file]'));
  const paths = () => fileRows().map((r) => r.getAttribute('data-file'));
  const row = (path: string) => fileRows().find((r) => r.getAttribute('data-file') === path)!;
  const editor = () => out.fixture.debugElement.query(By.directive(DiffEditor)).componentInstance as DiffEditor;
  const turns = async (n: number) => {
    out.fixture.componentRef.setInput('turns', n);
    await settle();
  };
  return { ...out, transport, button, buttons, paths, row, editor, turns };
}

beforeEach(() => {
  // Monaco never loads in a unit test; the editor waits on a load that does not finish.
  vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChangesView', () => {
  it('changes view lists repositories and opens a file (R7.1)', async () => {
    const { container, row, editor, fixture, transport } = await mount();
    const heads = Array.from(container.querySelectorAll('app-repo-file-list [data-repo]')).map((h) => norm(h.textContent));
    expect(heads[0]).toContain(MOCK_MASTER);
    expect(heads[0]).toContain('5');
    expect(heads.some((h) => h.includes('claims-core'))).toBe(true);
    const expected: FilePair = await transport.sdlcDiffPair('x', 'whole', 'src/limits.rs');
    row('src/limits.rs').click();
    await settle();
    expect(editor().pair()).toEqual(expected);
    expect(row('src/limits.rs').getAttribute('aria-current')).toBe('true');
    fixture.detectChanges();
    expect(container.querySelector('app-diff-bar')!.textContent).toContain('src/limits.rs');
  });

  it('says which repository has no change branch instead of leaving it out silently', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcMissingChangeBranches').mockResolvedValue(['billing']);
    const { container } = await mount(transport);
    const note = container.querySelector('[data-testid="changes-missing"]');
    expect(norm(note?.textContent ?? null)).toBe(`billing has no change/${MOCK_BUILD_CHANGE} branch, so its changes are not listed.`);
  });

  it('shows no missing-branch note when every repository has its change branch', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-testid="changes-missing"]')).toBeNull();
  });

  it('changes view calls only read commands (R7.3)', async () => {
    const transport = new MockTransport();
    const proto = MockTransport.prototype as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(MockTransport.prototype).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
    const target = transport as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = names.map((n) => [n, vi.spyOn(target, n)] as const);
    const { button, row, turns } = await mount(transport);
    button('Committed')!.click();
    await settle();
    button('Uncommitted')!.click();
    await settle();
    row('src/limits.rs').click();
    await settle();
    await turns(1);
    const called = spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n);
    expect(called.sort()).toEqual(['sdlcChangeRepos', 'sdlcDiffBase', 'sdlcDiffFiles', 'sdlcDiffPair', 'sdlcMissingChangeBranches']);
  });

  it('parts toggle switches the listed files (R7.6)', async () => {
    const { button, paths } = await mount();
    expect(paths()).toHaveLength(5);
    button('Committed')!.click();
    await settle();
    expect(paths()).toEqual(['src/attachments.rs', 'src/store.rs', 'assets/sample.png']);
    button('Uncommitted')!.click();
    await settle();
    expect(paths()).toEqual(['src/limits.rs', 'notes/todo.txt']);
    button('Whole change')!.click();
    await settle();
    expect(paths()).toHaveLength(5);
  });

  it('header names the compared base (R7.7)', async () => {
    const { container } = await mount();
    const t = text(container);
    expect(t).toContain(`change/${MOCK_BUILD_CHANGE}`);
    expect(t).toContain('into');
    expect(t).toContain('main');
    expect(t).toContain('base from origin/HEAD · compared at the merge base with origin/main');
    expect(t).toContain('Read-only. Nothing here changes a file, commit or branch.');
  });

  it('a refresh keeps the open file and shows its latest version (R17.4)', async () => {
    const update = vi.spyOn(DiffEditor.prototype, 'updateModified');
    const { transport, row, paths, editor, turns } = await mount();
    row('src/limits.rs').click();
    await settle();
    const before = editor().pair();
    const listing = await transport.sdlcDiffFiles('x', 'whole');
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({
      ...listing,
      files: [...listing.files, { path: 'src/new.rs', oldPath: null, status: 'added', binary: false, added: 1, removed: 0, uncommitted: true }],
    });
    vi.spyOn(transport, 'sdlcDiffPair').mockResolvedValue({ ...before!, modified: 'the latest text\n' });
    await turns(1);
    expect(paths()).toContain('src/new.rs');
    expect(row('src/limits.rs').getAttribute('aria-current')).toBe('true');
    expect(editor().pair()).toBe(before);
    expect(update).toHaveBeenCalledWith('the latest text\n');
  });

  it('a file that left the change keeps its last content with a note', async () => {
    const { transport, container, row, paths, editor, turns, fixture } = await mount();
    row('src/limits.rs').click();
    await settle();
    const before = editor().pair();
    const listing = await transport.sdlcDiffFiles('x', 'whole');
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ ...listing, files: listing.files.filter((f) => f.path !== 'src/limits.rs') });
    await turns(2);
    expect(text(container)).toContain('This file is no longer part of the change.');
    expect(editor().pair()).toBe(before);
    expect(paths()).not.toContain('src/limits.rs');
    row('src/store.rs').click();
    await settle();
    fixture.detectChanges();
    expect(text(container)).not.toContain('This file is no longer part of the change.');
    expect(editor().pair()).not.toBe(before);
  });

  it('forces the editor inline below 768 pixels and hides the layout choice', async () => {
    const query = (q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('matchMedia', query);
    const { editor, button } = await mount();
    expect(editor().sideBySide()).toBe(false);
    expect(button('Side by side')).toBeUndefined();
  });

  it('asks the editor to step between changes from the diff bar', async () => {
    const { editor, button, row } = await mount();
    row('src/limits.rs').click();
    await settle();
    expect(editor().stepRequest()).toBeNull();
    button('Next change')!.click();
    await settle();
    expect(editor().stepRequest()).toEqual({ direction: 'next', serial: 1 });
    button('Previous change')!.click();
    await settle();
    expect(editor().stepRequest()).toEqual({ direction: 'previous', serial: 2 });
  });

  it('lets the engineer choose inline or side by side on a wide screen', async () => {
    const { editor, button } = await mount();
    expect(editor().sideBySide()).toBe(true);
    button('Inline')!.click();
    await settle();
    expect(editor().sideBySide()).toBe(false);
  });

  it('says no pull request yet until the repository has one', async () => {
    const { container } = await mount();
    expect(text(container.querySelector<HTMLElement>('[data-testid="changes-pr"]')!)).toBe('No pull request yet. Pull requests open when you declare the change done.');
  });

  it('shows the number, the title and a link to GitHub once the repository has a pull request', async () => {
    const url = 'https://github.com/acme/claims-intent/pull/7';
    const { container } = await mount(new MockTransport(), { pullRequests: [{ repo: MOCK_MASTER, url }], prTitle: MOCK_BUILD_CHANGE });
    const row = container.querySelector<HTMLElement>('[data-testid="changes-pr"]')!;
    expect(text(row)).toContain('#7 open');
    expect(text(row)).toContain(MOCK_BUILD_CHANGE);
    const link = row.querySelector('a')!;
    expect(link.textContent).toBe('View on GitHub');
    expect(link.getAttribute('href')).toBe(url);
  });
});
