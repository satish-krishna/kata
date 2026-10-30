import { TestBed } from '@angular/core/testing';
import type { PrResult } from '@bindings/PrResult';
import { render } from '../../testing/render';
import { PrListDialog } from './pr-list-dialog';

const url = (repo: string) => `https://github.com/acme/${repo}/pull/7`;
const opened = (repo: string): PrResult => ({ repo, outcome: { kind: 'opened', url: url(repo) } });
const failed = (repo: string, error: string): PrResult => ({ repo, outcome: { kind: 'failed', error } });

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent!.replace(/\s+/g, ' ');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const open = async (results: PrResult[] | null) => {
  const out = await render(PrListDialog, { results });
  await settle();
  return out;
};

afterEach(() => TestBed.resetTestingModule());

describe('PrListDialog', () => {
  it('pull request list shows a link per repository (R13.1)', async () => {
    await open([opened('commerce-core'), opened('customer-portal'), opened('commerce-docs')]);
    const rows = Array.from(dialog().querySelectorAll('li'));
    expect(rows.map((r) => r.querySelector('.k-mono')!.textContent!.trim())).toEqual(['commerce-core', 'customer-portal', 'commerce-docs']);
    const links = Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([url('commerce-core'), url('customer-portal'), url('commerce-docs')]);
    expect(text()).toContain('opened');
    expect(dialog().querySelector('h2')!.textContent).toContain('Pull requests');
  });

  it('a reused pull request says it was already open', async () => {
    await open([{ repo: 'commerce-core', outcome: { kind: 'reused', url: url('commerce-core') } }]);
    expect(text()).toContain('already open, reused');
    expect(dialog().querySelector('a')!.getAttribute('href')).toBe(url('commerce-core'));
  });

  it('retry is offered when any pull request failed (R13.2)', async () => {
    const { fixture } = await open([opened('commerce-core'), failed('customer-portal', 'gh: HTTP 502 from api.github.com')]);
    expect(text()).toContain('failed');
    expect(text()).toContain('gh: HTTP 502 from api.github.com');
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    expect(button('Retry')).toBeDefined();
    button('Retry')!.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(dialog().querySelectorAll('a').length).toBe(1);
  });

  it('offers Close, not Retry, when every pull request is open', async () => {
    const { fixture } = await open([opened('commerce-core')]);
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    expect(button('Retry')).toBeUndefined();
    button('Close')!.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is closed while there are no results', async () => {
    await open(null);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
