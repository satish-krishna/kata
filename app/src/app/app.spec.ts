import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import { render } from '../testing/render';
import { App } from './app';
import { ToastStore } from './core/toast/toast.store';

describe('App toasts', () => {
  afterEach(() => toastState.reset());

  it('shows two errors raised before the toaster renders, each with a named dismiss control', async () => {
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
    for (const c of closers) expect(c.getAttribute('aria-label')).toBeTruthy();
  });

  it('shows a toast raised before the app shell exists', async () => {
    toastState.create({ message: 'early', type: 'error' });
    const { fixture, container } = await render(App, {}, [provideRouter([])]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(container.querySelector('hlm-toaster')?.textContent).toContain('early');
  });
});
