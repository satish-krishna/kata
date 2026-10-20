import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
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
