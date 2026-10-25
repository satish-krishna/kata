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

const FIX = '2026-10-12-fnol-photo-upload';
const FIX_BRANCH = `change/${FIX}`;
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
  const real = transport.sdlcChanges.bind(transport);
  vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
    (await real(m, s)).map((c) => (c.change === FIX ? { ...c, stage: 'fix-awaiting' as const, track: 'fix' as const, fix_row: 6, intent: { ...c.intent, status: 'draft', head_status: 'draft' } } : c)),
  );
  const realDoc = transport.sdlcReadDoc.bind(transport);
  vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (m, s, c, d) => (c === FIX && d === 'intent' ? FIX_INTENT : realDoc(m, s, c, d)));
  const realBranches = transport.sdlcBranches.bind(transport);
  vi.spyOn(transport, 'sdlcBranches').mockImplementation(async (m) => ({ ...(await realBranches(m)), current: FIX_BRANCH }));
  const decide = vi.spyOn(transport, 'sdlcDecide');
  const checkout = vi.spyOn(transport, 'sdlcCheckout');
  const params = new BehaviorSubject(convertToParamMap({ system: 'claims', change: FIX }));
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: params, snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  const runner = TestBed.inject(SdlcRunner);
  const newChange = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: NEW, branch: NEW_BRANCH });
  const error = vi.spyOn(TestBed.inject(ToastStore), 'error');
  return { ...out, transport, decide, checkout, newChange, error, params };
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
    const { container, decide, newChange } = await mountFix();
    await take(container);
    button(dialog()!, 'Cancel').click();
    await settle();
    expect(decide).not.toHaveBeenCalled();
    expect(newChange).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('starting opens the new change on the full track with the description, then closes the fix (R7.1)', async () => {
    const { container, decide, newChange } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(newChange).toHaveBeenCalledTimes(1);
    expect(newChange.mock.calls[0][1]).toBe('claims');
    expect(newChange.mock.calls[0][2]).toBe(IDEA);
    expect(newChange.mock.calls[0][3]).toBe('full');
    expect(decide.mock.calls[0].slice(1)).toEqual(['claims', FIX, 'reject-intent', false]);
    expect(newChange.mock.invocationCallOrder[0]).toBeLessThan(decide.mock.invocationCallOrder[0]);
  });

  it.each([
    ['refused', { kind: 'refused' as const }],
    ['stopped', { kind: 'stopped' as const }],
    ['none', { kind: 'none' as const, idea: IDEA, runId: 'r1' }],
  ])('a new change that came to %s leaves the fix open, with no extra toast (R7.1)', async (_name, outcome) => {
    const { container, decide, newChange, error } = await mountFix();
    newChange.mockResolvedValue(outcome);
    await take(container);
    await start();
    await vi.waitFor(() => expect(newChange).toHaveBeenCalledTimes(1));
    await settle();
    expect(decide).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a new change that throws leaves the fix open and says so (R7.1)', async () => {
    const { container, decide, newChange, error } = await mountFix();
    newChange.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Could not start the change: boom'));
    await settle();
    expect(decide).not.toHaveBeenCalled();
  });

  it('a fix that git refuses to close after the new change opened says so and stays open', async () => {
    const { container, decide, error } = await mountFix();
    decide.mockResolvedValue({ kind: 'gitFailed', stderr: 'index.lock exists' });
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('index.lock exists'));
  });

  it('a transport error while closing the fix says the new change started and the fix stays open', async () => {
    const { container, decide, error } = await mountFix();
    decide.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('other edits ask first, after the new change opened: confirming commits the rejection against the fix', async () => {
    const { container, decide, newChange } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    expect(newChange).toHaveBeenCalledTimes(1);
    button(document.body, 'Commit').click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide.mock.calls.map((c) => c[4])).toEqual([false, true]);
    expect(decide.mock.calls[1].slice(1, 4)).toEqual(['claims', FIX, 'reject-intent']);
  });

  // The new change's branch is checked out once it opened, so the fix's documents are on a different branch.
  const order = (...mocks: { mock: { invocationCallOrder: number[] } }[]) => mocks.flatMap((m) => m.mock.invocationCallOrder).sort((a, b) => a - b);

  it('closes the fix on its own branch, then returns to the new change: checkout fix, decide, checkout new', async () => {
    const { container, decide, checkout, newChange } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    expect(checkout.mock.calls.map((c) => c[1])).toEqual([FIX_BRANCH, NEW_BRANCH]);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0].slice(1)).toEqual(['claims', FIX, 'reject-intent', false]);
    expect(order(newChange, checkout)).toEqual([
      newChange.mock.invocationCallOrder[0],
      checkout.mock.invocationCallOrder[0],
      checkout.mock.invocationCallOrder[1],
    ]);
    expect(checkout.mock.invocationCallOrder[0]).toBeLessThan(decide.mock.invocationCallOrder[0]);
    expect(decide.mock.invocationCallOrder[0]).toBeLessThan(checkout.mock.invocationCallOrder[1]);
  });

  it('a fix that lives on the new change branch needs no checkout', async () => {
    const { container, decide, checkout, newChange } = await mountFix();
    newChange.mockResolvedValue({ kind: 'opened', change: NEW, branch: FIX_BRANCH });
    await take(container);
    await start();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await settle();
    expect(checkout).not.toHaveBeenCalled();
  });

  it('a checkout of the fix branch that fails decides nothing and says the fix stays open', async () => {
    const { container, decide, checkout, error } = await mountFix();
    checkout.mockRejectedValueOnce(new Error('working tree is dirty'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    await settle();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('working tree is dirty'));
    expect(decide).not.toHaveBeenCalled();
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('a decision that fails still returns to the new change and says the fix stays open', async () => {
    const { container, decide, checkout, error } = await mountFix();
    decide.mockResolvedValue({ kind: 'gitFailed', stderr: 'index.lock exists' });
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(checkout.mock.calls.map((c) => c[1])).toEqual([FIX_BRANCH, NEW_BRANCH]);
  });

  it('a decision that throws still returns to the new change and says the fix stays open', async () => {
    const { container, decide, checkout, error } = await mountFix();
    decide.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix')));
    expect(checkout.mock.calls.map((c) => c[1])).toEqual([FIX_BRANCH, NEW_BRANCH]);
  });

  it('failing to return to the new change says where the master repository and the new change are', async () => {
    const { container, checkout, error } = await mountFix();
    checkout.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cannot switch'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(`on ${FIX_BRANCH}`)));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(NEW_BRANCH));
  });

  it('the other-edits confirm keeps the master on the fix branch until it is answered, then returns', async () => {
    const { container, decide, checkout } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    expect(checkout.mock.calls.map((c) => c[1])).toEqual([FIX_BRANCH]);
    button(document.body, 'Commit').click();
    await vi.waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(checkout.mock.calls[1][1]).toBe(NEW_BRANCH);
  });

  it('declining that confirm returns to the new change too', async () => {
    const { container, decide, checkout } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    button(document.body, 'Cancel').click();
    await vi.waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(checkout.mock.calls[1][1]).toBe(NEW_BRANCH);
  });

  it('declining that confirm leaves the fix open and says so', async () => {
    const { container, decide, error } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    button(document.body, 'Cancel').click();
    await settle();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('The new change started, but the fix'));
  });

  // The real runner navigates to the new change before it resolves; the page and its ViewModel are reused.
  const navigatesToNew = (m: { newChange: { mockImplementation: (f: () => Promise<{ kind: 'opened'; change: string; branch: string }>) => unknown }; params: BehaviorSubject<ReturnType<typeof convertToParamMap>> }) =>
    m.newChange.mockImplementation(async () => {
      m.params.next(convertToParamMap({ system: 'claims', change: NEW }));
      return { kind: 'opened', change: NEW, branch: NEW_BRANCH };
    });

  it('closes the fix, not the new change, when the page already moved to the new change (R7.1)', async () => {
    const m = await mountFix();
    navigatesToNew(m);
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.checkout).toHaveBeenCalledTimes(2));
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide.mock.calls[0].slice(1)).toEqual(['claims', FIX, 'reject-intent', false]);
    expect(m.checkout.mock.invocationCallOrder[0]).toBeLessThan(m.decide.mock.invocationCallOrder[0]);
    expect(m.decide.mock.invocationCallOrder[0]).toBeLessThan(m.checkout.mock.invocationCallOrder[1]);
  });

  it('confirming other edits after the page moved still closes the fix', async () => {
    const m = await mountFix();
    navigatesToNew(m);
    m.decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    button(document.body, 'Commit').click();
    await vi.waitFor(() => expect(m.decide).toHaveBeenCalledTimes(2));
    expect(m.decide.mock.calls.map((c) => c.slice(1))).toEqual([
      ['claims', FIX, 'reject-intent', false],
      ['claims', FIX, 'reject-intent', true],
    ]);
  });

  it('names the fix, not the new change, in the failure toast after the page moved (R7.4)', async () => {
    const m = await mountFix();
    navigatesToNew(m);
    m.decide.mockResolvedValue({ kind: 'gitFailed', stderr: 'index.lock exists' });
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.error).toHaveBeenCalledWith(expect.stringContaining(`the fix ${FIX} could not be closed`)));
  });

  it('a workspace change during the intent run does not move the close to another master (R7.1)', async () => {
    const m = await mountFix();
    const vm = m.fixture.debugElement.injector.get(ChangePageViewModel);
    m.newChange.mockImplementation(async () => {
      vm.workspaces.update((ws) => ws.map((w) => ({ ...w, folder: 'D:/elsewhere', last_opened: w.last_opened + 1000 })));
      return { kind: 'opened', change: NEW, branch: NEW_BRANCH };
    });
    await take(m.container);
    await start();
    await vi.waitFor(() => expect(m.checkout).toHaveBeenCalledTimes(2));
    const masters = new Set([...m.checkout.mock.calls.map((c) => c[0]), ...m.decide.mock.calls.map((c) => c[0])]);
    expect([...masters]).toHaveLength(1);
    expect([...masters][0]).not.toContain('elsewhere');
  });

  it('the other-edits confirm on that path names the fix', async () => {
    const { container, decide } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    expect(document.body.textContent).toContain(`${FIX}'s intent.md has other uncommitted edits; rejecting the fix commits them too.`);
  });
});
