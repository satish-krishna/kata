import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { render } from '../../../testing/render';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

const FIX = '2026-10-12-product-photo-upload';
const NEW = '2026-10-25-double-refund';
const NEW_BRANCH = `change/${NEW}`;
const FIX_INTENT = '---\ntitle: Stop the double refund\nstatus: draft\n---\n\n## Problem\n\nA refund is paid twice when the button is clicked twice.\n\n## Fix\n\nDisable the button.\n';
const IDEA = 'Stop the double refund\n\nA refund is paid twice when the button is clicked twice.';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === label)!;
const dialog = () => document.body.querySelector('[role="dialog"]');

/** A fix awaiting acceptance, until the mock has its own fixture. */
async function mountFix() {
  const transport = new MockTransport();
  transport.patchChange(FIX, { stage: 'fix-awaiting', track: 'fix', fix_row: 6, intent: { exists: true, committed: true, status: 'draft', head_status: 'draft' } });
  const realDoc = transport.sdlcReadDoc.bind(transport);
  vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (r, d) => (r.change === FIX && d === 'intent' ? FIX_INTENT : realDoc(r, d)));
  const reject = vi.spyOn(transport, 'sdlcReject');
  const checkout = vi.spyOn(transport, 'sdlcCheckout');
  const params = new BehaviorSubject(convertToParamMap({ system: 'commerce', change: FIX }));
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: params, snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  const runner = TestBed.inject(SdlcRunner);
  const newChange = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: NEW, branch: NEW_BRANCH });
  const error = vi.spyOn(TestBed.inject(ToastStore), 'error');
  const success = vi.spyOn(TestBed.inject(ToastStore), 'success');
  return { ...out, transport, reject, checkout, newChange, error, success, params };
}

const take = async (container: HTMLElement) => {
  button(container, 'Take the full pipeline instead').click();
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await settle();
};
const start = async () => {
  button(dialog()!, 'Start').click();
  await settle();
};

