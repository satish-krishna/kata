import { render } from '../../testing/render';
import { ProgressLine } from './progress-line';

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

describe('ProgressLine', () => {
  it('shows the playful line and the plain label in a status region', async () => {
    const { container } = await render(ProgressLine, { entry: { line: 'Reading the change from disk…', label: 'Reading the change', long: false } });
    const status = container.querySelector('p.k-state__body[role="status"]');
    expect(status).not.toBeNull();
    expect(norm(status!.textContent)).toBe('Reading the change from disk… Reading the change');
  });

  it('keeps the rotating playful line out of the screen reader announcements and the plain label in', async () => {
    const { container } = await render(ProgressLine, { entry: { line: 'Reading the change from disk…', label: 'Reading the change', long: false } });
    expect(container.querySelector('[data-testid="progress-line"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-testid="progress-label"]')!.getAttribute('aria-hidden')).toBeNull();
  });

  it('announces the notice for a step that runs long', async () => {
    const { container } = await render(ProgressLine, {
      entry: { line: 'Reading the change is taking longer than usual (12 s)', label: 'Reading the change', long: true },
    });
    expect(container.querySelector('[data-testid="progress-line"]')!.getAttribute('aria-hidden')).toBeNull();
    expect(norm(container.textContent)).toContain('Reading the change is taking longer than usual (12 s)');
  });

  it('shows only the plain label when compact', async () => {
    const { container } = await render(ProgressLine, { entry: { line: 'Reading the change from disk…', label: 'Reading the change', long: false }, compact: true });
    expect(container.querySelector('p[role="status"]')).not.toBeNull();
    expect(norm(container.textContent)).toBe('Reading the change');
    expect(container.querySelector('[data-testid="progress-line"]')).toBeNull();
  });

  it('announces the full long notice when compact and the step runs long', async () => {
    const { container } = await render(ProgressLine, {
      entry: { line: 'Reading the change is taking longer than usual (12 s)', label: 'Reading the change', long: true },
      compact: true,
    });
    expect(norm(container.textContent)).toContain('Reading the change is taking longer than usual (12 s)');
  });

  it('shows the short notice when compact and the step runs long, and keeps the full notice for assistive technology', async () => {
    const { container } = await render(ProgressLine, {
      entry: { line: 'Reading the change is taking longer than usual (12 s)', label: 'Reading the change', long: true },
      compact: true,
    });
    const visible = container.querySelector('[data-testid="progress-label"]');
    expect(norm(visible!.textContent)).toBe('longer than usual');
    expect(norm(container.querySelector('p[role="status"]')!.textContent)).toContain('Reading the change is taking longer than usual (12 s)');
  });
});
