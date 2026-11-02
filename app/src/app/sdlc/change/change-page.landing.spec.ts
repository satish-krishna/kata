import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { OpenRun } from '@bindings/OpenRun';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { RunLandingStore, type Landing } from '../../core/run/run-landing.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
/** Every document run opens the preview first; confirm it once its rows have resolved. */
const confirmPreview = async () => {
  const start = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Start run');
  await vi.waitFor(() => expect(start() && !start()!.disabled).toBe(true));
  start()!.click();
};
const PHOTOS_CHANGE = '2026-10-12-product-photo-upload';
const WORKSPACE = 'acme-commerce';
const tab = (c: HTMLElement, start: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent!.trim().startsWith(start))!;
const run = (over: Partial<OpenRun>): OpenRun => ({ run: 1, kind: 'build', repo: 'customer-portal', waiting: true, ...over });

/** `asked` is a request already waiting when the page is created, as the strip leaves it before it navigates. */
async function mount(change: string, transport = new MockTransport(), demo: string | null = null, asked: Landing | null = null) {
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    {
      provide: RunLandingStore,
      useFactory: () => {
        const store = new RunLandingStore();
        if (asked !== null) store.ask(asked);
        return store;
      },
    },
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change })), snapshot: { queryParamMap: convertToParamMap(demo === null ? {} : { demo }) } } },
  ]);
  await settle();
  return { ...out, transport, landing: TestBed.inject(RunLandingStore) };
}

afterEach(() => TestBed.resetTestingModule());

describe('ChangePage landing on a run picked from the running changes (R13.2)', () => {
  it('a build run opens the Build tab with that repository picked, and the request is taken', async () => {
    const { container, fixture, landing } = await mount(MOCK_BUILD_CHANGE);
    landing.ask({ workspaceId: WORKSPACE, system: 'commerce', change: MOCK_BUILD_CHANGE, run: run({ repo: 'customer-portal' }) });
    await settle();
    expect(tab(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(fixture.debugElement.injector.get(BuildPageViewModel).pick()).toEqual({ kind: 'repo', repo: 'customer-portal' });
    expect(landing.pending()).toBeNull();
  });

  it('a review run opens the Build tab with the review picked', async () => {
    const { container, fixture, landing } = await mount(MOCK_BUILD_CHANGE);
    landing.ask({ workspaceId: WORKSPACE, system: 'commerce', change: MOCK_BUILD_CHANGE, run: run({ kind: 'review', repo: null }) });
    await settle();
    expect(tab(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(fixture.debugElement.injector.get(BuildPageViewModel).pick()).toEqual({ kind: 'review' });
  });

  it("a document run shows the change's own session with its question, and the request is taken", async () => {
    const { container, landing } = await mount(PHOTOS_CHANGE, new MockTransport(), 'sdlc');
    await confirmPreview();
    await vi.waitFor(() => expect(container.querySelector('app-sdlc-session')).not.toBeNull());
    landing.ask({ workspaceId: WORKSPACE, system: 'commerce', change: PHOTOS_CHANGE, run: run({ kind: 'spec', repo: null }) });
    await settle();
    expect(container.querySelector('app-sdlc-session')).not.toBeNull();
    await vi.waitFor(() => expect(container.querySelector('app-ask-panel')).not.toBeNull(), { timeout: 8000 });
    expect(landing.pending()).toBeNull();
  });

  it("another change's request is left alone", async () => {
    const { fixture, landing } = await mount(MOCK_BUILD_CHANGE);
    landing.ask({ workspaceId: WORKSPACE, system: 'commerce', change: 'some-other-change', run: run({}) });
    await settle();
    expect(fixture.debugElement.injector.get(BuildPageViewModel).pick()).not.toEqual({ kind: 'repo', repo: 'customer-portal' });
    expect(landing.pending()?.change).toBe('some-other-change');
  });

  it("a request for another workspace's change makes that workspace the open one before the page loads", async () => {
    const transport = new MockTransport();
    const other = { id: 'other', name: 'other', folder: 'D:/elsewhere/other', last_opened: 1 };
    const now = await transport.sdlcWorkspaces();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([...now, other]);
    const save = vi.spyOn(transport, 'sdlcSaveWorkspaces');
    await mount(MOCK_BUILD_CHANGE, transport, null, { workspaceId: other.id, system: 'commerce', change: MOCK_BUILD_CHANGE, run: run({}) });
    const saved = save.mock.calls[0][0];
    expect(saved.find((w) => w.id === 'other')!.last_opened).toBeGreaterThan(Math.max(...saved.filter((w) => w.id !== 'other').map((w) => w.last_opened)));
  });
});