describe('ChangePage: the full pipeline instead of a drafted fix', () => {
  it('opens the new-change dialog with the fix as the description and a note', async () => {
    const { container } = await mountFix();
    await take(container);
    expect(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(IDEA);
    expect(dialog()!.textContent).toContain(`This closes the drafted fix ${FIX}.`);
  });

  it('does not offer a track to pick: the new change is always the full pipeline', async () => {
    const { container } = await mountFix();
    await take(container);
    expect(dialog()!.querySelector('[role="radio"]')).toBeNull();
    expect(dialog()!.textContent).not.toContain('Let the workflow decide');
  });

  it('cancelling records nothing and starts nothing (R7.2)', async () => {
    const { container, reject, newChange } = await mountFix();
    await take(container);
    button(dialog()!, 'Cancel').click();
    await settle();
    expect(reject).not.toHaveBeenCalled();
    expect(newChange).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('starting opens the new change on the full track with the description, then the plugin rejects the fix (R7.1)', async () => {
    const { container, reject, newChange } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(newChange).toHaveBeenCalledTimes(1);
    expect(newChange.mock.calls[0][1]).toBe('commerce');
    expect(newChange.mock.calls[0][2]).toBe(IDEA);
    expect(newChange.mock.calls[0][3]).toBe('full');
    expect(reject.mock.calls[0][0]).toEqual({ workspace: expect.any(String), system: 'commerce', change: FIX });
    expect(newChange.mock.invocationCallOrder[0]).toBeLessThan(reject.mock.invocationCallOrder[0]);
  });

  it('switches no branch in the master: the fix has its own copy, so the plugin alone closes it', async () => {
    const { container, reject, checkout } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    await settle();
    expect(checkout).not.toHaveBeenCalled();
  });

  it('says once that the fix is rejected and its record stays on its branch', async () => {
    const { container, reject, success } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    await settle();
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(`Rejected. Its record stays on branch \`change/${FIX}\`.`);
  });

  describe('the naming setting is read before the new change starts (R3.2)', () => {
    it.each([
      ['unusable', { kind: 'error' as const, reason: 'unusable' as const, message: 'the branch pattern has no {slug}' }, 'the branch pattern has no {slug}'],
      ['newer plugin', { kind: 'error' as const, reason: 'pluginTooOld' as const, message: 'needs plugin 0.14.0' }, 'needs plugin 0.14.0'],
    ])('a setting that is %s starts nothing and names the problem', async (_n, answer, text) => {
      const { container, transport, reject, newChange, error } = await mountFix();
      vi.spyOn(transport, 'sdlcNaming').mockResolvedValue(answer as never);
      await take(container);
      await start();
      await settle();
      expect(newChange).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`Naming for commerce cannot be used: ${text}`));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('until then no change can start here'));
    });

    it('names the base branch the backend resolves, not a stored one', async () => {
      const { container, transport, error } = await mountFix();
      vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'main', others: [], default_base: 'develop' });
      vi.spyOn(transport, 'sdlcNaming').mockResolvedValue({ kind: 'error', reason: 'unusable', message: 'no {slug}' } as never);
      await take(container);
      await start();
      await settle();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('committed to develop;'));
    });

    it('a setting that cannot be read starts nothing and names the problem', async () => {
      const { container, transport, newChange, error } = await mountFix();
      vi.spyOn(transport, 'sdlcNaming').mockRejectedValue(new Error('ipc down'));
      await take(container);
      await start();
      await settle();
      expect(newChange).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Naming for commerce cannot be used: ipc down'));
    });

    it.each([
      ['no setting', { kind: 'none' as const }],
      ['a usable setting', { kind: 'setting' as const, pullRequestTitle: '{type}({scope}): {title}', branch: '{type}/{scope}-{slug}' }],
    ])('%s still starts the change as before', async (_n, answer) => {
      const { container, transport, reject, newChange } = await mountFix();
      vi.spyOn(transport, 'sdlcNaming').mockResolvedValue(answer as never);
      await take(container);
      await start();
      await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
      expect(newChange).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['refused', { kind: 'refused' as const }],
    ['stopped', { kind: 'stopped' as const }],
    ['none', { kind: 'none' as const, idea: IDEA, runId: 'r1' }],
  ])('a new change that came to %s leaves the fix open, with no extra toast (R7.1)', async (_name, outcome) => {
    const { container, reject, newChange, error } = await mountFix();
    newChange.mockResolvedValue(outcome);
    await take(container);
    await start();
    await vi.waitFor(() => expect(newChange).toHaveBeenCalledTimes(1));
    await settle();
    expect(reject).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a stopped start of the new change is said in a toast and leaves the fix open', async () => {
    const { container, reject, newChange, error } = await mountFix();
    const info = vi.spyOn(TestBed.inject(ToastStore), 'info');
    newChange.mockResolvedValue({ kind: 'startStopped', answer: ['the plugin ran out of room'] });
    await take(container);
    await start();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('Stopped. The start did not finish: the plugin ran out of room'));
    expect(reject).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a stopped rejection of the fix names the fix, not the intent', async () => {
    const { container, reject } = await mountFix();
    const info = vi.spyOn(TestBed.inject(ToastStore), 'info');
    reject.mockResolvedValue({ outcome: 'stopped', rejected: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(`Stopped. The fix is rejected; its copy was not removed (the fix ${FIX})`));
  });

  it('a new change that throws leaves the fix open and says so (R7.1)', async () => {
    const { container, reject, newChange, error } = await mountFix();
    newChange.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Could not start the change: boom'));
    await settle();
    expect(reject).not.toHaveBeenCalled();
  });

  it.each([
    ['the plugin refuses it', { outcome: 'refused' as const, message: '`x` has uncommitted changes. Commit or discard them first.' }, 'has uncommitted changes. Commit or discard them first.'],
    ['a git hook refuses the commit', { outcome: 'notCommitted' as const, problems: ['hook says no'] }, 'hook says no'],
    ['the plugin cannot run', { outcome: 'couldNotRun' as const, message: 'node is missing' }, 'node is missing'],
  ])('a fix the plugin does not close because %s says so and stays open', async (_why, outcome, text) => {
    const { container, reject, error } = await mountFix();
    reject.mockResolvedValue(outcome);
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(text));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('It stays open.'));
  });

  it('a rejection whose copy the plugin would not remove says the fix is rejected and shows its reasons as they are', async () => {
    const { container, reject, error } = await mountFix();
    reject.mockResolvedValue({ outcome: 'rejectedNotRemoved', problems: ['notes.txt is not committed'] });
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(`the fix ${FIX} is rejected, but its copy was not removed: notes.txt is not committed`)));
  });

  it('a transport error while closing the fix says the new change started and the fix stays open', async () => {
    const { container, reject, error } = await mountFix();
    reject.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  // The real runner navigates to the new change before it resolves; the page and its ViewModel are reused.
  const navigatesToNew = (m: { newChange: { mockImplementation: (f: () => Promise<{ kind: 'opened'; change: string; branch: string }>) => unknown }; params: BehaviorSubject<ReturnType<typeof convertToParamMap>> }) =>
    m.newChange.mockImplementation(async () => {
      m.params.next(convertToParamMap({ system: 'commerce', change: NEW }));
      return { kind: 'opened', change: NEW, branch: NEW_BRANCH };
    });

  it('closes the fix, not the new change, when the page already moved to the new change (R7.1)', async () => {
    const m = await mountFix();
    navigatesToNew(m);
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.reject).toHaveBeenCalledTimes(1));
    expect(m.reject.mock.calls[0][0]).toEqual({ workspace: expect.any(String), system: 'commerce', change: FIX });
  });

  it('names the fix, not the new change, in the failure toast after the page moved (R7.4)', async () => {
    const m = await mountFix();
    navigatesToNew(m);
    m.reject.mockResolvedValue({ outcome: 'notCommitted', problems: ['index.lock exists'] });
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.error).toHaveBeenCalledWith(expect.stringContaining(`the fix ${FIX} could not be closed`)));
  });

  it('a workspace change during the intent run does not move the close to another workspace (R7.1)', async () => {
    const m = await mountFix();
    const opened = m.reject.mock.calls.length;
    const vm = m.fixture.debugElement.injector.get(ChangePageViewModel);
    const folder = vm.current()!.folder;
    m.newChange.mockImplementation(async () => {
      vm.workspaces.update((ws) => ws.map((w) => ({ ...w, folder: 'D:/elsewhere', last_opened: w.last_opened + 1000 })));
      return { kind: 'opened', change: NEW, branch: NEW_BRANCH };
    });
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.reject).toHaveBeenCalledTimes(opened + 1));
    expect(m.reject.mock.calls[0][0].workspace).toBe(folder);
  });
});
