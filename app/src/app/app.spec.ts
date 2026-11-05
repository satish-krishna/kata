import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import type { Versions } from '@bindings/Versions';
import { routes } from './app.routes';
import { render } from '../testing/render';
import { App } from './app';
import { ToastStore } from './core/toast/toast.store';
import { KataTransport } from './core/transport/kata-transport';
import { MockTransport } from './core/transport/mock-transport';

describe('App toasts', () => {
  // Spec files share one worker and its modules (isolate is off), so a toast another file raised can still be in sonner's list.
  beforeEach(() => toastState.reset());
  afterEach(() => toastState.reset());

  it('shows two errors raised after the toaster renders, each with a named dismiss control', async () => {
    const { fixture, container } = await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: new MockTransport() }]);
    const store = fixture.debugElement.injector.get(ToastStore);
    store.error('save failed');
    store.error('export failed');
    fixture.detectChanges();
    await fixture.whenStable();
    const region = container.querySelector('hlm-toaster');
    expect(region?.textContent).toContain('save failed');
    expect(region?.textContent).toContain('export failed');
    const closers = Array.from(region?.querySelectorAll('button[data-close-button]') ?? []);
    expect(closers).toHaveLength(2);
    for (const c of closers) {
      expect(c.getAttribute('aria-label')).toBeTruthy();
      expect(c.classList).toContain('k-toast__close');
    }
    expect(region?.querySelectorAll('li.k-toast.k-toast--error')).toHaveLength(2);
  });

  it('shows a toast raised before the app shell exists', async () => {
    toastState.create({ message: 'early', type: 'error' });
    const { fixture, container } = await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: new MockTransport() }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(container.querySelector('hlm-toaster')?.textContent).toContain('early');
  });

  it('does not duplicate an early toast when brain stops resetting the list', async () => {
    toastState.create({ message: 'early', type: 'error' });
    vi.spyOn(toastState, 'reset').mockImplementation(() => undefined);
    const { fixture, container } = await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: new MockTransport() }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const region = container.querySelector('hlm-toaster');
    expect(region?.textContent).toContain('early');
    expect(region?.querySelectorAll('li.k-toast')).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('App zoom keys', () => {
  it('steps the zoom on Ctrl+= and Ctrl+-, and keeps the browser from zooming too', async () => {
    const transport = new MockTransport();
    const zoom = vi.spyOn(transport, 'zoom');
    await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    const zoomIn = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, cancelable: true });
    document.dispatchEvent(zoomIn);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, cancelable: true }));
    expect(zoom.mock.calls).toEqual([['in'], ['out']]);
    expect(zoomIn.defaultPrevented).toBe(true);
  });

  it('raises an error toast when the zoom fails', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'zoom').mockRejectedValue('no home directory');
    const { fixture } = await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    const error = vi.spyOn(fixture.debugElement.injector.get(ToastStore), 'error');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, cancelable: true }));
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith('Failed to zoom: no home directory');
  });

  it('leaves other keys alone', async () => {
    const transport = new MockTransport();
    const zoom = vi.spyOn(transport, 'zoom');
    await render(App, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    const plain = new KeyboardEvent('keydown', { key: '=', cancelable: true });
    document.dispatchEvent(plain);
    expect(zoom).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe('App version line', () => {
  const found = (version: string): Versions => ({
    workbench: '3.3.0',
    aiSdlc: { kind: 'found', version },
    line: `Workbench 3.3.0 · ai-sdlc ${version}`,
    copy: `Kata Workbench 3.3.0, ai-sdlc ${version}`,
  });
  const missing: Versions = {
    workbench: '3.3.0',
    aiSdlc: { kind: 'notFound' },
    line: 'Workbench 3.3.0 · ai-sdlc: not found',
    copy: 'Kata Workbench 3.3.0, ai-sdlc: not found',
  };
  const unknown: Versions = {
    workbench: '3.3.0',
    aiSdlc: { kind: 'unknown' },
    line: 'Workbench 3.3.0 · ai-sdlc: version unknown',
    copy: 'Kata Workbench 3.3.0, ai-sdlc: version unknown',
  };
  const change = 'commerce/2026-10-12-product-photo-upload';

  async function open(transport: MockTransport, url: string) {
    const { fixture, container } = await render(App, {}, [provideRouter(routes), { provide: KataTransport, useValue: transport }]);
    await TestBed.inject(Router).navigateByUrl(url);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(container.querySelector('.wb-statusbar')).not.toBeNull();
    });
    return container;
  }

  it('shows the version line on every route without its own footer', async () => {
    for (const url of ['/mode', '/sdlc', `/sdlc/${change}`, '/sdlc/commerce/2026-10-19-build-demo', '/sdlc/commerce/context/commerce-core']) {
      TestBed.resetTestingModule();
      const transport = new MockTransport();
      vi.spyOn(transport, 'appVersions').mockResolvedValue(found('1.3.0'));
      const container = await open(transport, url);
      const bars = container.querySelectorAll('.wb-statusbar');
      expect(bars, url).toHaveLength(1);
      expect(bars[0].textContent, url).toContain('Workbench 3.3.0 · ai-sdlc 1.3.0');
    }
  });

  it('the line reads not found or version unknown, and the AI-SDLC home keeps its readiness message', async () => {
    const blocked = { kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' } as const;
    // Not installed: the catalog has no ai-sdlc plugin, and the home says so as it always did.
    const gone = new MockTransport();
    vi.spyOn(gone, 'appVersions').mockResolvedValue(missing);
    vi.spyOn(gone, 'catalog').mockResolvedValue([]);
    vi.spyOn(gone, 'sdlcPluginReadiness').mockResolvedValue(blocked);
    const goneView = await open(gone, '/sdlc');
    expect(goneView.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc: not found');
    await vi.waitFor(() => expect(goneView.textContent).toContain('The ai-sdlc plugin was not found'));
    // Unreadable version: the home is what it is with any version answer, and the line carries the backend's text.
    TestBed.resetTestingModule();
    const base = new MockTransport();
    vi.spyOn(base, 'appVersions').mockResolvedValue(found('1.3.0'));
    vi.spyOn(base, 'sdlcPluginReadiness').mockResolvedValue(blocked);
    const baseline = (await open(base, '/sdlc')).querySelector('.k-home')?.textContent;
    TestBed.resetTestingModule();
    const odd = new MockTransport();
    vi.spyOn(odd, 'appVersions').mockResolvedValue(unknown);
    vi.spyOn(odd, 'sdlcPluginReadiness').mockResolvedValue(blocked);
    const oddView = await open(odd, '/sdlc');
    expect(oddView.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc: version unknown');
    await vi.waitFor(() => expect(oddView.querySelector('.k-home')?.textContent).toBe(baseline));
  });

  it('the window regaining focus reads the versions again and the line shows the new answer', async () => {
    const transport = new MockTransport();
    const ask = vi.spyOn(transport, 'appVersions').mockResolvedValueOnce(found('1.3.0')).mockResolvedValueOnce(found('1.4.0'));
    const container = await open(transport, '/mode');
    await vi.waitFor(() => expect(container.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc 1.3.0'), { timeout: 5000 });
    expect(ask).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new FocusEvent('focus'));
    await vi.waitFor(() => expect(container.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc 1.4.0'), { timeout: 5000 });
    expect(ask).toHaveBeenCalledTimes(2);
  }, 15000);

  it('an ai-sdlc older than the minimum shows its version while the home keeps its message', async () => {
    const tooOld = { kind: 'blocked', reason: 'pluginTooOld', message: 'The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 1.0.3.' } as const;
    const base = new MockTransport();
    vi.spyOn(base, 'appVersions').mockResolvedValue(found('1.3.0'));
    vi.spyOn(base, 'sdlcPluginReadiness').mockResolvedValue(tooOld);
    const baseline = (await open(base, '/sdlc')).querySelector('.k-home')?.textContent;
    TestBed.resetTestingModule();
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValue(found('1.0.3'));
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(tooOld);
    const container = await open(transport, '/sdlc');
    expect(container.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc 1.0.3');
    await vi.waitFor(() => expect(container.querySelector('.k-home')?.textContent).toBe(baseline));
  });
});
