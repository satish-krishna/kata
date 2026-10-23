import { render } from '../../testing/render';
import { runGivenFixture } from '../lib/library';
import { GivenView } from './given-view';

const { type: _type, ...given } = runGivenFixture;
const text = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('GivenView', () => {
  it('the live run shows what it was given, read-only', async () => {
    const { container } = await render(GivenView, { given });
    const all = text(container);
    // kinds and sources
    expect(all).toContain('Skills');
    expect(all).toContain('Tool servers');
    expect(all).toContain('Hooks');
    expect(container.querySelector('[data-source="personal"]')).not.toBeNull();
    expect(container.querySelector('[data-source="project"]')).not.toBeNull();
    // every item, with the words for its status; switched-off rows say so
    expect(text(container.querySelector('[data-row="project:skill:repo-conventions"]')!)).toContain('switched off, but Claude loaded it');
    expect(text(container.querySelector('[data-row="personal:hook:PreToolUse:Bash:5b5b1d0c9a2e4f10"]')!)).toContain('switched off');
    expect(text(container.querySelector('[data-row="personal:skill:triage-flaky-test"]')!)).toContain('given');
    // the item Claude reported and Kata did not know
    expect(all).toContain('stray');
    expect(all).toContain('loaded by Claude, source unknown');
    // run settings and limits, each with its source
    const setting = (label: string) => text(container.querySelector(`[data-setting="${label}"]`)!);
    expect(setting('Model')).toContain('claude-sonnet-4');
    expect(setting('Model')).toContain('the job');
    expect(setting('Time limit')).toContain('30 min');
    expect(setting('Turn cap')).toContain('12');
    expect(setting('Spending ceiling')).toContain('none');
    // environment names, never values
    expect(text(container.querySelector('[data-env="ANTHROPIC_API_KEY"]')!)).toContain('API key');
    expect(container.querySelector('[data-env="PATH"]')).not.toBeNull();
    // warnings
    expect(all).toContain('repo-conventions was switched off, but Claude loaded it');
    // nothing can be changed
    expect(container.querySelectorAll('input, select, textarea, button, hlm-switch, [role="switch"]')).toHaveLength(0);
  });

  it('a run with no record reads not recorded and shows nothing else', async () => {
    const { container } = await render(GivenView, { given: 'not-recorded' });
    expect(text(container)).toBe('not recorded');
  });
});
