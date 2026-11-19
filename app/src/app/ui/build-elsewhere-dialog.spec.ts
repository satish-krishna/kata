import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { StartOutcome } from '@bindings/StartOutcome';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../lib/sdlc-mock';
import { BuildPageViewModel, type BuildContext, type ElsewhereRequest } from '../sdlc/build/build-page.view-model';
import { readAllChanges } from '../../testing/read-all';
import { render } from '../../testing/render';
import { BuildElsewhereDialog } from './build-elsewhere-dialog';

const FOLDER = MOCK_WORKSPACE_FOLDER;
const CTX: BuildContext = { workspaceId: 'acme-commerce', folder: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE, systemRepos: [] };
const REF = { workspace: FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };

const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const dialog = () => document.body.querySelector('[role="dialog"], [role="alertdialog"]');
const button = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => text(b).startsWith(label))!;
const maybe = (over: Partial<Extract<StartOutcome, { kind: 'mayBeRunningElsewhere' }>> = {}): StartOutcome => ({ kind: 'mayBeRunningElsewhere', repos: ['kata'], since: '2026-11-18T14:54:00Z', runningCheck: null, ...over });
const request = (over: Partial<ElsewhereRequest> = {}): ElsewhereRequest => ({ repos: ['kata'], since: '2026-11-18T14:54:00Z', runningCheck: null, ...over });

/** Stands in for the change page, which provides the build page's view model and wires its dialog. */
@Component({
  imports: [BuildElsewhereDialog],
  template: '<app-build-elsewhere-dialog [request]="vm.elsewhereRequest()" (confirm)="vm.confirmElsewhere()" (cancel)="vm.cancelElsewhere()" />',
  providers: [BuildPageViewModel, RunPreviewViewModel],
})
class Host {
  readonly vm = inject(BuildPageViewModel);
}

async function opened() {
  const transport = new MockTransport();
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: KataTransport, useValue: transport }] });
  const fixture = TestBed.createComponent(Host);
  const status = await transport.sdlcBuildStatus(REF);
  const [change] = (await readAllChanges(transport, FOLDER)).filter((c) => c.state.change === MOCK_BUILD_CHANGE);
  await fixture.componentInstance.vm.load({ ctx: CTX, masterRepo: MOCK_MASTER, change, status, done: false, review: null });
  return { fixture, vm: fixture.componentInstance.vm, transport, preview: fixture.debugElement.injector.get(RunPreviewViewModel) };
}

describe('BuildElsewhereDialog asks before a build that may be running elsewhere starts', () => {
  it('renders nothing while there is nothing to ask', async () => {
    await render(BuildElsewhereDialog, { request: null });
    expect(dialog()).toBeNull();
  });

  it('is a titled dialog that says the build may be running in another session and when starting is safe r9.1', async () => {
    await render(BuildElsewhereDialog, { request: request() });
    const open = dialog()!;
    expect(open).not.toBeNull();
    expect(open.getAttribute('aria-labelledby')).not.toBeNull();
    expect(text(document.getElementById(open.getAttribute('aria-labelledby')!)!)).toContain('may already be running');
    expect(text(open)).toContain('may be running in another session');
    expect(text(open)).toContain('starting is safe if that session crashed or was closed');
    expect(text(open)).toContain('kata');
  });

  it('names the check the workflow reports running now r9.1', async () => {
    await render(BuildElsewhereDialog, { request: request({ runningCheck: 'app-unit' }) });
    expect(text(dialog()!)).toContain('running in another session now, on app-unit');
    expect(text(dialog()!)).not.toContain('crashed or was closed');
  });

  it('emits confirm from Start anyway and cancel from Cancel and from Escape r12.2', async () => {
    const { fixture } = await render(BuildElsewhereDialog, { request: request() });
    const got: string[] = [];
    fixture.componentInstance.confirm.subscribe(() => got.push('confirm'));
    fixture.componentInstance.cancel.subscribe(() => got.push('cancel'));
    button('Start anyway').click();
    button('Cancel').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(got).toEqual(['confirm', 'cancel', 'cancel']);
  });

  it('confirm starts and decline starts nothing r9.2', async () => {
    const { fixture, vm, transport } = await opened();
    const start = vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue(maybe());
    expect(await vm.startBuild({ timeoutSecs: 600 })).toBe('mayBeRunningElsewhere');
    await fixture.whenStable();
    expect(dialog()).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    // Declining starts nothing, and the dialog goes.
    button('Cancel').click();
    await fixture.whenStable();
    expect(start).toHaveBeenCalledTimes(1);
    expect(vm.elsewhereRequest()).toBeNull();
    expect(dialog()).toBeNull();
    // Confirming starts the same build with the flag.
    await vm.startBuild({ timeoutSecs: 600 });
    await fixture.whenStable();
    start.mockResolvedValue({ kind: 'started', uncommitted: {} });
    button('Start anyway').click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start).toHaveBeenLastCalledWith(REF, { timeoutSecs: 600 }, true);
    expect(vm.elsewhereRequest()).toBeNull();
  });

  it('confirming a continue calls the same continue with the flag r9.2', async () => {
    const { vm, transport, preview } = await opened();
    const resume = vi.spyOn(transport, 'sdlcBuildContinue').mockResolvedValue(maybe({ runningCheck: 'app-unit' }));
    vm.select('commerce-core');
    vi.spyOn(preview, 'openBuild').mockResolvedValue({ off: new Set<string>(), request: null, picks: null, plan: null });
    await vm.continueRun();
    expect(vm.elsewhereRequest()).toEqual({ repos: ['kata'], since: '2026-11-18T14:54:00Z', runningCheck: 'app-unit' });
    resume.mockResolvedValue({ kind: 'started', uncommitted: {} });
    await vm.confirmElsewhere();
    expect(resume).toHaveBeenLastCalledWith(REF, 'commerce-core', [], true);
  });
});
