import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import { render } from '../../../testing/render';
import { LockStore } from '../../core/lock/lock.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildView } from './build-view';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

const CTX: BuildContext = { workspaceId: 'acme-claims', folder: MOCK_WORKSPACE_FOLDER, system: 'claims', change: MOCK_BUILD_CHANGE };

async function mount(transport = new MockTransport()) {
  const out = await transport.sdlcBuildPrepare(MOCK_WORKSPACE_FOLDER, MOCK_MASTER, 'claims', MOCK_BUILD_CHANGE, false);
  if (out.kind !== 'ready') throw new Error('the mock build did not prepare');
  const handoff: BuildHandoff = { start: out.start, timeoutSecs: 5400, round: null, checksDir: await transport.sdlcChecksDir() };
  const view = await render(BuildView, { handoff, context: CTX }, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0));
});
afterEach(() => {
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
    expect(container.querySelectorAll('app-observe-pane')).toHaveLength(1);
    expect(container.querySelector('.k-build__run-start')!.textContent).toContain('09:00:00');
    expect(button(container, 'Cancel')).toBeDefined();
  });

  it('shows another repository on its own when its row is picked', async () => {
    const { container, advance, fixture } = await mount();
    await advance(2500);
    (container.querySelectorAll('app-repo-status-list button')[1] as HTMLButtonElement).click();
    await advance(100);
    fixture.detectChanges();
    expect(container.querySelectorAll('app-observe-pane')).toHaveLength(1);
    expect(text(container)).toContain('The report form already has a file picker');
  });

  it('says every task is in the build log and lists the findings, then Close releases the lock', async () => {
    const { container, fixture, vm, drive, lock, advance } = await mount();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    await drive(() => vm.phase() === 'finished' && vm.findings().length > 0);
    expect(text(container)).toContain('Every task is in the build log.');
    const items = Array.from(container.querySelectorAll('app-findings-list li .k-findings__text')).map((e) => e.textContent!.trim());
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
