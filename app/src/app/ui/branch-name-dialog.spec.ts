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
  template: `<app-branch-name-dialog [request]="runner.nameRequest()" (accept)="runner.confirmName($event)" (cancel)="runner.closeName()" />`,
})
class Host {
  readonly runner = inject(SdlcRunner);
}

const CHANGE = '2026-11-02-password-reset';
const ASK = { folder: '/ws', workspaceId: 'acme', system: 'commerce', change: CHANGE, current: `change/${CHANGE}` };
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
  await render(Host, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
  const runner = TestBed.inject(SdlcRunner);
  const result = runner.requestRename(ASK);
  await settle();
  return { transport, runner, result };
}

describe('BranchNameDialog', () => {
  it('renders nothing without a request', async () => {
    await render(Host, {}, [provideRouter([]), { provide: KataTransport, useValue: new MockTransport() }]);
    expect(dialog()).toBeNull();
  });

  it('starts from the branch the change has now and offers no work type', async () => {
    await open();
    expect(nameInput().value).toBe(`change/${CHANGE}`);
    expect(dialog()!.querySelector('hlm-select')).toBeNull();
  });

  it('an edited name renames the change branch everywhere', async () => {
    const { transport, result } = await open();
    const rename = vi.spyOn(transport, 'sdlcRenameBranch');
    await type('feature/PROJ-123');
    button('Accept').click();
    await settle();
    expect(rename).toHaveBeenCalledWith('/ws', 'acme', 'commerce', CHANGE, 'feature/PROJ-123');
    expect((await result)?.branch).toBe('feature/PROJ-123');
    expect(dialog()).toBeNull();
  });

  it('shows the backend refusal under the field and stays open', async () => {
    const { transport } = await open();
    vi.spyOn(transport, 'sdlcRenameBranch').mockRejectedValue(new Error('feat/x clashes with feat/x in acme-docs'));
    await type('feat/x');
    button('Accept').click();
    await settle();
    expect(dialog()!.textContent).toContain('feat/x clashes with feat/x in acme-docs');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the plugin reasons as it gave them when it renames nothing', async () => {
    const { transport } = await open();
    vi.spyOn(transport, 'sdlcRenameBranch').mockResolvedValue({ outcome: 'refused', problems: ['feat/x: a branch name cannot contain a space', 'the copy has uncommitted files'] });
    await type('feat/x');
    button('Accept').click();
    await settle();
    expect(dialog()!.textContent).toContain('feat/x: a branch name cannot contain a space');
    expect(dialog()!.textContent).toContain('the copy has uncommitted files');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('closing leaves everything as it is', async () => {
    const { transport, result } = await open();
    const rename = vi.spyOn(transport, 'sdlcRenameBranch');
    button('Cancel').click();
    await settle();
    expect(await result).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
