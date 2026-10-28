import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { Workbench } from './workbench';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { RunStore } from '../core/run/run.store';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';

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
