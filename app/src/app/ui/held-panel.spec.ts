import { provideRouter } from '@angular/router';
import { render } from '../../testing/render';
import { HeldPanel, type HeldPanelRepo } from './held-panel';

const REPOS: HeldPanelRepo[] = [
  { repo: 'kata', holder: '2026-11-02-other', link: ['/sdlc', 'commerce', '2026-11-02-other'] },
  { repo: 'bob', holder: '2026-11-03-third', link: ['/sdlc', 'commerce', '2026-11-03-third'] },
];
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const mount = (inputs: Record<string, unknown> = {}) =>
  render(HeldPanel, { title: 'This build waits for other changes', repos: REPOS, action: 'Start build again', ...inputs }, [provideRouter([])]);

describe('HeldPanel', () => {
  it('names each held repository and the change that holds it, with a link that opens that change', async () => {
    const { container } = await mount();
    const rows = Array.from(container.querySelectorAll('[data-held]'));
    expect(rows).toHaveLength(2);
    expect(norm(rows[0].textContent)).toBe('kata is held by 2026-11-02-other');
    const link = rows[1].querySelector<HTMLAnchorElement>('a[data-holder]')!;
    expect(link.textContent?.trim()).toBe('2026-11-03-third');
    expect(link.getAttribute('href')).toBe('/sdlc/commerce/2026-11-03-third');
  });

  it('writes repository and change names in the mono face', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-repo]')?.classList.contains('k-mono')).toBe(true);
    expect(container.querySelector('a[data-holder]')?.classList.contains('k-mono')).toBe(true);
  });

  it('says what waits with an amber dot and the words, never the colour alone', async () => {
    const { container } = await mount();
    const status = container.querySelector('.k-status--warning');
    expect(status?.querySelector('.k-status__dot')).not.toBeNull();
    expect(norm(status?.textContent ?? '')).toBe('This build waits for other changes');
  });

  it('offers the action and tells the host when it is pressed', async () => {
    const { fixture, container } = await mount();
    const pressed = vi.fn();
    fixture.componentInstance.act.subscribe(pressed);
    const button = container.querySelector<HTMLButtonElement>('button[data-act]')!;
    expect(button.textContent?.trim()).toBe('Start build again');
    button.click();
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it('offers no action when it has none', async () => {
    const { container } = await mount({ action: null });
    expect(container.querySelector('button')).toBeNull();
  });
});
