import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { seedCatalog } from '../../lib/mock';
import { SdlcHome } from './sdlc-home';
import { SdlcHomeViewModel } from './sdlc-home.view-model';

/** Every document run opens the preview first; confirm it once its rows have resolved. */
const confirmPreview = async () => {
  const start = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Start run');
  await vi.waitFor(() => expect(start() && !start()!.disabled).toBe(true));
  start()!.click();
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

async function mount(transport = new MockTransport()) {
  const out = await render(SdlcHome, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
  await settle();
  return { ...out, transport };
}

describe('SdlcHome', () => {
  it('renders the changes and repositories of the open workspace with the New change action', async () => {
    const { container } = await mount();
    const read = () => container.textContent!.replace(/\s+/g, ' ');
    // The names and their stage labels come from one answer of the plugin, so they show together.
    expect(read()).toContain('2026-10-12-product-photo-upload');
    expect(read()).toContain('Spec · awaiting acceptance');
    const text = read();
    expect(text).toContain('In progress on other branches');
    expect(text).toContain('2026-10-17-product-notes');
    expect(text).toContain('customer-portal');
    expect(text).toContain('stale · 14 commits');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
    expect(labels(container)).toContain('New change');
    expect(labels(container)).toContain('Add system');
  });

  it('offers Refresh context on every product repo with a context file, and crosses the seam when clicked', async () => {
    const { container, transport } = await mount();
    const run = vi.spyOn(transport, 'runSpec').mockResolvedValue('1');
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) =>
      / context for /.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Refresh context for commerce-core', 'Refresh context for customer-portal']);
    buttons[1].click();
    await confirmPreview();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].name).toBe('sdlc-commerce-context');
  });

  it('crosses the seam: a running agent takes the page with the session view and leaves only the toolbar enabled outside it (R11.6)', async () => {
    const { container } = await mount();
    vi.spyOn(TestBed.inject(KataTransport), 'runSpec').mockResolvedValue('1');
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh context for customer-portal"]')!.click();
    await confirmPreview();
    await vi.waitFor(() => expect(container.querySelector('app-sdlc-session')).not.toBeNull());
    await settle();
    expect(container.querySelector('app-observe-pane')).not.toBeNull();
    expect(container.querySelector('app-changes-table')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const outside = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.closest('app-sdlc-session'));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.filter((b) => !b.disabled).map((b) => b.textContent!.trim() || b.getAttribute('aria-label'))).toEqual(['ai-sdlc', 'acme-commerce', 'AI-SDLC settings']);
  });

  it('is a blocking empty state naming where kata looked, with every workspace action withheld, when the plugin is missing', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'catalog').mockResolvedValue(seedCatalog);
    const { container } = await mount(transport);
    const text = container.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('The ai-sdlc plugin was not found');
    expect(text).toContain('~/.claude');
    expect(text).toContain('the .claude folder of the workspace');
    expect(text).toContain('installed marketplace plugins');
    const all = labels(container);
    expect(all).not.toContain('New change');
    expect(all).not.toContain('Add system');
    expect(all).not.toContain('Add workspace');
    expect(container.querySelector('button[aria-label^="Switch workspace"]')).toBeNull();
    expect(container.querySelector('app-changes-table')).toBeNull();
    expect(container.querySelector('app-repos-table')).toBeNull();
  });

  it('invites the first workspace when none is saved', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([]);
    vi.spyOn(transport, 'catalog').mockResolvedValue([
      ...seedCatalog,
      { kind: 'plugin', name: 'ai-sdlc', description: '', source: 'user', path: '', provides: [], mcp_servers: [] },
    ]);
    const { container } = await mount(transport);
    expect(container.textContent).toContain('No workspace yet');
    expect(labels(container)).toContain('Add workspace');
    expect(labels(container)).not.toContain('New change');
  });

  it('names a workspace folder that cannot be read and offers to forget it', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcScan').mockRejectedValue('no such folder');
    const { container } = await mount(transport);
    expect(container.textContent).toContain('Workspace folder not found');
    expect(container.textContent).toContain('no such folder');
    expect(labels(container)).toContain('Remove from list…');
    expect(labels(container)).not.toContain('New change');
  });

  it('lists every master when there is more than one', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue({
      folder: 'D:/Work/acme-commerce', repos: ['a', 'b'], master: { kind: 'many', repos: ['a', 'b'] }, marker: null, marker_error: null,
    });
    const { container } = await mount(transport);
    expect(container.textContent).toContain('More than one master repo');
    const items = Array.from(container.querySelectorAll('.k-state__list li')).map((li) => li.textContent);
    expect(items).toEqual(['a', 'b']);
  });

  it('says the master repo is gone when no repo holds the marker', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue({
      folder: 'D:/Work/acme-commerce', repos: ['a'], master: { kind: 'none' }, marker: null, marker_error: null,
    });
    const { container } = await mount(transport);
    expect(container.textContent).toContain('No master repo found');
  });

  it('opens the New change dialog from the toolbar action', async () => {
    const { container } = await mount();
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent!.includes('New change'))!.click();
    await settle();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Description');
  });

  it('shows the triage notice, and its two actions reach the dialog and the library', async () => {
    const { container, fixture } = await mount();
    const vm = fixture.debugElement.injector.get(SdlcHomeViewModel);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(container.querySelector('[data-testid="triage-notice"]')).toBeNull();
    vm.triageNotice.set({ idea: 'flag prices', runId: 'sdlc-commerce-triage-1' });
    await settle();
    const notice = container.querySelector('[data-testid="triage-notice"]')!;
    expect(notice.textContent).toContain('No change was created.');
    const click = (label: string) => Array.from(notice.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!.click();
    click('Open run');
    expect(navigate).toHaveBeenCalledWith(['/library'], { queryParams: { run: 'sdlc-commerce-triage-1' } });
    click('Describe again');
    await settle();
    expect(document.body.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('flag prices');
  });

  it('R6.1: a triage run that is running offers the message box, and sending reaches that run', async () => {
    const { container, fixture, transport } = await mount();
    const vm = fixture.debugElement.injector.get(SdlcHomeViewModel);
    const send = vi.spyOn(transport, 'sendMessage');
    const started = vi.spyOn(transport, 'runSpec');
    void vm.newChange('commerce', 'Flag suspicious prices on import', 'decide');
    await confirmPreview();
    // The scripted triage is running until its question; the box is enabled only then.
    const input = () => container.querySelector<HTMLInputElement>('app-message-box [data-message-input]');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(input() !== null && !input()!.disabled).toBe(true);
    });
    input()!.value = 'look at import only';
    input()!.dispatchEvent(new Event('input'));
    TestBed.tick();
    container.querySelector<HTMLButtonElement>('[data-message-send]')!.click();
    const runId = await started.mock.results[0].value;
    expect(started.mock.calls[0][0].name).toMatch(/-triage$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(runId, expect.any(String), 'look at import only');
  });
});

