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
    for (const [versions, line] of [[missing, 'ai-sdlc: not found'], [unknown, 'ai-sdlc: version unknown']] as const) {
      TestBed.resetTestingModule();
      const transport = new MockTransport();
      vi.spyOn(transport, 'appVersions').mockResolvedValue(versions);
      vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' });
      const container = await open(transport, '/sdlc');
      expect(container.querySelector('.wb-statusbar')?.textContent).toContain(line);
      await vi.waitFor(() => expect(container.textContent).toContain('The ai-sdlc plugin was not found'));
    }
  });

  it('an ai-sdlc older than the minimum shows its version and the minimum message', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValue(found('1.0.3'));
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginTooOld', message: 'ai-sdlc 1.0.3 is older than 1.1.0' });
    const container = await open(transport, '/sdlc');
    expect(container.querySelector('.wb-statusbar')?.textContent).toContain('ai-sdlc 1.0.3');
    await vi.waitFor(() => expect(container.textContent).toContain('1.1.0'));
  });
});
