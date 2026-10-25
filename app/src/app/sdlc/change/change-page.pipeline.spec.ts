import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { ChangePage } from './change-page';

const FIX = '2026-10-12-fnol-photo-upload';
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
    (await real(m, s)).map((c) => (c.change === FIX ? { ...c, stage: 'fix-awaiting' as const, track: 'fix' as const } : c)),
  );
  const realDoc = transport.sdlcReadDoc.bind(transport);
  vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (m, s, c, d) => (c === FIX && d === 'intent' ? FIX_INTENT : realDoc(m, s, c, d)));
  const decide = vi.spyOn(transport, 'sdlcDecide');
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change: FIX })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  const runner = TestBed.inject(SdlcRunner);
  const newChange = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened' });
  const error = vi.spyOn(TestBed.inject(ToastStore), 'error');
  return { ...out, transport, decide, newChange, error };
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
});
