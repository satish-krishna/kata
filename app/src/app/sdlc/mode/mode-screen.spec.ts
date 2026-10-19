import { provideRouter } from '@angular/router';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { ModeScreen } from './mode-screen';

describe('ModeScreen', () => {
  it('renders the copy and crosses the seam: selecting a card and clicking Open saves the choice', async () => {
    const transport = new MockTransport();
    const { fixture, container } = await render(ModeScreen, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
    expect(container.textContent).toContain('How are you working today?');
    expect(container.textContent).toContain('Compose a run');
    expect(container.textContent).toContain('Remember this · switch any time from the toolbar');
    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    radios[1].click();
    await fixture.whenStable();
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Open')!;
    open.click();
    await vi.waitFor(async () => expect((await transport.sdlcSettings()).mode).toBe('sdlc'));
  });
});
