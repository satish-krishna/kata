import { render } from '../../testing/render';
import { ValidationBanner } from './validation-banner';

describe('ValidationBanner', () => {
  it('renders nothing for no errors', async () => {
    const { container } = await render(ValidationBanner, { errors: [] });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('lists each error in an alert', async () => {
    const { container } = await render(ValidationBanner, { errors: ['task is required', 'bad rule'] });
    const alert = container.querySelector('hlm-alert[role="alert"]')!;
    expect(alert.getAttribute('data-slot')).toBe('alert');
    expect(alert.textContent).toContain('task is required');
    expect(alert.textContent).toContain('bad rule');
  });
});
