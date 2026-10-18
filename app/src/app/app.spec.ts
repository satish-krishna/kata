import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import { render } from '../testing/render';
import { App } from './app';
import { ToastStore } from './core/toast/toast.store';

describe('App toasts', () => {
  afterEach(() => toastState.reset());

  it('shows two errors raised after the toaster renders, each with a named dismiss control', async () => {
    const { fixture, container } = await render(App, {}, [provideRouter([])]);
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
    const { fixture, container } = await render(App, {}, [provideRouter([])]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(container.querySelector('hlm-toaster')?.textContent).toContain('early');
  });

  it('does not duplicate an early toast when brain stops resetting the list', async () => {
    toastState.create({ message: 'early', type: 'error' });
    vi.spyOn(toastState, 'reset').mockImplementation(() => undefined);
    const { fixture, container } = await render(App, {}, [provideRouter([])]);
    fixture.detectChanges();
    await fixture.whenStable();
    const region = container.querySelector('hlm-toaster');
    expect(region?.textContent).toContain('early');
    expect(region?.querySelectorAll('li.k-toast')).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
