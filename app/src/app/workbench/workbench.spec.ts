import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { App } from '../app';
import { routes } from '../app.routes';
import { Workbench } from './workbench';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { RunStore } from '../core/run/run.store';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { VersionsStore } from '../core/versions/versions.store';

describe('the Workbench footer and the version line', () => {
  const footerLast = (c: HTMLElement) => c.querySelector('.wb-statusbar')?.lastElementChild?.textContent?.trim();

  it('the footer ends with the version line', async () => {
    const transport = new MockTransport();
    const { fixture, container } = await render(Workbench, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    await TestBed.inject(VersionsStore).refresh();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(container.querySelectorAll('.wb-statusbar')).toHaveLength(1);
      expect(footerLast(container)).toBe('Workbench 3.3.0 · ai-sdlc 1.3.0');
    });
  });

  it('clicking the line copies the versions', async () => {
    const transport = new MockTransport();
    const copy = vi.spyOn(transport, 'copyText').mockResolvedValue(undefined);
    const { fixture, container } = await render(Workbench, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    await TestBed.inject(VersionsStore).refresh();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(container.querySelector<HTMLElement>('.wb-statusbar__version')).not.toBeNull();
    });
    container.querySelector<HTMLElement>('.wb-statusbar__version')!.click();
    expect(copy).toHaveBeenCalledWith('Kata Workbench 3.3.0, ai-sdlc 1.3.0');
  });

  it('the shell draws no line on the Workbench route, so the page footer is the only one', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcSettings').mockResolvedValue({ mode: 'workbench', remember: false, permission_mode: 'bypass' });
    const { fixture, container } = await render(App, {}, [provideRouter(routes), { provide: KataTransport, useValue: transport }]);
    await TestBed.inject(Router).navigateByUrl('/');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(container.querySelector('.wb-statusbar')).not.toBeNull();
      expect(footerLast(container)).toBe('Workbench 3.3.0 · ai-sdlc 1.3.0');
    });
    expect(container.querySelectorAll('.wb-statusbar')).toHaveLength(1);
  });
});

const runButton = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('button')).find((b) => /^run/i.test(b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''))!;

it('crosses the template/view-model seam: the toolbar Run button starts a run', async () => {
  const { fixture, container } = await render(Workbench, {}, [
    provideRouter([]),
    { provide: KataTransport, useClass: MockTransport },
  ]);
  const start = vi.spyOn(TestBed.inject(RunStore), 'startRun');
  await vi.waitFor(() => expect(runButton(container)).toBeTruthy());
  runButton(container).click();
  await fixture.whenStable();
  // The button opens the preview first; the run starts when it is confirmed.
  const preview = fixture.debugElement.injector.get(RunPreviewViewModel);
  await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
  expect(start).not.toHaveBeenCalled();
  preview.start();
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
});

it('R6.1: a run mode job that is running offers the message box, and sending reaches that run', async () => {
  const transport = new MockTransport();
  const { fixture, container } = await render(Workbench, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
  const send = vi.spyOn(transport, 'sendMessage');
  await vi.waitFor(() => expect(runButton(container)).toBeTruthy());
  runButton(container).click();
  await fixture.whenStable();
  const preview = fixture.debugElement.injector.get(RunPreviewViewModel);
  await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
  preview.start();
  // The scripted run is running before its first pause; the box is enabled only then.
  const input = () => container.querySelector<HTMLInputElement>('app-message-box [data-message-input]');
  await vi.waitFor(() => {
    TestBed.tick();
    expect(input() !== null && !input()!.disabled).toBe(true);
  });
  input()!.value = 'use the cache';
  input()!.dispatchEvent(new Event('input'));
  TestBed.tick();
  container.querySelector<HTMLButtonElement>('[data-message-send]')!.click();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(TestBed.inject(RunStore).lastRunId(), expect.any(String), 'use the cache');
});
