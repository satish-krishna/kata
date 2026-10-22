import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import { LockStore } from '../../core/lock/lock.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildView } from './build-view';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

const CTX: BuildContext = { workspaceId: 'acme-claims', folder: MOCK_WORKSPACE_FOLDER, system: 'claims', change: MOCK_BUILD_CHANGE, systemRepos: [] };

async function mount(transport = new MockTransport()) {
  const out = await transport.sdlcBuildPrepare(MOCK_WORKSPACE_FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, false, null, 'start');
  if (out.kind !== 'ready') throw new Error('the mock build did not prepare');
  const handoff: BuildHandoff = { start: out.start, timeoutSecs: 5400, round: null, checksDir: await transport.sdlcChecksDir() };
  // Not `render()`: under fake timers `whenStable` would wait on a change detection that only a timer can run.
  TestBed.configureTestingModule({ imports: [BuildView], providers: [provideRouter([]), { provide: KataTransport, useValue: transport }] });
  const fixture = TestBed.createComponent(BuildView);
  fixture.componentRef.setInput('handoff', handoff);
  fixture.componentRef.setInput('context', CTX);
  fixture.detectChanges();
  const view = { fixture, container: fixture.nativeElement as HTMLElement };
  const vm = view.fixture.debugElement.injector.get(BuildViewModel);
  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      await vi.advanceTimersByTimeAsync(50);
      TestBed.tick();
      view.fixture.detectChanges();
    }
  };
  const lock = TestBed.inject(LockStore);
  const drive = async (done: () => boolean) => {
    for (let t = 0; t < 60000 && !done(); t += 100) {
      await advance(100);
      for (const w of lock.waiting()) if (w.kind === 'answer') vm.answer(w.runId, { id: 'q1', answers: [['Reuse it']] });
    }
    await advance(300);
  };
  return { ...view, vm, transport, advance, drive, lock };
}

const button = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.replace(/\s+/g, ' ').trim() === name);
const text = (c: HTMLElement) => (c.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  // Monaco never loads in a unit test; the editor waits on a load that does not finish.
  vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  toastState.reset();
});

