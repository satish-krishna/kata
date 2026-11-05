import type { Versions } from '@bindings/Versions';
import { render } from '../../testing/render';
import { VersionLine } from './version-line';

const versions: Versions = {
  workbench: '3.3.0',
  aiSdlc: { kind: 'found', version: '1.3.0' },
  line: 'Workbench 3.3.0 · ai-sdlc 1.3.0',
  copy: 'Kata Workbench 3.3.0, ai-sdlc 1.3.0',
};

describe('VersionLine', () => {
  it('shows the line, names the copy it makes, and emits copy on click', async () => {
    const { fixture, container } = await render(VersionLine, { versions });
    const button = container.querySelector('button')!;
    expect(button.textContent?.trim()).toBe(versions.line);
    expect(button.getAttribute('aria-label')).toBe('Copy versions: Kata Workbench 3.3.0, ai-sdlc 1.3.0');
    let copies = 0;
    fixture.componentInstance.copy.subscribe(() => copies++);
    button.click();
    expect(copies).toBe(1);
  });

  it('renders nothing before the versions are known', async () => {
    const { container } = await render(VersionLine, { versions: null });
    expect(container.querySelector('button')).toBeNull();
  });
});
