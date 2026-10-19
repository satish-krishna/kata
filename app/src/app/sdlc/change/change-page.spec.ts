import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { ChangePage } from './change-page';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const FNOL = '2026-10-12-fnol-photo-upload';
const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

async function mount(change = FNOL, transport = new MockTransport()) {
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return { ...out, transport };
}

describe('ChangePage', () => {
  it('shows the breadcrumb, the branch, the stepper and the stage document', async () => {
    const { container } = await mount();
    expect(container.querySelector('nav')!.textContent).toContain(FNOL);
    expect(container.textContent).toContain('acme-claims');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
    expect(container.querySelectorAll('app-stage-stepper [aria-current="step"]').length).toBe(1);
    expect(container.textContent).toContain('Spec · awaiting acceptance');
    expect(container.querySelector('app-doc-view h1')!.textContent).toBe('Spec: photo upload');
    expect(container.querySelector('.k-doc__front')!.textContent!.trim()).toBe('status: draft');
  });

  it('offers the toolbar actions for the stage', async () => {
    const { container } = await mount();
    const all = labels(container);
    expect(all).toEqual(expect.arrayContaining(['Continue spec', 'Accept spec', 'Reopen intent']));
    expect(all).not.toContain('Start plan');
  });

  it('crosses the seam: clicking Accept spec calls sdlcDecide and the stepper moves on', async () => {
    const { container, transport } = await mount();
    const decide = vi.spyOn(transport, 'sdlcDecide');
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Accept spec')!.click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await settle();
    expect(container.textContent).toContain('Plan · ready to start');
    expect(labels(container)).toContain('Start plan');
  });

  it('names a change that does not exist and offers the way back', async () => {
    const { container } = await mount('2026-01-01-nope');
    expect(container.textContent).toContain('Change not found');
    expect(labels(container)).toContain('Back to the workspace');
  });

  it('mounts the lock overlay and the leftover dialog like the home screen', async () => {
    const { container } = await mount();
    expect(container.querySelector('app-lock-overlay')).not.toBeNull();
    expect(container.querySelector('app-leftover-dialog')).not.toBeNull();
  });
});
