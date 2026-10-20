import type { PrState } from '@bindings/PrState';
import { render } from '../../testing/render';
import { PrCard } from './pr-card';

const states: PrState[] = [
  { repo: 'claims-core', url: 'https://github.com/acme/claims-core/pull/7' },
  { repo: 'claims-intent', url: 'https://github.com/acme/claims-intent/pull/12' },
];

describe('PrCard', () => {
  it('titles the card and links every repository to its pull request', async () => {
    const { container } = await render(PrCard, { pullRequests: states });
    expect(container.querySelector('h2')!.textContent).toBe('Pull requests');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(states.map((s) => s.url));
    expect(container.textContent).toContain('claims-intent');
    expect(container.textContent).toContain('#12');
  });
});
