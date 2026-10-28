import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { Library } from './library';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { LaunchStore } from '../core/launch/launch.store';
import { history, STEERED_RUN_ID } from '../lib/library';

it('crosses the template/view-model seam: lists katas and runs, selects a run, and Re-run hands off to compose', async () => {
  const { fixture, container } = await render(Library, {}, [
    provideRouter([]),
    { provide: KataTransport, useClass: MockTransport },
  ]);
  await vi.waitFor(() => expect(container.querySelectorAll('.wb-hist').length).toBe(7));
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

const clock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function openRun(index: number, transport?: MockTransport) {
  const out = await render(Library, {}, [provideRouter([]), { provide: KataTransport, useValue: transport ?? new MockTransport() }]);
  const { fixture, container } = out;
  await vi.waitFor(() => expect(container.querySelectorAll('.wb-hist').length).toBeGreaterThan(index));
  (container.querySelectorAll('.wb-hist')[index] as HTMLElement).click();
  await fixture.whenStable();
  await vi.waitFor(() => expect(container.querySelector('.wb-hist--active')).toBeTruthy());
  return out;
}

it("a steered run's transcript shows each message with sent and read times", async () => {
  const steered = history.findIndex((r) => r.id === STEERED_RUN_ID);
  const { container } = await openRun(steered);
  await vi.waitFor(() => expect(container.querySelectorAll('app-operator-message').length).toBe(2));
  const items = Array.from(container.querySelectorAll('.wb-detail__stream > *'));
  const at = items.map((el, i) => (el.querySelector('app-operator-message') ? i : -1)).filter((i) => i >= 0);
  // Two stream rows precede the first message, four precede the second (one message row between).
  expect(at).toEqual([2, 5]);
  const first = items[2].textContent ?? '';
  expect(first).toContain('lead with the security fix');
  expect(first).toContain(`sent ${clock(1781520010000)}`);
  expect(first).toContain(`read ${clock(1781520014000)}`);
  const second = items[5].textContent ?? '';
  expect(second).toContain('keep it under ten lines');
  expect(second).toContain(`sent ${clock(1781520020000)}`);
  expect(second).toContain(`read ${clock(1781520023000)}`);
});

it('steered runs carry the steered mark in the list', async () => {
  const { container } = await openRun(0);
  const rows = Array.from(container.querySelectorAll('.wb-hist'));
  expect(rows.length).toBe(history.length);
  rows.forEach((row, i) => {
    expect(row.querySelector('[data-steered]') !== null).toBe(history[i].steered);
  });
  expect(history.filter((r) => r.steered).length).toBe(1);
});

it('a refused message is not shown', async () => {
  const transport = new MockTransport();
  const record = { ...history[0], steered: false };
  vi.spyOn(transport, 'loadRun').mockResolvedValue({
    record,
    events: [
      { type: 'turn', n: 1 },
      { type: 'message.refused', id: 'm1', reason: 'waiting-on-operator', text: 'never delivered text' },
      { type: 'assistant.text', text: 'carrying on' },
    ],
  });
  const { container } = await openRun(0, transport);
  await vi.waitFor(() => expect(container.textContent).toContain('carrying on'));
  expect(container.querySelectorAll('app-operator-message').length).toBe(0);
  expect(container.textContent).not.toContain('never delivered text');
  expect(container.querySelector('.wb-hist--active [data-steered]')).toBeNull();
});
