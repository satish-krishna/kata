import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { Library } from './library';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { LaunchStore } from '../core/launch/launch.store';

it('crosses the template/view-model seam: lists katas and runs, selects a run, and Re-run hands off to compose', async () => {
  const { fixture, container } = await render(Library, {}, [
    provideRouter([]),
    { provide: KataTransport, useClass: MockTransport },
  ]);
  await vi.waitFor(() => expect(container.querySelectorAll('.wb-hist').length).toBe(6));
  expect(container.querySelectorAll('.wb-kata').length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(container.querySelector('.wb-detail__head h2')).toBeTruthy());

  (container.querySelectorAll('.wb-hist')[2] as HTMLElement).click();
  await fixture.whenStable();
  await vi.waitFor(() => expect(container.querySelector('.wb-hist--active .wb-hist__kata')?.textContent).toBe('audit-deps'));

  const reRun = Array.from(container.querySelectorAll('button')).find((b) => /Re-run/.test(b.textContent ?? ''))!;
  reRun.click();
  await fixture.whenStable();
  const run = await vi.waitFor(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Run');
    expect(b).toBeTruthy();
    return b!;
  });
  run.click();
  await fixture.whenStable();
  const payload = TestBed.inject(LaunchStore).take();
  expect(payload?.autorun).toBe(true);
  expect(payload?.spec.name).toBe('audit-deps');
});
