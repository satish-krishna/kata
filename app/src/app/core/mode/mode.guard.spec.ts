import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import type { Settings } from '@bindings/Settings';
import { KataTransport } from '../transport/kata-transport';
import { ModeStore } from './mode.store';
import { modeGuard } from './mode.guard';

function run(settings: Settings, beforeGuard?: (s: ModeStore) => Promise<void>) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: KataTransport, useValue: { sdlcSettings: () => Promise.resolve(settings), sdlcSaveSettings: () => Promise.resolve() } },
    ],
  });
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const go = async () => {
    if (beforeGuard) await beforeGuard(TestBed.inject(ModeStore));
    return (await TestBed.runInInjectionContext(() =>
      modeGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    )) as boolean | UrlTree;
  };
  return { go, url: (t: boolean | UrlTree) => (t instanceof UrlTree ? TestBed.inject(Router).serializeUrl(t) : t) };
}

describe('modeGuard', () => {
  it('sends a first launch with no saved mode to /mode', async () => {
    const { go, url } = run({ mode: null, remember: true, permission_mode: 'bypass' });
    expect(url(await go())).toBe('/mode');
  });

  it('opens a remembered AI-SDLC mode at /sdlc', async () => {
    const { go, url } = run({ mode: 'sdlc', remember: true, permission_mode: 'bypass' });
    expect(url(await go())).toBe('/sdlc');
  });

  it('lets a remembered workbench mode through', async () => {
    const { go } = run({ mode: 'workbench', remember: true, permission_mode: 'bypass' });
    expect(await go()).toBe(true);
  });

  it('lets an un-remembered sdlc mode through to the workbench', async () => {
    const { go } = run({ mode: 'sdlc', remember: false, permission_mode: 'bypass' });
    expect(await go()).toBe(true);
  });

  it('stops redirecting once the operator has chosen this session', async () => {
    const { go } = run({ mode: null, remember: false, permission_mode: 'bypass' }, async (s) => {
      await s.choose('workbench', false);
    });
    expect(await go()).toBe(true);
  });
});
