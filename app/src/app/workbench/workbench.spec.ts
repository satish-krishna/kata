import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { Workbench } from './workbench';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { RunStore } from '../core/run/run.store';

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
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
});
