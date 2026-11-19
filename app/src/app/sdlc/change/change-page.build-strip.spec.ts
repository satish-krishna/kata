import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunningStep } from '@bindings/RunningStep';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { ChangePage } from './change-page';

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const key: ChangeKey = { workspace: { key: MOCK_WORKSPACE_FOLDER.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase(), name: 'ws' }, system: 'commerce', change: MOCK_BUILD_CHANGE };
const preparation = (stopQuestion: string | null): RunningStep => ({
  change: key,
  kind: 'preparingBuild',
  doing: 'preparing',
  progress: { kind: 'repository', label: 'Checking the base', repo: 'commerce-core', check: 'base-tests', phase: 'other' },
  liveChecks: [],
  stopQuestion,
});

const inDialog = (label: string): HTMLButtonElement =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find((b) => b.textContent!.trim() === label)!;

async function mount(stopQuestion: string | null) {
  const transport = new MockTransport();
  vi.spyOn(transport, 'steps').mockResolvedValue([preparation(stopQuestion)]);
  const stop = vi.spyOn(transport, 'stopStep').mockResolvedValue(true);
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change: MOCK_BUILD_CHANGE })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await vi.waitFor(() => expect(out.container.querySelector('[data-testid="stop-preparing"]')).not.toBeNull());
  await settle();
  return { ...out, stop };
}

describe('the build strip while the build is prepared', () => {
  it('stop sits on the progress line r1.1', async () => {
    const { container } = await mount(null);
    const line = container.querySelector('app-progress-line')!;
    const stop = container.querySelector<HTMLButtonElement>('[data-testid="stop-preparing"]')!;
    expect(line.contains(stop)).toBe(true);
    expect(stop.getAttribute('aria-label')).toBe('Stop preparing the build');
    expect(stop.closest('.k-change__missing')).toBe(container.querySelector('[data-testid="build-progress"]'));
    expect(container.querySelectorAll('[data-testid="stop-preparing"]').length).toBe(1);
    expect(container.querySelectorAll('.k-change__missing').length).toBe(1);
  });

  it('declining the stop keeps the checks running r10.3', async () => {
    const question = '2 checks already ran. The next start runs every check on the base again.';
    const { container, stop } = await mount(question);
    container.querySelector<HTMLButtonElement>('[data-testid="stop-preparing"]')!.click();
    await settle();
    expect(document.body.textContent).toContain(question);
    expect(stop).not.toHaveBeenCalled();
    const cancel = inDialog('Cancel');
    cancel.click();
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(question);
    expect(container.querySelector('[data-testid="stop-preparing"]')).not.toBeNull();
  });

  it('confirming the question stops the preparation r10.1', async () => {
    const { container, stop } = await mount('1 check already ran. The next start runs every check again.');
    container.querySelector<HTMLButtonElement>('[data-testid="stop-preparing"]')!.click();
    await settle();
    inDialog('Stop').click();
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
