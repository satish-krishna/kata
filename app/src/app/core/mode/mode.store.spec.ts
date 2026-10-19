import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { Settings } from '@bindings/Settings';
import { KataTransport } from '../transport/kata-transport';
import { ModeStore } from './mode.store';

function setup(initial: Settings) {
  const saved: Settings[] = [];
  const transport = {
    sdlcSettings: vi.fn(() => Promise.resolve(initial)),
    sdlcSaveSettings: vi.fn((s: Settings) => {
      saved.push(s);
      return Promise.resolve();
    }),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: KataTransport, useValue: transport }],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return { store: TestBed.inject(ModeStore), saved, navigate, transport };
}

const base: Settings = { mode: null, remember: true, permission_mode: 'bypass' };

describe('ModeStore', () => {
  it('loads settings once and exposes them', async () => {
    const { store, transport } = setup(base);
    expect(store.settings()).toBeNull();
    await store.load();
    await store.load();
    expect(store.settings()).toEqual(base);
    expect(transport.sdlcSettings).toHaveBeenCalledTimes(1);
  });

  it('choose persists the mode when remembered and navigates to it', async () => {
    const { store, saved, navigate } = setup(base);
    await store.choose('sdlc', true);
    expect(saved).toEqual([{ mode: 'sdlc', remember: true, permission_mode: 'bypass' }]);
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
    expect(store.settings()?.mode).toBe('sdlc');
  });

  it('choose without remember saves no mode, so the next launch asks again', async () => {
    const { store, saved, navigate } = setup({ ...base, mode: 'sdlc' });
    await store.choose('workbench', false);
    expect(saved).toEqual([{ mode: null, remember: false, permission_mode: 'bypass' }]);
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('switchTo navigates and persists while remember is on', async () => {
    const on = setup({ mode: 'workbench', remember: true, permission_mode: 'bypass' });
    await on.store.switchTo('sdlc');
    expect(on.saved.map((s) => s.mode)).toEqual(['sdlc']);
    expect(on.navigate).toHaveBeenCalledWith(['/sdlc']);
  });

  it('switchTo does not persist when remember is off', async () => {
    const off = setup({ mode: null, remember: false, permission_mode: 'bypass' });
    await off.store.switchTo('workbench');
    expect(off.saved).toEqual([]);
    expect(off.navigate).toHaveBeenCalledWith(['/']);
  });
});
