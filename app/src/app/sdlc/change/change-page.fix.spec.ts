import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import { of } from 'rxjs';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { Stage } from '@bindings/Stage';
import { render } from '../../../testing/render';
import { LockStore } from '../../core/lock/lock.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import type { StageAction } from '../../lib/sdlc';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

const FIX = '2026-10-12-fnol-photo-upload';
const NEEDS = 'Needs ai-sdlc 0.13.0 or later.';
const BUSY = 'Another task is already running.';
const FIX_ACTIONS: StageAction[] = ['finish-fix-draft', 'accept-fix', 'change-fix', 'reopen-fix'];

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === label)!;
const confirmPreview = async () => {
  const start = () => button(document.body, 'Start run');
  await vi.waitFor(() => expect(start() && !start().disabled).toBe(true));
  start().click();
};

/** A fix at a stage, with the plugin supporting the light track or not, until the mock has its own fixture. */
async function mountFix(stage: Stage, lightTrack = true, track: 'fix' | 'full' = 'fix', docs: Partial<ChangeInfo> = {}) {
  const transport = new MockTransport();
  const real = transport.sdlcChanges.bind(transport);
  vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
    (await real(m, s)).map((c) => (c.change === FIX ? { ...c, stage, track, ...docs } : c)),
  );
  const ready = await transport.sdlcPluginReadiness(null);
  vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(ready.kind === 'ready' ? { ...ready, lightTrack } : ready);
  const run = vi.spyOn(transport, 'runSpec').mockResolvedValue('1');
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change: FIX })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  const vm = out.fixture.debugElement.injector.get(ChangePageViewModel);
  return { ...out, transport, run, vm };
}

afterEach(() => toastState.reset());