describe('BuildView', () => {
  it('is headed Build, with a row per repository, the task count, Cancel build and the selected repository run', async () => {
    const { container, advance } = await mount();
    await advance(2500);
    expect(container.querySelector('h1')!.textContent!.trim()).toBe('Build');
    const rows = Array.from(container.querySelectorAll('app-repo-status-list button'));
    expect(rows.map((r) => r.querySelector('.k-mono')!.textContent!.trim())).toEqual(['claims-core', 'customer-portal', 'review']);
    expect(text(container)).toContain('0/3 tasks');
    expect(button(container, 'Cancel build')).toBeDefined();
    expect(container.querySelectorAll('[data-repo-runs]:not([hidden]) app-observe-pane')).toHaveLength(1);
    expect(container.querySelector('.k-build__run-start')!.textContent).toContain('09:00:00');
    expect(button(container, 'Cancel')).toBeDefined();
  });

  it('shows another repository on its own when its row is picked', async () => {
    const { container, advance, fixture } = await mount();
    await advance(2500);
    (container.querySelectorAll('app-repo-status-list button')[1] as HTMLButtonElement).click();
    await advance(100);
    fixture.detectChanges();
    expect(container.querySelectorAll('[data-repo-runs]:not([hidden]) app-observe-pane')).toHaveLength(1);
    expect(text(container)).toContain('The report form already has a file picker');
  });

  it('says every task is in the build log and lists the findings, then Close releases the lock', async () => {
    const { container, fixture, vm, drive, lock, advance } = await mount();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    await drive(() => vm.phase() === 'finished' && vm.findings().length > 0);
    expect(text(container)).toContain('Every task is in the build log.');
    const items = Array.from(container.querySelectorAll('app-findings-list li .k-findings__text')).map((e) => e.firstChild!.textContent!.trim());
    expect(items).toEqual(['The upload limit is duplicated in claims-core and customer-portal.', 'The refusal message has no test.']);
    expect(button(container, 'Cancel build')).toBeUndefined();
    button(container, 'Close')!.click();
    await advance(100);
    expect(lock.active()).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('says the build stopped, lists what is left, and offers Continue for the selected repository', async () => {
    const transport = new MockTransport();
    const run = vi.spyOn(transport, 'runSpec').mockRejectedValue(new Error('no engine'));
    const { container, advance, vm } = await mount(transport);
    await advance(600);
    expect(vm.phase()).toBe('stopped');
    expect(text(container)).toContain('The build stopped. Nothing more can run.');
    expect(text(container)).toContain('claims-core');
    expect(text(container)).toContain('T1');
    expect(container.querySelector('.k-build__stop')!.textContent).toContain('customer-portal');
    expect(text(container)).toContain('Stopped: the agent failed');
    expect(button(container, 'Cancel')).toBeUndefined();
    const calls = run.mock.calls.length;
    button(container, 'Continue claims-core')!.click();
    await advance(300);
    expect(run.mock.calls.length).toBe(calls + 1);
  });
});

describe('BuildView watching and reviewing', () => {
  const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  type Mounted = Awaited<ReturnType<typeof mount>>;
  const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const tab = (c: HTMLElement, name: 'Activity' | 'Changes') => tabs(c).find((t) => norm(t.textContent).startsWith(name))!;
  const rowBtn = (c: HTMLElement, name: string) =>
    Array.from(c.querySelectorAll<HTMLButtonElement>('app-repo-status-list button')).find((b) => norm(b.querySelector('.k-mono')!.textContent) === name)!;
  const settle = async (m: Mounted, ms = 100) => {
    await m.advance(ms);
    m.fixture.detectChanges();
  };
  const choose = async (m: Mounted, name: 'Activity' | 'Changes') => {
    tab(m.container, name).click();
    await settle(m);
  };
  /** The items of one repository's observe pane, in order, by their text. */
  const paneItems = (c: HTMLElement, repo: string) =>
    Array.from(c.querySelectorAll(`[data-repo-runs="${repo}"] hlm-message-scroller-item`)).map((i) => norm(i.textContent).replace(/\d+ new below/, '').trim());
  /** Pushes an event into a run the way the engine would. */
  const emit = (transport: MockTransport, runId: string, ev: unknown) => (transport as unknown as { emit(id: string, e: unknown): void }).emit(runId, ev);
  const runIdOf = (m: Mounted, repo: string) => {
    m.vm.select(repo);
    return m.vm.shown()[0].id;
  };
  /** The mock transport's own entry points, wrapped so a call by name can be seen. */
  const watchTransport = (transport: MockTransport) => {
    const called: string[] = [];
    const own = new Set(['emit', 'play', 'adopt', 'begin', 'constructor']);
    for (const name of Object.getOwnPropertyNames(MockTransport.prototype)) {
      const original = (transport as unknown as Record<string, unknown>)[name];
      if (own.has(name) || typeof original !== 'function') continue;
      (transport as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        called.push(name);
        return (original as (...a: unknown[]) => unknown).apply(transport, args);
      };
    }
    return called;
  };

  it('switching tabs and repositories makes no transport call (R17.1)', async () => {
    const m = await mount();
    await settle(m, 6000);
    expect(m.lock.waiting()).toHaveLength(1);
    const called = watchTransport(m.transport);
    const elapsed = m.lock.elapsedSecs();
    const paused = m.vm.rows().find((r) => r.name === 'customer-portal')!.paused;
    for (let i = 0; i < 10; i++) {
      await choose(m, i % 2 === 0 ? 'Changes' : 'Activity');
      rowBtn(m.container, i % 2 === 0 ? 'customer-portal' : 'claims-core').click();
      await settle(m, 500);
    }
    expect(called).toEqual([]);
    expect(m.lock.elapsedSecs()).toBeGreaterThan(elapsed);
    expect(m.vm.rows().find((r) => r.name === 'customer-portal')!.paused).not.toBe(paused);
    expect(m.vm.active()).toBe(true);
  });

  it('keeps both tab panels and every repository pane mounted, hiding only the ones not shown', async () => {
    const m = await mount();
    await settle(m, 2500);
    const panels = Array.from(m.container.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.hidden)).toEqual([false, true]);
    expect(m.container.querySelectorAll('app-observe-pane')).toHaveLength(2);
    const visible = Array.from(m.container.querySelectorAll<HTMLElement>('[data-repo-runs]')).filter((e) => !e.hidden);
    expect(visible.map((e) => e.getAttribute('data-repo-runs'))).toEqual(['claims-core']);
    await choose(m, 'Changes');
    expect(panels.map((p) => p.hidden)).toEqual([true, false]);
    expect(m.container.querySelector('app-changes-view')).not.toBeNull();
  });

  it('events that arrive while on Changes are all shown on return, in order (R17.2)', async () => {
    const m = await mount();
    await settle(m, 450);
    const before = { core: paneItems(m.container, 'claims-core'), portal: paneItems(m.container, 'customer-portal') };
    expect(before.core.length).toBeGreaterThan(0);
    expect(before.portal.length).toBeGreaterThan(0);
    await choose(m, 'Changes');
    await settle(m, 1500);
    expect(norm(tab(m.container, 'Activity').textContent)).toMatch(/\d+ new/);
    expect(norm(rowBtn(m.container, 'customer-portal').textContent)).toMatch(/\d+ new/);
    await choose(m, 'Activity');
    const after = { core: paneItems(m.container, 'claims-core'), portal: paneItems(m.container, 'customer-portal') };
    expect(after.core.length).toBeGreaterThan(before.core.length);
    expect(after.portal.length).toBeGreaterThan(before.portal.length);
    expect(after.core.slice(0, before.core.length)).toEqual(before.core);
    expect(after.portal.slice(0, before.portal.length)).toEqual(before.portal);
    // The pane on show marks the first event it missed; the other repository still counts what it missed.
    const marker = m.container.querySelector('[data-repo-runs="claims-core"] [data-unseen]')!;
    expect(norm(marker.textContent)).toMatch(/^\d+ new below$/);
    const items = Array.from(m.container.querySelectorAll('[data-repo-runs="claims-core"] hlm-message-scroller-item'));
    expect(items.indexOf(marker.closest('hlm-message-scroller-item')!)).toBe(before.core.length);
    expect(norm(tab(m.container, 'Activity').textContent)).not.toMatch(/\d+ new/);
    expect(norm(rowBtn(m.container, 'claims-core').textContent)).not.toMatch(/\d+ new/);
    expect(norm(rowBtn(m.container, 'customer-portal').textContent)).toMatch(/\d+ new/);
    rowBtn(m.container, 'customer-portal').click();
    await settle(m);
    expect(norm(rowBtn(m.container, 'customer-portal').textContent)).not.toMatch(/\d+ new/);
  });

  it('a half-typed answer and the open file survive switching (R17.3)', async () => {
    const m = await mount();
    await settle(m, 2500);
    const answer = m.container.querySelector<HTMLInputElement>('[data-repo-runs="customer-portal"] input[aria-label="Other answer"]')!;
    answer.value = 'Reuse it, but';
    answer.dispatchEvent(new Event('input', { bubbles: true }));
    await choose(m, 'Changes');
    await settle(m, 300);
    const file = m.container.querySelector<HTMLButtonElement>('app-changes-view [data-file="src/limits.rs"]')!;
    file.click();
    await settle(m, 300);
    for (let i = 0; i < 4; i++) {
      await choose(m, 'Activity');
      await choose(m, 'Changes');
    }
    expect(m.container.querySelector<HTMLInputElement>('[data-repo-runs="customer-portal"] input[aria-label="Other answer"]')!.value).toBe('Reuse it, but');
    expect(m.container.querySelector('app-changes-view [data-file="src/limits.rs"]')!.getAttribute('aria-current')).toBe('true');
  });

  it("the build view's Changes tab marks uncommitted files and keeps everything else locked (R7.2)", async () => {
    const m = await mount();
    await settle(m, 1500);
    await choose(m, 'Changes');
    await settle(m, 300);
    expect(text(m.container)).toContain("The build is running. Uncommitted edits are the agents' work in progress and are marked with a dot.");
    expect(m.container.querySelectorAll('app-changes-view [data-uncommitted]').length).toBeGreaterThan(0);
    expect(m.lock.active()?.kind).toBe('build');
    expect(button(m.container, 'Close')).toBeUndefined();
  });

  it('the waiting notice names the repository and the countdown and does not switch (R17.5)', async () => {
    const m = await mount();
    await settle(m, 1600);
    await choose(m, 'Changes');
    const picked = m.vm.selected();
    const focused = document.activeElement;
    const notice = () => norm(m.container.querySelector('[role="tabpanel"]:not([hidden]) app-waiting-notice')?.textContent ?? null);
    expect(notice()).toContain('The agent in customer-portal is waiting for your answer.');
    expect(notice()).toMatch(/It stops if nobody answers within \d+:\d{2}\./);
    expect(notice()).toContain('Go to customer-portal');
    expect(m.container.querySelector('[aria-live="assertive"]')!.textContent).toContain('customer-portal');
    expect(norm(tab(m.container, 'Activity').textContent)).toContain('Waiting for you');
    expect(tab(m.container, 'Changes').getAttribute('aria-selected')).toBe('true');
    expect(m.vm.selected()).toBe(picked);
    expect(document.activeElement).toBe(focused);

    // A guarded action asks for approval.
    const core = runIdOf(m, 'claims-core');
    emit(m.transport, core, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'git push' });
    await settle(m, 100);
    const lines = Array.from(m.container.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-waiting]')).map((e) => norm(e.textContent));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('The agent in claims-core is waiting for your approval.'))).toBe(true);
    expect(tab(m.container, 'Changes').getAttribute('aria-selected')).toBe('true');
  });

  it('Go to the repository shows its question with focus, and answering clears the notice (R17.6)', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const m = await mount();
    await settle(m, 2500);
    await choose(m, 'Changes');
    const go = Array.from(m.container.querySelectorAll<HTMLButtonElement>('app-waiting-notice button')).find((b) => norm(b.textContent) === 'Go to customer-portal')!;
    go.click();
    await settle(m, 200);
    expect(tab(m.container, 'Activity').getAttribute('aria-selected')).toBe('true');
    expect(m.vm.selected()).toBe('customer-portal');
    const card = m.container.querySelector<HTMLElement>('[data-repo-runs="customer-portal"] app-ask-panel')!;
    expect(card.contains(document.activeElement)).toBe(true);
    expect(scrolled).toHaveBeenCalled();
    expect(text(m.container)).toContain('The report form already has a file picker');

    m.vm.answer(m.lock.waiting()[0].runId, { id: 'q1', answers: [['Reuse it']] });
    await settle(m, 200);
    expect(m.container.querySelector('app-waiting-notice [data-waiting]')).toBeNull();
    expect(m.lock.waiting()).toEqual([]);
  });

  it('the notice clears when the waiting run stops, and the stop is reported (R17.7)', async () => {
    const m = await mount();
    await settle(m, 2500);
    await choose(m, 'Changes');
    const portal = m.lock.waiting()[0].runId;
    expect(m.container.querySelector('app-waiting-notice [data-waiting]')).not.toBeNull();
    emit(m.transport, portal, { type: 'run.error', exit_code: 123, message: 'nobody answered' });
    await settle(m, 600);
    expect(m.container.querySelector('app-waiting-notice [data-waiting]')).toBeNull();
    expect(norm(m.container.querySelector('[aria-live="assertive"]')!.textContent)).not.toContain('customer-portal');
    expect(text(m.container)).toContain('Stopped: nobody answered');
  });

  it('the waiting repository is flagged in every view while the others keep folding (R19.4)', async () => {
    const m = await mount();
    await settle(m, 1600);
    const flagged = (name: string) => norm(rowBtn(m.container, name).textContent).includes('Waiting for you');
    const lines = () => Array.from(m.container.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-waiting]')).map((e) => norm(e.textContent));

    // Its own Activity: the row is flagged and the question is there.
    rowBtn(m.container, 'customer-portal').click();
    await settle(m);
    expect(flagged('customer-portal')).toBe(true);
    expect(lines()).toEqual([]);

    // Another repository's Activity: a one-line pinned banner.
    rowBtn(m.container, 'claims-core').click();
    await settle(m);
    expect(flagged('customer-portal')).toBe(true);
    expect(lines()).toEqual(['The agent in customer-portal is waiting for you. Go to customer-portal']);

    // Changes: the full notice. The other run's events keep arriving.
    await choose(m, 'Changes');
    expect(flagged('customer-portal')).toBe(true);
    expect(lines()).toHaveLength(1);
    const core = runIdOf(m, 'claims-core');
    const events = () => m.vm.shown()[0].events.length;
    const count = events();
    emit(m.transport, core, { type: 'assistant.text', text: 'still working' });
    await settle(m);
    expect(events()).toBe(count + 1);

    // Two waiting runs, two lines.
    emit(m.transport, core, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'git push' });
    await settle(m, 100);
    expect(lines()).toHaveLength(2);
    expect(flagged('claims-core')).toBe(true);
    await choose(m, 'Activity');
    rowBtn(m.container, 'customer-portal').click();
    await settle(m);
    expect(lines()).toEqual(['The agent in claims-core is waiting for you. Go to claims-core']);
  });
});
