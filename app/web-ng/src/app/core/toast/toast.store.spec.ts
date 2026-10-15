import { TestBed } from '@angular/core/testing';
import { ToastStore } from './toast.store';

describe('ToastStore', () => {
  afterEach(() => vi.useRealTimers());

  it('error pushes an error toast and returns a unique id', () => {
    const store = TestBed.inject(ToastStore);
    const a = store.error('boom one');
    const b = store.error('boom two');
    expect(a).not.toBe(b);
    expect(store.toasts().map((t) => t.message)).toEqual(['boom one', 'boom two']);
    expect(store.toasts()[0].kind).toBe('error');
  });

  it('dismiss removes a toast by id; unknown id is a no-op', () => {
    const store = TestBed.inject(ToastStore);
    const id = store.error('x');
    store.dismiss(-999);
    expect(store.toasts().length).toBe(1);
    store.dismiss(id);
    expect(store.toasts().length).toBe(0);
  });

  it('auto-dismisses after the timeout', () => {
    vi.useFakeTimers();
    const store = TestBed.inject(ToastStore);
    store.error('temp');
    expect(store.toasts().length).toBe(1);
    vi.advanceTimersByTime(6000);
    expect(store.toasts().length).toBe(0);
  });

  it('manual dismiss clears the auto-dismiss timer', () => {
    vi.useFakeTimers();
    const store = TestBed.inject(ToastStore);
    const id = store.error('temp');
    store.dismiss(id);
    store.error('next');
    vi.advanceTimersByTime(5999);
    expect(store.toasts().map((t) => t.message)).toEqual(['next']);
  });
});