describe('SdlcHome old per-machine checks', () => {
  afterEach(() => history.replaceState({}, '', '/'));

  it('tells the engineer once that the old checks no longer run, shows the file in mono, and is gone once dismissed (R6.1, R6.2)', async () => {
    history.replaceState({}, '', '/?demo=old-checks');
    const { container, transport } = await mount();
    const notice = container.querySelector('[data-testid="old-checks"]')!;
    expect(notice).not.toBeNull();
    const text = notice.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('These checks no longer run.');
    expect(text).toContain('Checks are now team settings in the master repository');
    expect(text).toContain('--hooks');
    const file = notice.querySelector<HTMLElement>('[data-testid="old-checks-text"]')!;
    expect(file.classList.contains('k-mono')).toBe(true);
    expect(file.textContent).toContain('command');
    Array.from(notice.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Dismiss')!.click();
    await settle();
    expect(container.querySelector('[data-testid="old-checks"]')).toBeNull();
    // A later visit: the backend no longer offers it.
    expect(await transport.sdlcOldChecks('D:/Work/acme-commerce', ['commerce'])).toEqual([]);
  });

  it('shows no notice when the system has no old checks file', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-testid="old-checks"]')).toBeNull();
  });
});

describe('SdlcHome finished changes and system choice', () => {
  afterEach(() => history.replaceState({}, '', '/'));

  it('unfolding the finished section asks the transport nothing and the picker lists the systems', async () => {
    history.replaceState({}, '', '/?demo=finished-many');
    const transport = new MockTransport();
    const { container, fixture } = await mount(transport);
    const text = () => container.textContent!.replace(/\s+/g, ' ');
    const fold = container.querySelector<HTMLButtonElement>('app-finished-changes button[aria-expanded]')!;
    expect(fold.textContent!.replace(/\s+/g, ' ').trim()).toBe('Finished (60)');
    expect(container.querySelectorAll('[data-testid="finished-row"]')).toHaveLength(0);
    const spies = ['sdlcHomeList', 'sdlcHomeOpen', 'sdlcHomePick', 'sdlcHomePullRequests', 'sdlcState', 'sdlcChangeState'].map((m) =>
      vi.spyOn(transport as never, m as never),
    );
    fold.click();
    fixture.detectChanges();
    expect(container.querySelectorAll('[data-testid="finished-row"]')).toHaveLength(60);
    expect(text()).toContain('2026-09-60-finished-change-60Finished change 60merged');
    expect(text()).toContain('rejected');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')).map((b) => b.textContent!.trim());
    expect(radios).toEqual(['commerce', 'payments']);
  });

  it('no finished section when the system has none', async () => {
    const { container } = await mount();
    expect(container.querySelector('app-finished-changes button')).toBeNull();
  });
});
