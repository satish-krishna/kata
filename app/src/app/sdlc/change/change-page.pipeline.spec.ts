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
  it('opens the new-change dialog on the full pipeline with the fix as the description and a note', async () => {
    const { container } = await mountFix();
    await take(container);
    expect(dialog()!.textContent).toContain('Full pipeline');
    expect(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(IDEA);
    expect(dialog()!.textContent).toContain(`This closes the drafted fix ${FIX}.`);
    expect(dialog()!.querySelector('[role="radio"][aria-checked="true"]')!.textContent!.trim()).toBe('Full pipeline');
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

  it('starting rejects the fix, then starts the new change on the full track with the description (R7.1)', async () => {
    const { container, decide, newChange } = await mountFix();
    await take(container);
    await start();
    await vi.waitFor(() => expect(newChange).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0].slice(1)).toEqual(['claims', FIX, 'reject-intent', false]);
    expect(newChange.mock.calls[0][1]).toBe('claims');
    expect(newChange.mock.calls[0][2]).toBe(IDEA);
    expect(newChange.mock.calls[0][3]).toBe('full');
    expect(decide.mock.invocationCallOrder[0]).toBeLessThan(newChange.mock.invocationCallOrder[0]);
  });

  it('a refused commit shows the error and never starts the new change (R7.1)', async () => {
    const { container, decide, newChange, error } = await mountFix();
    decide.mockResolvedValue({ kind: 'gitFailed', stderr: 'index.lock exists' });
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('index.lock exists'));
    expect(newChange).not.toHaveBeenCalled();
  });

  it('a transport error shows and never starts the new change (R7.1)', async () => {
    const { container, decide, newChange, error } = await mountFix();
    decide.mockRejectedValue(new Error('boom'));
    await take(container);
    await start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Could not record the decision: boom'));
    expect(newChange).not.toHaveBeenCalled();
  });

  it('other edits ask first: confirming commits and then starts, cancelling records nothing more', async () => {
    const { container, decide, newChange } = await mountFix();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    expect(newChange).not.toHaveBeenCalled();
    button(document.body, 'Commit').click();
    await vi.waitFor(() => expect(newChange).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls.map((c) => c[4])).toEqual([false, true]);
    expect(decide.mock.invocationCallOrder[1]).toBeLessThan(newChange.mock.invocationCallOrder[0]);

    decide.mockClear();
    newChange.mockClear();
    decide.mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
    await take(container);
    await start();
    await vi.waitFor(() => expect(button(document.body, 'Commit')).toBeDefined());
    button(document.body, 'Cancel').click();
    await settle();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(newChange).not.toHaveBeenCalled();
  });
});
