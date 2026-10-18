import { TestBed } from '@angular/core/testing';
import { toast, toastState } from '@spartan-ng/brain/sonner';
import { ToastStore } from './toast.store';

describe('ToastStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    toastState.reset();
  });

  it('error delegates to sonner with the message and the 6000 ms lifetime', () => {
    const spy = vi.spyOn(toast, 'error');
    TestBed.inject(ToastStore).error('boom');
    expect(spy).toHaveBeenCalledWith('boom', expect.objectContaining({ duration: 6000 }));
  });

  it('error returns the sonner id and each call is its own toast', () => {
    const store = TestBed.inject(ToastStore);
    const a = store.error('boom one');
    const b = store.error('boom two');
    expect(a).not.toBe(b);
    expect(toastState.toasts().map((t) => t.title)).toEqual(['boom two', 'boom one']);
    expect(toastState.toasts().every((t) => t.type === 'error')).toBe(true);
  });
});
