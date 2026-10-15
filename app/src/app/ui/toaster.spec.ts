import { render } from '../../testing/render';
import { Toaster } from './toaster';

describe('Toaster', () => {
  it('renders each toast and emits dismiss with its id', async () => {
    const { container, fixture } = await render(Toaster, { toasts: [{ id: 7, kind: 'error', message: 'save failed' }] });
    expect(container.textContent).toContain('save failed');
    expect(container.querySelector('.k-toast--error[role="alert"]')).not.toBeNull();
    const spy = vi.fn();
    fixture.componentInstance.dismiss.subscribe(spy);
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith(7);
  });
  it('renders nothing without toasts', async () => {
    const { container } = await render(Toaster, { toasts: [] });
    expect(container.querySelector('.k-toaster')).toBeNull();
  });
});
