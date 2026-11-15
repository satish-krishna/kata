import { render } from '../../testing/render';
import { StoppedNote } from './stopped-note';

describe('StoppedNote', () => {
  it('shows the note beside a warning dot, so the status is never colour alone', async () => {
    const { container } = await render(StoppedNote, { note: 'Stopped. The start did not finish' });
    const status = container.querySelector('.k-status.k-status--warning');
    expect(status).not.toBeNull();
    expect(status!.querySelector('.k-status__dot')).not.toBeNull();
    expect((status!.textContent ?? '').trim()).toBe('Stopped. The start did not finish');
  });
});