describe('ChangePage: the fix runs', () => {
  it('Accept fix previews and runs the fix skill with --accept in the auto mode (R4.2)', async () => {
    const { container, run } = await mountFix('fix-awaiting');
    expect(container.querySelector('[data-testid="track-tag"]')!.textContent!.trim()).toBe('fix');
    button(container, 'Accept fix').click();
    await settle();
    expect(document.body.querySelector('[role="dialog"] textarea')).toBeNull();
    await confirmPreview();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].task).toContain(`--accept ${FIX}`);
    expect(run.mock.calls[0][0].permissions.mode).toBe('auto');
  });

  it('a fix whose acceptance stopped reads Finish acceptance', async () => {
    const { container } = await mountFix('fix-accepting');
    expect(button(container, 'Finish acceptance')).toBeDefined();
    expect(button(container, 'Accept fix')).toBeUndefined();
  });

  it('Change the fix opens the feedback box and runs with the written changes (R5.1)', async () => {
    const { container, run } = await mountFix('fix-awaiting');
    button(container, 'Change the fix').click();
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(run).not.toHaveBeenCalled();
    const box = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'Also cover the retry button.';
    box.dispatchEvent(new Event('input'));
    await settle();
    button(dialog, 'Run').click();
    await confirmPreview();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].task).toContain('Operator feedback:\nAlso cover the retry button.');
  });

  it('Change the fix with an empty box runs nothing and shows the error', async () => {
    const { container, run } = await mountFix('fix-awaiting');
    button(container, 'Change the fix').click();
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    button(dialog, 'Run').click();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dialog.querySelector('.k-field__hint--error')!.textContent!.trim()).toBe('Write what should change.');
    expect(button(document.body, 'Start run')).toBeUndefined();
  });

  it('Reopen the fix at plan-out-of-date on a broken pin runs with an empty box', async () => {
    const { vm, run } = await mountFix('plan-out-of-date', true, 'fix', { out_of_date: 'spec-pin' });
    await vm.act('reopen-fix');
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('.k-field__hint--error')).toBeNull();
    button(dialog, 'Run').click();
    await confirmPreview();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('a fix whose statuses are not settled offers nothing and lists the statuses', async () => {
    const { container } = await mountFix('fix-unsettled');
    const notice = container.querySelector('[data-testid="doc-notice"]')!;
    expect(notice.textContent).toMatch(/intent: .+ · spec: .+ · plan: .+/);
    expect(button(container, 'Accept fix')).toBeUndefined();
  });

  it('the notice lists each document with the status HEAD holds, and not committed for one not in HEAD', async () => {
    const { container } = await mountFix('fix-unsettled', true, 'fix', {
      intent: { exists: true, committed: true, status: 'superseded', head_status: 'draft' },
      spec: { exists: true, committed: false, status: 'draft', head_status: null },
      plan: { exists: false, committed: false, status: null, head_status: null },
    });
    const text = container.querySelector('[data-testid="doc-notice"]')!.textContent!;
    expect(text).toContain('intent: superseded (HEAD: draft)');
    expect(text).toContain('spec: draft (HEAD: not committed)');
    expect(text).toContain('plan: missing');
    expect(text).not.toContain('plan: missing (HEAD');
  });

  it('reopening is disabled while a build run holds the lock, and refused with no run (R6.2)', async () => {
    const { container, vm, run } = await mountFix('build-ready');
    // The build tab has its own bar; the document tabs carry the page's actions, this one among them.
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent!.trim().startsWith('Intent'))!.click();
    await settle();
    expect(button(container, 'Reopen the fix')).toBeDefined();
    expect(button(container, 'Reopen the fix').disabled).toBe(false);
    expect(TestBed.inject(LockStore).beginBuild('Building')).toBe(true);
    await settle();
    expect(button(container, 'Reopen the fix').disabled).toBe(true);
    toastState.reset();
    await vm.act('reopen-fix');
    await settle();
    expect(toastText()).toContain(BUSY);
    expect(document.body.querySelector('[role="dialog"] textarea')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  describe('the Build tab bar (R6.1)', () => {
    const bar = (root: ParentNode) => root.querySelector('[data-bar]')!;
    const barButtons = (root: ParentNode) => Array.from(bar(root).querySelectorAll('button')).map((b) => b.textContent!.trim());

    for (const stage of ['build-ready', 'build-stopped', 'build-finished'] as const) {
      it(`a fix at ${stage} offers Reopen the fix last, and it opens the feedback box`, async () => {
        const { container, run } = await mountFix(stage);
        const labels = barButtons(container);
        expect(labels).toContain('Reopen the fix');
        expect(labels.indexOf('Reopen the fix')).toBeGreaterThan(0);
        button(bar(container), 'Reopen the fix').click();
        await settle();
        expect(document.body.querySelector('[role="dialog"] textarea')).not.toBeNull();
        expect(run).not.toHaveBeenCalled();
      });
    }

    it('is disabled while the lock is held', async () => {
      const { container } = await mountFix('build-finished');
      expect(button(bar(container), 'Reopen the fix').disabled).toBe(false);
      expect(TestBed.inject(LockStore).beginBuild('Building')).toBe(true);
      await settle();
      expect(button(bar(container), 'Reopen the fix').disabled).toBe(true);
    });

    it('a full-track change has no such button', async () => {
      const { container } = await mountFix('build-finished', true, 'full');
      expect(barButtons(container)).toContain('Declare done');
      expect(barButtons(container)).not.toContain('Reopen the fix');
    });
  });

  it('with the light track unsupported the fix actions are disabled and refuse, and the full pipeline stays (R10.1)', async () => {
    const { container, vm, run } = await mountFix('fix-awaiting', false, 'fix', { intent: { exists: true, committed: true, status: 'draft', head_status: 'draft' } });
    for (const label of ['Accept fix', 'Change the fix']) {
      expect(button(container, label).disabled).toBe(true);
      expect(button(container, label).title).toBe(NEEDS);
    }
    expect(button(container, 'Take the full pipeline instead').disabled).toBe(false);
    for (const action of FIX_ACTIONS) {
      toastState.reset();
      await vm.act(action);
      await settle();
      expect(toastText()).toBe(NEEDS);
    }
    expect(document.body.querySelector('[role="dialog"] textarea')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('every fix run is refused while another task runs, with no run started (R11.2)', async () => {
    const { vm, run } = await mountFix('fix-awaiting');
    expect(TestBed.inject(LockStore).beginBuild('Building')).toBe(true);
    for (const action of FIX_ACTIONS) {
      toastState.reset();
      await vm.act(action);
      await settle();
      expect(toastText()).toContain(BUSY);
    }
    expect(document.body.querySelector('[role="dialog"] textarea')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
