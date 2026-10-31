import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SdlcRunner } from '../core/sdlc/sdlc-runner';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { render } from '../../testing/render';
import { BranchNameDialog } from './branch-name-dialog';

/** Wires the dialog to the runner the way the change page does. */
@Component({
  selector: 'app-host',
  imports: [BranchNameDialog],
  template: `<app-branch-name-dialog
    [request]="runner.nameRequest()"
    (typeChange)="runner.setNameType($event)"
    (accept)="runner.confirmName($event)"
    (cancel)="runner.closeName()"
  />`,
})
class Host {
  readonly runner = inject(SdlcRunner);
}

const CHANGE = '2026-11-02-password-reset';
const ASK = { folder: '/ws', masterRepo: 'acme-docs', system: 'commerce', change: CHANGE, pending: 'change/pending-1', workType: null, track: 'full' as const };
const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const nameInput = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!;
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const type = async (value: string) => {
  nameInput().value = value;
  nameInput().dispatchEvent(new Event('input'));
  await settle();
};

async function open(transport = new MockTransport()) {
  vi.spyOn(transport, 'sdlcSuggestBranch').mockImplementation(async (_f, _m, _s, _c, workType) => `${workType}/PROJ-123-password-reset`);
  await render(Host, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
  const runner = TestBed.inject(SdlcRunner);
  const result = runner.requestName(ASK);
  await settle();
  return { transport, runner, result };
}

describe('BranchNameDialog', () => {
  it('renders nothing without a request', async () => {
    await render(Host, {}, [provideRouter([]), { provide: KataTransport, useValue: new MockTransport() }]);
    expect(dialog()).toBeNull();
  });

  it('accepting the suggested name names the change branch (R6.1)', async () => {
    const { transport, result } = await open();
    const confirm = vi.spyOn(transport, 'sdlcConfirmBranch');
    expect(nameInput().value).toBe('feat/PROJ-123-password-reset');
    button('Accept').click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('/ws', 'acme-docs', 'commerce', CHANGE, 'change/pending-1', 'feat/PROJ-123-password-reset', 'feat');
    expect(await result).toEqual({ branch: 'feat/PROJ-123-password-reset', change: CHANGE });
    expect(dialog()).toBeNull();
  });

  it('an edited name becomes the change branch (R6.2)', async () => {
    const { transport, result } = await open();
    const confirm = vi.spyOn(transport, 'sdlcConfirmBranch');
    await type('feature/PROJ-123');
    button('Accept').click();
    await settle();
    expect(confirm.mock.calls[0][5]).toBe('feature/PROJ-123');
    expect((await result)?.branch).toBe('feature/PROJ-123');
  });

  it('changing the type refreshes the suggestion, unless the name was edited', async () => {
    await open();
    const pick = async (t: string) => {
      TestBed.inject(SdlcRunner).setNameType(t as never);
      await settle();
    };
    await pick('refactor');
    expect(nameInput().value).toBe('refactor/PROJ-123-password-reset');
    await type('feature/PROJ-123');
    await pick('docs');
    expect(nameInput().value).toBe('feature/PROJ-123');
  });

  it('shows the backend refusal under the field and stays open', async () => {
    const { transport } = await open();
    vi.spyOn(transport, 'sdlcConfirmBranch').mockRejectedValue(new Error('feat/x clashes with feat/x in acme-docs'));
    button('Accept').click();
    await settle();
    expect(dialog()!.textContent).toContain('feat/x clashes with feat/x in acme-docs');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('closing leaves everything as it is', async () => {
    const { transport, result } = await open();
    const confirm = vi.spyOn(transport, 'sdlcConfirmBranch');
    button('Cancel').click();
    await settle();
    expect(await result).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
