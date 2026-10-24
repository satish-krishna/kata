import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { BuildRow } from '@bindings/BuildRow';
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
const buildRow = (task: string, repo: string, commit: string): BuildRow => ({ task, repo, commits: [commit], departure: null });
const sha = (short: string) => short.padEnd(40, '0');

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
  const inRepo = (repo: string, path: string) =>
    container.querySelector<HTMLElement>(`[aria-label="Files changed in ${repo}"] [data-file="${path}"]`)!;
  const open = async (repo: string) => {
    Array.from(container.querySelectorAll<HTMLElement>('app-repo-file-list [data-repo]')).find((h) => norm(h.textContent).startsWith(repo))!.click();
    await settle();
  };
  const setInput = async (name: string, value: unknown) => {
    out.fixture.componentRef.setInput(name, value);
    await settle();
  };
  return { ...out, transport, button, buttons, paths, row, editor, turns, inRepo, open, setInput };
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

  it('draws its own file list beside the diff by default', async () => {
    const { container } = await mount();
    expect(container.querySelector('aside [data-file="src/limits.rs"]')).not.toBeNull();
  });

  it('draws only the diff when the host shows the list, and hands the host the list to show', async () => {
    const solo = await mount(new MockTransport(), { listOutside: true });
    expect(solo.container.querySelector('aside')).toBeNull();
    expect(solo.container.querySelector('[data-file]')).toBeNull();
    expect(solo.container.querySelector('app-diff-bar')).not.toBeNull();
    const list = (solo.fixture.componentInstance as ChangesView).fileList();
    const view = list.createEmbeddedView(null);
    view.detectChanges();
    expect(view.rootNodes.some((n: Node) => n instanceof HTMLElement && n.querySelector('[data-file="src/limits.rs"]') !== null)).toBe(true);
    view.destroy();
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
    expect(called.sort()).toEqual(['sdlcChangeRepos', 'sdlcCommitFiles', 'sdlcDiffBase', 'sdlcDiffFiles', 'sdlcDiffPair', 'sdlcMissingChangeBranches']);
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

  it('names the compared base once, in the strip, and each repository branch against its base in the list (R7.7)', async () => {
    const { container } = await mount();
    const strip = container.querySelector<HTMLElement>('[data-testid="changes-strip"]')!;
    expect(norm(strip.querySelector('[data-testid="changes-readonly"]')!.textContent)).toBe('read-only · compared at the merge base with origin/main');
    const branches = Array.from(container.querySelectorAll('app-repo-file-list [data-branch]'));
    expect(branches).toHaveLength(3);
    expect(norm(branches[0].textContent)).toBe('change/… → main');
    expect(branches[0].getAttribute('title')).toBe(`change/${MOCK_BUILD_CHANGE} → main`);
  });

  it('has one strip in place of the old header block', async () => {
    const { container } = await mount();
    const t = text(container);
    expect(container.querySelector('.k-changes__main h2')).toBeNull();
    expect(container.querySelector('[data-testid="changes-pr"]')).toBeNull();
    expect(container.querySelector('.k-changes__branches')).toBeNull();
    expect(container.querySelector('.k-changes__chip')).toBeNull();
    expect(t).not.toContain('base from origin/HEAD');
    expect(t).not.toContain('No pull request yet');
    expect(t).not.toContain('Read-only. Nothing here changes');
    const strip = container.querySelector<HTMLElement>('[data-testid="changes-strip"]')!;
    expect(strip.querySelector('[role="radiogroup"][aria-label="Part of the change"]')).not.toBeNull();
  });

  it('counts the files and the lines of the open part across every listed repository, binary files as zero', async () => {
    const { container, button } = await mount();
    const strip = container.querySelector<HTMLElement>('[data-testid="changes-strip"]')!;
    const read = () => ({
      count: norm(strip.querySelector('[data-testid="changes-count"]')!.textContent),
      added: norm(strip.querySelector('[data-testid="changes-added"]')!.textContent),
      removed: norm(strip.querySelector('[data-testid="changes-removed"]')!.textContent),
    });
    expect(read()).toEqual({ count: '15 files', added: '+93', removed: '−15' });
    button('Committed')!.click();
    await settle();
    expect(read()).toEqual({ count: '9 files', added: '+63', removed: '−9' });
    button('Uncommitted')!.click();
    await settle();
    expect(read()).toEqual({ count: '6 files', added: '+30', removed: '−6' });
  });

  it('has a By type control in the strip that opens the per-type line counts', async () => {
    const { container } = await mount();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="changes-strip"] button[data-testid="changes-bytype"]')!;
    expect(norm(trigger.textContent)).toBe('By type');
    expect(trigger.getAttribute('data-slot')).toBe('popover-trigger');
    // Closed, the counts are not in the page; the browser check opens the popover.
    expect(container.querySelector('[data-testid="changes-types"]')).toBeNull();
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

  it('each file row carries its tasks or not tied to a task', async () => {
    const { open, inRepo } = await mount(new MockTransport(), { rows: [buildRow('T1', 'claims-core', 't1c0ffee')], stopped: ['claims-core'] });
    await open('claims-core');
    expect(norm(inRepo('claims-core', 'src/attachments.rs').querySelector('[data-tasks]')?.textContent ?? null)).toBe('T1');
    expect(inRepo('claims-core', 'src/attachments.rs').querySelector('[data-untied]')).toBeNull();
    expect(norm(inRepo('claims-core', 'src/store.rs').querySelector('[data-untied]')?.textContent ?? null)).toBe('not tied to a task');
    expect(inRepo('claims-core', 'src/store.rs').querySelector('[data-tasks]')).toBeNull();
    // Only an uncommitted file of a stopped repository was left by the stopped run.
    expect(norm(inRepo('claims-core', 'src/limits.rs').querySelector('[data-left]')?.textContent ?? null)).toBe('left by the stopped run');
    expect(inRepo('claims-core', 'src/attachments.rs').querySelector('[data-left]')).toBeNull();
    // The master repository has no task rows and did not stop.
    expect(norm(inRepo(MOCK_MASTER, 'src/attachments.rs').querySelector('[data-untied]')?.textContent ?? null)).toBe('not tied to a task');
    expect(inRepo(MOCK_MASTER, 'src/limits.rs').querySelector('[data-left]')).toBeNull();
  });

  it('picking a task narrows the files and counts the untied ones (R5.2)', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcCommitFiles').mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('claims-core') ? [{ sha: sha('t1c0ffee'), files: ['src/attachments.rs', 'src/store.rs'] }] : []),
    );
    const { container, paths, button, setInput } = await mount(transport, {
      rows: [buildRow('T1', 'claims-core', 't1c0ffee')],
      task: { id: 'T1', repo: 'claims-core' },
    });
    expect(paths()).toEqual(['src/attachments.rs', 'src/store.rs']);
    expect(container.querySelectorAll('app-repo-file-list [data-repo]')).toHaveLength(1);
    expect(norm(container.querySelector('[data-untied-line] > span')?.textContent ?? null)).toBe('3 files in claims-core are not tied to a task');
    button('Show them')!.click();
    await settle();
    expect(paths()).toEqual(['src/attachments.rs', 'src/store.rs', 'src/limits.rs', 'notes/todo.txt', 'assets/sample.png']);
    // Picking the task again starts over.
    await setInput('task', { id: 'T1', repo: 'claims-core' });
    expect(paths()).toEqual(['src/attachments.rs', 'src/store.rs']);
    expect(button('Show them')).toBeDefined();
    // Putting the pick away lists every repository again.
    await setInput('task', null);
    expect(container.querySelectorAll('app-repo-file-list [data-repo]')).toHaveLength(3);
    expect(container.querySelector('[data-untied-line]')).toBeNull();
  });

  it("new work appears as the build's turns grow (R5.3)", async () => {
    const { transport, paths, turns } = await mount();
    expect(paths()).not.toContain('src/new.rs');
    const listing = await transport.sdlcDiffFiles('x', 'whole');
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({
      ...listing,
      files: [...listing.files, { path: 'src/new.rs', oldPath: null, status: 'added', binary: false, added: 1, removed: 0, uncommitted: false }],
    });
    await turns(1);
    expect(paths()).toContain('src/new.rs');
  });

  it.each([
    ['Whole change', ['src/attachments.rs', 'src/limits.rs', 'src/store.rs', 'notes/todo.txt', 'assets/sample.png']],
    ['Committed', ['src/attachments.rs', 'src/store.rs', 'assets/sample.png']],
    ['Uncommitted', ['src/limits.rs', 'notes/todo.txt']],
  ])('the three parts show whole, committed and uncommitted work: %s (R5.4)', async (view, expected) => {
    const { button, paths } = await mount();
    button('Committed')!.click();
    await settle();
    button(view)!.click();
    await settle();
    expect([...paths()].sort()).toEqual([...expected].sort());
  });
});
